import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import plugin from '../index.mjs'

test('plugin registers every tool and the board combines claims and tasks', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'relay-root-'))
  const workspace = await mkdtemp(join(tmpdir(), 'relay-ws-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  t.after(() => rm(workspace, { recursive: true, force: true }))
  await writeFile(join(workspace, 'note.txt'), 'x')
  await writeFile(
    join(workspace, 'note.txt.dshclaim'),
    JSON.stringify({ path: 'note.txt', tag: 'session-owner', note: 'pilot', lastSeenAt: Date.now() }),
  )

  const tools = new Map()
  const ctx = {
    tools: { register: (tool) => { tools.set(tool.name, tool); return () => {} } },
    effect: (fn) => { fn(); return () => {} },
    on: () => {},
    get: () => null,
  }
  plugin.apply(ctx, { root })
  for (const name of ['task_push', 'task_list', 'task_claim', 'task_renew', 'task_done', 'task_cancel', 'handoff_write', 'handoff_read', 'task_whoami', 'task_board']) {
    assert.ok(tools.has(name), `missing tool ${name}`)
  }

  const exec = { agent: { id: 'session-reader', session: { header: { cwd: workspace } } } }
  await tools.get('task_push').execute({ title: 'backlog item', priority: 'high' }, exec)
  const board = await tools.get('task_board').execute({}, exec)
  assert.match(board, /多会话协作看板/)
  assert.match(board, /session-owner/)
  assert.match(board, /note\.txt/)
  assert.match(board, /backlog item/)
})
