// dsh-task-relay-lite — cross-session task queue + handoff notes + a small collaboration board
// for DeepSeek Harness 0.2.x. Zero dependencies; plain ESM host plugin.
// Storage: ~/.dsh/task-relay-lite/queue.json.
import { mkdir, readFile, readdir, rename, writeFile } from 'node:fs/promises'
import { existsSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'
import { homedir } from 'node:os'

export const PRIORITIES = ['low', 'normal', 'high', 'urgent']
export const PRIORITY_WEIGHT = { low: 0, normal: 1, high: 2, urgent: 3 }
const STATUSES = ['open', 'claimed', 'done']
const STORE_VERSION = 1

export const DEFAULTS = {
  root: join(homedir(), '.dsh', 'task-relay-lite'),
  staleMs: 2 * 60 * 60 * 1000,
  renewMs: 60 * 1000,
  doneTtlMs: 7 * 24 * 60 * 60 * 1000,
}

export function emptyStore() {
  return { version: STORE_VERSION, counter: 0, tasks: {}, order: [], handoffs: {} }
}

export class Store {
  constructor(root, options = {}) {
    this.root = root
    this.file = join(root, 'queue.json')
    this.staleMs = options.staleMs ?? DEFAULTS.staleMs
    this.renewMs = options.renewMs ?? DEFAULTS.renewMs
    this.doneTtlMs = options.doneTtlMs ?? DEFAULTS.doneTtlMs
    this.data = null
    this.chain = Promise.resolve()
    this.loadedMtime = 0
  }

  async init() {
    if (this.data) return
    await mkdir(this.root, { recursive: true, mode: 0o700 })
    if (existsSync(this.file)) await this.load()
    else {
      this.data = emptyStore()
      await this.flush()
    }
  }

  async load() {
    const raw = await readFile(this.file, 'utf8')
    const d = JSON.parse(raw)
    this.data = {
      version: d.version ?? STORE_VERSION,
      counter: Number.isInteger(d.counter) ? d.counter : 0,
      tasks: d.tasks && typeof d.tasks === 'object' ? d.tasks : {},
      order: Array.isArray(d.order) ? d.order : [],
      handoffs: d.handoffs && typeof d.handoffs === 'object' ? d.handoffs : {},
    }
    try { this.loadedMtime = statSync(this.file).mtimeMs } catch {}
  }

  async refresh() {
    if (!this.data) return this.init()
    try {
      const m = statSync(this.file).mtimeMs
      if (m > this.loadedMtime) await this.load()
    } catch {}
  }

  async flush() {
    const tmp = this.file + '.tmp'
    await writeFile(tmp, JSON.stringify(this.data, null, 2), { encoding: 'utf8', mode: 0o600 })
    await rename(tmp, this.file)
    try { this.loadedMtime = statSync(this.file).mtimeMs } catch {}
  }

  // Serialize every access inside this host process; cross-process writes stay last-write-wins.
  async run(fn) {
    const task = async () => {
      await this.init()
      await this.refresh()
      const pruned = this.prune()
      if (pruned) await this.flush()
      return fn(this.data, this)
    }
    const next = this.chain.then(task, task)
    this.chain = next.then(() => undefined, () => undefined)
    return next
  }

  // Drop done tasks older than doneTtlMs (0 disables). Returns true when something was removed.
  prune(now = Date.now()) {
    if (!this.data || this.doneTtlMs <= 0) return false
    let changed = false
    for (const [id, t] of Object.entries(this.data.tasks)) {
      if (t.status === 'done' && t.doneAt) {
        const done = Date.parse(t.doneAt)
        if (Number.isFinite(done) && now - done > this.doneTtlMs) {
          delete this.data.tasks[id]
          changed = true
        }
      }
    }
    if (changed) this.data.order = this.data.order.filter((id) => this.data.tasks[id])
    return changed
  }

  isStale(task, now = Date.now()) {
    if (!task || task.status !== 'claimed') return false
    const seen = Date.parse(task.heartbeatAt || task.claimedAt || '')
    return Number.isFinite(seen) && now - seen > this.staleMs
  }

  view(task, now = Date.now()) {
    return { ...task, stale: this.isStale(task, now) }
  }

  async push({ title, description = '', priority, tags = [], session, workspace }) {
    return this.run(async (data, s) => {
      const id = `T${Date.now()}-${++data.counter}`
      const now = new Date().toISOString()
      const t = {
        id, title, description, priority, tags,
        status: 'open', sourceSession: session, claimedBy: null, claimedAt: null,
        heartbeatAt: null, createdAt: now, doneAt: null, result: null, workspace,
      }
      data.tasks[id] = t
      data.order.unshift(id)
      await s.flush()
      return t
    })
  }

  async list(filter = {}, sort = 'priority') {
    return this.run(async (data, s) => {
      const rows = []
      for (const id of data.order) {
        const t = data.tasks[id]
        if (!t) continue
        if (filter.status && t.status !== filter.status) continue
        if (filter.priority && t.priority !== filter.priority) continue
        if (filter.workspace && t.workspace !== filter.workspace) continue
        if (filter.tags && filter.tags.length && !filter.tags.some((tag) => (t.tags || []).includes(tag))) continue
        rows.push(s.view(t))
      }
      if (sort === 'created') rows.sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)))
      else rows.sort((a, b) => (PRIORITY_WEIGHT[b.priority] - PRIORITY_WEIGHT[a.priority]) || String(b.createdAt).localeCompare(String(a.createdAt)))
      return rows
    })
  }

  async claim(id, session, force = false) {
    return this.run(async (data, s) => {
      const t = data.tasks[id]
      if (!t) throw new Error(`任务不存在：${id}`)
      if (t.status === 'done') throw new Error(`任务已完成：${id}`)
      const now = new Date().toISOString()
      if (t.status === 'claimed' && t.claimedBy !== session) {
        if (!force || !s.isStale(t)) {
          const age = t.heartbeatAt || t.claimedAt
          throw new Error(`任务已被 ${t.claimedBy} 认领${age ? `（最近心跳 ${age}）` : ''}；对方 stale 后可 task_claim(force:true) 接管`)
        }
        t.claimedBy = session
        t.claimedAt = now
        t.heartbeatAt = now
        await s.flush()
        return { task: s.view(t), tookOver: true }
      }
      if (t.status === 'open') {
        t.status = 'claimed'
        t.claimedBy = session
        t.claimedAt = now
        t.heartbeatAt = now
        await s.flush()
        return { task: s.view(t), tookOver: false }
      }
      // Already claimed by this session: renew the heartbeat while we are here.
      t.heartbeatAt = now
      await s.flush()
      return { task: s.view(t), tookOver: false }
    })
  }

  async renew(session) {
    return this.run(async (data, s) => {
      const now = new Date().toISOString()
      let n = 0
      for (const t of Object.values(data.tasks)) {
        if (t.status === 'claimed' && t.claimedBy === session) {
          t.heartbeatAt = now
          n += 1
        }
      }
      if (n) await s.flush()
      return n
    })
  }

  async release(session) {
    return this.run(async (data, s) => {
      let n = 0
      for (const t of Object.values(data.tasks)) {
        if (t.status === 'claimed' && t.claimedBy === session) {
          t.status = 'open'
          t.claimedBy = null
          t.claimedAt = null
          t.heartbeatAt = null
          n += 1
        }
      }
      if (n) await s.flush()
      return n
    })
  }

  async done(id, session, result = '') {
    return this.run(async (data, s) => {
      const t = data.tasks[id]
      if (!t) throw new Error(`任务不存在：${id}`)
      if (t.status !== 'claimed' || t.claimedBy !== session) {
        throw new Error(`只能完成自己认领的任务；${id} 当前状态 ${t.status}${t.claimedBy ? `，认领者 ${t.claimedBy}` : ''}`)
      }
      t.status = 'done'
      t.doneAt = new Date().toISOString()
      t.result = result
      t.heartbeatAt = null
      await s.flush()
      return t
    })
  }

  async cancel(id, session) {
    return this.run(async (data, s) => {
      const t = data.tasks[id]
      if (!t) throw new Error(`任务不存在：${id}`)
      if (t.status === 'done') throw new Error(`任务已完成，不能取消：${id}`)
      if (t.status === 'claimed' && t.claimedBy !== session) throw new Error(`任务已被 ${t.claimedBy} 认领，不能取消`)
      if (t.status === 'open') {
        delete data.tasks[id]
        data.order = data.order.filter((x) => x !== id)
        await s.flush()
        return { deleted: true, id }
      }
      t.status = 'open'
      t.claimedBy = null
      t.claimedAt = null
      t.heartbeatAt = null
      await s.flush()
      return { deleted: false, task: s.view(t) }
    })
  }

  async handoffWrite(session, workspace, summary) {
    return this.run(async (data, s) => {
      const openTasks = Object.values(data.tasks).filter((t) => t.status === 'claimed' && t.claimedBy === session).length
      const entry = { sessionId: session, summary, openTasks, workspace, updatedAt: new Date().toISOString() }
      data.handoffs[session] = entry
      await s.flush()
      return entry
    })
  }

  async handoffRead(session) {
    return this.run(async (data) => {
      const all = Object.values(data.handoffs)
      if (session) return all.filter((h) => h.sessionId === session)
      return all.sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt)))
    })
  }

  async stats() {
    return this.run(async (data) => {
      const counts = { open: 0, claimed: 0, done: 0 }
      for (const t of Object.values(data.tasks)) counts[t.status] = (counts[t.status] || 0) + 1
      return { counts, handoffs: Object.keys(data.handoffs).length }
    })
  }
}

