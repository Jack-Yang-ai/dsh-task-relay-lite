import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Store } from '../index.mjs'

async function fresh(options = {}) {
  const dir = await mkdtemp(join(tmpdir(), 'relay-test-'))
  const store = new Store(dir, { staleMs: 1000, doneTtlMs: 0, ...options })
  await store.init()
  return { dir, store }
}

test('task_list sorts by priority, then creation time', async (t) => {
  const { dir, store } = await fresh()
  t.after(() => rm(dir, { recursive: true, force: true }))
  for (const priority of ['low', 'normal', 'high', 'urgent']) {
    await store.push({ title: priority, priority, session: 'A', workspace: '/w' })
  }
  const rows = await store.list()
  assert.deepEqual(rows.map((r) => r.priority), ['urgent', 'high', 'normal', 'low'])
  const byCreated = await store.list({}, 'created')
  assert.deepEqual(byCreated.map((r) => r.priority), ['urgent', 'high', 'normal', 'low'])
})

test('claim enforces ownership and only takes over a stale claim', async (t) => {
  const { dir, store } = await fresh()
  t.after(() => rm(dir, { recursive: true, force: true }))
  const task = await store.push({ title: 'claim me', priority: 'high', session: 'A', workspace: '/w' })
  const first = await store.claim(task.id, 'A')
  assert.equal(first.task.status, 'claimed')
  assert.equal(first.task.claimedBy, 'A')

  await assert.rejects(() => store.claim(task.id, 'B'), /已被 A 认领/)
  await assert.rejects(() => store.claim(task.id, 'B', true), /stale/)

  await store.run(async (data, s) => {
    data.tasks[task.id].heartbeatAt = new Date(Date.now() - 5000).toISOString()
    await s.flush()
  })
  const takeover = await store.claim(task.id, 'B', true)
  assert.equal(takeover.tookOver, true)
  assert.equal(takeover.task.claimedBy, 'B')

  await assert.rejects(() => store.done(task.id, 'A', 'nope'), /只能完成自己认领/)
  const done = await store.done(task.id, 'B', 'ok')
  assert.equal(done.status, 'done')
  assert.equal(done.result, 'ok')
  await assert.rejects(() => store.cancel(task.id, 'B'), /已完成/)
})

test('cancel deletes open tasks and returns claimed ones to open', async (t) => {
  const { dir, store } = await fresh()
  t.after(() => rm(dir, { recursive: true, force: true }))
  const open = await store.push({ title: 'open', priority: 'normal', session: 'A', workspace: '/w' })
  assert.equal((await store.cancel(open.id, 'A')).deleted, true)
  await assert.rejects(() => store.claim(open.id, 'A'), /不存在/)

  const claimed = await store.push({ title: 'claimed', priority: 'normal', session: 'A', workspace: '/w' })
  await store.claim(claimed.id, 'A')
  const returned = await store.cancel(claimed.id, 'A')
  assert.equal(returned.deleted, false)
  assert.equal(returned.task.status, 'open')
  assert.equal(returned.task.claimedBy, null)
})

test('renew refreshes the heartbeat and clears staleness', async (t) => {
  const { dir, store } = await fresh({ staleMs: 1000 })
  t.after(() => rm(dir, { recursive: true, force: true }))
  const task = await store.push({ title: 'renew', priority: 'low', session: 'A', workspace: '/w' })
  await store.claim(task.id, 'A')
  await store.run(async (data, s) => {
    data.tasks[task.id].heartbeatAt = new Date(Date.now() - 5000).toISOString()
    await s.flush()
  })
  assert.equal((await store.list({ status: 'claimed' }))[0].stale, true)
  assert.equal(await store.renew('A'), 1)
  assert.equal((await store.list({ status: 'claimed' }))[0].stale, false)
})

test('done tasks expire after doneTtlMs', async (t) => {
  const { dir, store } = await fresh({ doneTtlMs: 50 })
  t.after(() => rm(dir, { recursive: true, force: true }))
  const task = await store.push({ title: 'old', priority: 'normal', session: 'A', workspace: '/w' })
  await store.claim(task.id, 'A')
  await store.done(task.id, 'A', 'done')
  await store.run(async (data, s) => {
    data.tasks[task.id].doneAt = new Date(Date.now() - 5000).toISOString()
    await s.flush()
  })
  assert.deepEqual(await store.list(), [])
})

test('handoff write/read round-trips and counts open claims', async (t) => {
  const { dir, store } = await fresh()
  t.after(() => rm(dir, { recursive: true, force: true }))
  const task = await store.push({ title: 'handoff', priority: 'normal', session: 'A', workspace: '/w' })
  await store.claim(task.id, 'A')
  const entry = await store.handoffWrite('A', '/w', 'did the thing')
  assert.equal(entry.openTasks, 1)
  const rows = await store.handoffRead('A')
  assert.equal(rows.length, 1)
  assert.equal(rows[0].summary, 'did the thing')
  assert.equal((await store.handoffRead('B')).length, 0)
})

test('queue file and directory are private', async (t) => {
  const { dir, store } = await fresh()
  t.after(() => rm(dir, { recursive: true, force: true }))
  await store.push({ title: 'mode', priority: 'normal', session: 'A', workspace: '/w' })
  const file = await stat(store.file)
  const folder = await stat(dir)
  assert.equal(file.mode & 0o777, 0o600)
  assert.equal(folder.mode & 0o777, 0o700)
})