// ---------- helpers ----------

function sessionOf(exec) {
  return exec && exec.agent && typeof exec.agent.id === 'string' ? exec.agent.id : 'unknown'
}
function cwdOf(exec) {
  const h = exec && exec.agent && exec.agent.session && exec.agent.session.header
  return h && typeof h.cwd === 'string' ? h.cwd : process.cwd()
}
function nowISO() { return new Date().toISOString() }
function assertStr(v, max, field) {
  if (typeof v !== 'string' || !v.trim()) throw new Error(`${field} 不能为空`)
  if (v.length > max) throw new Error(`${field} 超过 ${max} 字符`)
  return v
}
function assertPriority(p) {
  if (!PRIORITIES.includes(p)) throw new Error(`priority 必须是 ${PRIORITIES.join(' / ')}`)
  return p
}
function assertTags(tags) {
  if (tags === undefined) return []
  if (!Array.isArray(tags)) throw new Error('tags 必须是字符串数组')
  if (tags.length > 10) throw new Error('tags 最多 10 个')
  return tags.map((t) => {
    if (typeof t !== 'string' || !t.trim()) throw new Error('tag 不能为空')
    if (t.length > 40) throw new Error('单个 tag 最多 40 字符')
    return t.trim()
  })
}

const PROTOCOL_SECTION = `## 跨会话任务接力（dsh-task-relay-lite）

同一台机器上可能有多个 DSH 会话并行工作。需要另一个会话接着做时，用 task_push 把任务
投进共享队列（标题、描述、优先级、标签），接手会话用 task_list 查看、task_claim 认领；
认领后该任务不能再被别人认领，完成时用 task_done 记录结果。会话结束前用 handoff_write
写一段交接摘要（做了什么、还剩什么、卡在哪），接手会话用 handoff_read 读取。
队列在 ~/.dsh/task-relay-lite/queue.json，所有会话共享；认领有 2h 心跳窗口（活跃会话由
宿主定时续租），过期后 task_claim(force:true) 才能接管；done 任务默认 7 天后自动清理。
task_board 会把当前工作区的文件认领（dsh-file-claim 边车）和任务队列合成一张看板。`

function makeTool(name, description, properties, required, run) {
  return {
    name,
    description,
    parameters: { type: 'object', properties, ...(required && required.length ? { required } : {}) },
    output: {
      schema: { type: 'string' },
      render: (_args, value) => [{ type: 'text', text: String(value) }],
    },
    async execute(args, exec) {
      return run(args && typeof args === 'object' ? args : {}, exec)
    },
  }
}

async function scanClaims(root) {
  const claims = []
  const started = Date.now()
  const skip = new Set(['.git', 'node_modules', 'dist', 'build', 'vendor', '.venv', '__pycache__', '.DS_Store'])
  async function walk(dir, depth) {
    if (depth > 6 || claims.length >= 300 || Date.now() - started > 1500) return
    let entries
    try { entries = await readdir(dir, { withFileTypes: true }) } catch { return }
    for (const e of entries) {
      if (claims.length >= 300 || Date.now() - started > 1500) return
      const p = join(dir, e.name)
      if (e.isDirectory()) {
        if (!skip.has(e.name)) await walk(p, depth + 1)
      } else if (e.name.endsWith('.dshclaim')) {
        try {
          const j = JSON.parse(await readFile(p, 'utf8'))
          claims.push({ ...j, file: relative(root, p.slice(0, -'.dshclaim'.length)) })
        } catch {}
      }
    }
  }
  await walk(root, 0)
  return claims
}

function buildTools(store) {
  return [
    makeTool(
      'task_push',
      '把一条任务投进跨会话共享队列（所有会话可见、可认领）。返回任务的完整 JSON。',
      {
        title: { type: 'string', description: '任务标题（最多 200 字符）' },
        description: { type: 'string', description: '任务描述（最多 4000 字符）' },
        priority: { type: 'string', enum: PRIORITIES, description: '优先级' },
        tags: { type: 'array', items: { type: 'string' }, description: '标签（最多 10 个）' },
      },
      ['title', 'priority'],
      async (args, exec) => {
        const title = assertStr(args.title, 200, 'title')
        const description = args.description === undefined ? '' : assertStr(args.description, 4000, 'description')
        const priority = assertPriority(args.priority)
        const tags = assertTags(args.tags)
        const t = await store.push({ title, description, priority, tags, session: sessionOf(exec), workspace: cwdOf(exec) })
        return `已推送任务 ${t.id}\n` + JSON.stringify(store.view(t), null, 2)
      },
    ),
    makeTool(
      'task_list',
      '查看跨会话共享任务队列（状态/优先级/标签/工作区筛选；默认按优先级、再按创建时间倒序）。',
      {
        status: { type: 'string', enum: STATUSES, description: '按状态筛选' },
        priority: { type: 'string', enum: PRIORITIES, description: '按优先级筛选' },
        tags: { type: 'array', items: { type: 'string' }, description: '按标签筛选（任一命中）' },
        workspace: { type: 'string', description: '按工作区路径筛选（精确匹配）' },
        sort: { type: 'string', enum: ['priority', 'created'], description: '排序：priority（默认）或 created' },
        limit: { type: 'integer', description: '最多返回条数（默认 20，最大 100）' },
      },
      [],
      async (args) => {
        const limit = Math.min(Math.max(Number.isInteger(args.limit) ? args.limit : 20, 1), 100)
        const tags = assertTags(args.tags)
        const rows = await store.list({ status: args.status, priority: args.priority, tags, workspace: args.workspace }, args.sort)
        const shown = rows.slice(0, limit)
        return `共 ${rows.length} 条任务，显示 ${shown.length} 条\n` + JSON.stringify(shown, null, 2)
      },
    ),
    makeTool(
      'task_claim',
      '认领一条 open 任务给当前会话；已被其他会话认领时只能在该认领 stale 后 force 接管。',
      {
        id: { type: 'string', description: '任务 ID' },
        force: { type: 'boolean', description: '仅当现有认领已 stale 时强制接管' },
      },
      ['id'],
      async (args, exec) => {
        const r = await store.claim(args.id, sessionOf(exec), Boolean(args.force))
        return (r.tookOver ? `已接管任务 ${args.id}` : `当前会话已持有任务 ${args.id}`) + '\n' + JSON.stringify(r.task, null, 2)
      },
    ),
    makeTool(
      'task_renew',
      '手动为当前会话认领的所有任务续心跳（宿主通常已自动续租，网络/长任务时可手动调用）。',
      {},
      [],
      async (_args, exec) => {
        const n = await store.renew(sessionOf(exec))
        return `已续租 ${n} 条任务（${sessionOf(exec)}）`
      },
    ),
    makeTool(
      'task_done',
      '完成当前会话认领的任务并记录结果。',
      {
        id: { type: 'string', description: '任务 ID' },
        result: { type: 'string', description: '完成结果（最多 4000 字符）' },
      },
      ['id'],
      async (args, exec) => {
        const t = await store.done(args.id, sessionOf(exec), args.result === undefined ? '' : assertStr(args.result, 4000, 'result'))
        return `已完成任务 ${args.id}\n` + JSON.stringify(t, null, 2)
      },
    ),
    makeTool(
      'task_cancel',
      '取消任务：open 直接删除；自己认领的退回 open；已完成的不能取消。',
      { id: { type: 'string', description: '任务 ID' } },
      ['id'],
      async (args, exec) => {
        const out = await store.cancel(args.id, sessionOf(exec))
        return (out.deleted ? `已删除任务 ${args.id}` : `已退回 open：${args.id}`) + '\n' + JSON.stringify(out, null, 2)
      },
    ),
    makeTool(
      'handoff_write',
      '写入/替换当前会话的交接摘要，供后续会话 handoff_read 读取。',
      { summary: { type: 'string', description: '交接摘要（最多 8000 字符）' } },
      ['summary'],
      async (args, exec) => {
        const h = await store.handoffWrite(sessionOf(exec), cwdOf(exec), assertStr(args.summary, 8000, 'summary'))
        return '已写入交接摘要\n' + JSON.stringify(h, null, 2)
      },
    ),
    makeTool(
      'handoff_read',
      '读取交接摘要：指定会话读那一条；不指定则按更新时间倒序返回最近若干条。',
      {
        session: { type: 'string', description: '要读取的会话 ID（可选）' },
        limit: { type: 'integer', description: '不指定会话时最多返回几条（默认 10，最大 50）' },
      },
      [],
      async (args) => {
        const rows = await store.handoffRead(args.session)
        const limit = Math.min(Math.max(Number.isInteger(args.limit) ? args.limit : 10, 1), 50)
        const shown = args.session ? rows : rows.slice(0, limit)
        return `共 ${rows.length} 条交接，显示 ${shown.length} 条\n` + JSON.stringify(shown, null, 2)
      },
    ),
    makeTool(
      'task_whoami',
      '查看当前会话 ID、工作区路径、共享队列位置和本会话认领数（只读）。',
      {},
      [],
      async (_args, exec) => {
        const rows = await store.list({ status: 'claimed' })
        const mine = rows.filter((t) => t.claimedBy === sessionOf(exec)).length
        return JSON.stringify({ session: sessionOf(exec), workspace: cwdOf(exec), queue: store.file, staleMs: store.staleMs, renewMs: store.renewMs, claimedTasks: mine }, null, 2)
      },
    ),
    makeTool(
      'task_board',
      '多会话协作看板：显示当前工作区的文件认领（dsh-file-claim 边车）和跨会话任务队列/交接摘要。',
      {},
      [],
      async (_args, exec) => {
        const workspace = cwdOf(exec)
        const claims = await scanClaims(workspace)
        const tasks = await store.list({})
        const handoffs = await store.handoffRead()
        const counts = { open: 0, claimed: 0, done: 0 }
        for (const t of tasks) counts[t.status] += 1
        const lines = ['## 多会话协作看板', `工作区：${workspace}`, '']
        lines.push(`### 文件认领（${claims.length}）`)
        if (!claims.length) lines.push('- 无')
        else {
          const groups = new Map()
          for (const c of claims) {
            const key = c.tag || 'unknown'
            if (!groups.has(key)) groups.set(key, [])
            groups.get(key).push(c)
          }
          for (const [session, list] of groups) {
            lines.push(`- ${session}（${list.length} 个）`)
            for (const c of list.slice(0, 20)) lines.push(`  - ${c.file}${c.note ? ` — ${c.note}` : ''}${c.lastSeenAt && Date.now() - c.lastSeenAt > store.staleMs ? '（stale）' : ''}`)
          }
        }
        lines.push('', `### 任务（open ${counts.open} / claimed ${counts.claimed} / done ${counts.done}）`)
        const active = tasks.filter((t) => t.status !== 'done').slice(0, 10)
        if (!active.length) lines.push('- 无进行中的任务')
        for (const t of active) lines.push(`- [${t.priority}] ${t.id} ${t.title}（${t.status}${t.claimedBy ? ` · ${t.claimedBy}` : ''}）`)
        const recentDone = tasks.filter((t) => t.status === 'done').slice(0, 3)
        for (const t of recentDone) lines.push(`- [done] ${t.id} ${t.title}${t.result ? ` — ${t.result}` : ''}`)
        lines.push('', `### 交接（最近 ${Math.min(handoffs.length, 5)} 条）`)
        if (!handoffs.length) lines.push('- 无')
        for (const h of handoffs.slice(0, 5)) lines.push(`- ${h.sessionId} · ${h.updatedAt}：${String(h.summary).replace(/\s+/g, ' ').slice(0, 160)}`)
        lines.push('', `队列：${store.file}；认领 stale 阈值 ${Math.round(store.staleMs / 60000)} 分钟。`)
        return lines.join('\n')
      },
    ),
  ]
}

const plugin = {
  name: 'dsh-task-relay-lite',
  inject: ['tools'],
  apply(ctx, config = {}) {
    const rawRoot = config && typeof config.root === 'string' && config.root ? config.root : DEFAULTS.root
    const root = rawRoot.startsWith('~/') ? join(homedir(), rawRoot.slice(2)) : rawRoot
    const staleMs = Number.isFinite(config.staleMs) ? Number(config.staleMs) : DEFAULTS.staleMs
    const renewMs = Number.isFinite(config.renewMs) ? Number(config.renewMs) : DEFAULTS.renewMs
    const doneTtlMs = Number.isFinite(config.doneTtlMs) ? Number(config.doneTtlMs) : DEFAULTS.doneTtlMs
    const store = new Store(root, { staleMs, renewMs, doneTtlMs })

    for (const tool of buildTools(store)) {
      ctx.effect(() => ctx.tools.register(tool))
    }

    // A disposed session must not leave tasks claimed forever: return them to open.
    ctx.on('agent/disposed', ({ agent }) => {
      const session = agent && typeof agent.id === 'string' ? agent.id : null
      if (session) void store.release(session).catch(() => {})
    })

    // Heartbeat: active agents renew their claimed tasks, so long-running work does not go stale.
    const timer = ctx.get('timer')
    if (timer && typeof timer.interval === 'function') {
      ctx.effect(() => timer.interval(async () => {
        try {
          const agents = ctx.get('agents')
          const list = agents && typeof agents.list === 'function' ? agents.list() : []
          for (const a of list) if (a && typeof a.id === 'string') await store.renew(a.id)
        } catch {}
      }, renewMs))
    }

    const systemPrompt = ctx.get('systemPrompt')
    if (systemPrompt && typeof systemPrompt.section === 'function') {
      ctx.effect(() => systemPrompt.section({ name: 'dsh-task-relay-lite-protocol', order: 130, text: PROTOCOL_SECTION }))
    }
  },
}

export default plugin
