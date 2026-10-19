/**
 * dsh-task-relay-lite — browser half.
 *
 * Adds a "协作看板" row to the DSH sidebar (native `sidebar.panellist` slot when the host exposes
 * slots, otherwise a self-healing DOM entry) and renders a read-only board: file claims from
 * dsh-file-claim sidecars, the cross-session task queue, and recent handoff notes. Data comes from
 * the host plugin's loopback-only `/api/dsh-task-relay/board` endpoint every 5 seconds.
 *
 * Bundle format: `window.__ModuleLoader__.load({id, factory})` — the format the web shell loads.
 */
window.__ModuleLoader__.load({
  id: 'dsh-task-relay-lite',
  factory: (require) => {
    const { createElement: h, useEffect, useState } = require('react')

    const API = '/api/dsh-task-relay/board'
    const REFRESH = 5000

    const STYLE = `
.dsh-collab-root { padding: 18px 22px; height: 100%; overflow: auto; font: 13px/1.5 -apple-system, BlinkMacSystemFont, "SF Pro Text", "PingFang SC", sans-serif; color: light-dark(#1d1d1f, #e8e8ed); }
.dsh-collab-head { display: flex; align-items: baseline; gap: 12px; margin-bottom: 14px; }
.dsh-collab-title { font-size: 16px; font-weight: 600; }
.dsh-collab-sub { font-size: 12px; opacity: .6; }
.dsh-collab-grid { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 18px; align-items: start; }
@media (max-width: 900px) { .dsh-collab-grid { grid-template-columns: 1fr; } }
.dsh-collab-col h4 { margin: 0 0 8px; font-size: 13px; opacity: .8; font-weight: 600; }
.dsh-collab-item { padding: 4px 0; border-bottom: 1px solid light-dark(rgba(0,0,0,.06), rgba(255,255,255,.08)); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.dsh-collab-item:last-child { border-bottom: 0; }
.dsh-collab-group { margin-bottom: 10px; }
.dsh-collab-session { font-size: 11px; opacity: .55; font-family: ui-monospace, SFMono-Regular, Menlo, monospace; margin: 4px 0 2px; }
.dsh-collab-path { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 12px; }
.dsh-collab-note { font-size: 11px; opacity: .55; }
.dsh-collab-stale { font-size: 10px; margin-left: 6px; padding: 1px 5px; border-radius: 4px; background: light-dark(#fff4e5, #3a2a12); color: light-dark(#a25a00, #f0b35a); }
.dsh-collab-counts { display: flex; gap: 6px; margin-bottom: 8px; }
.dsh-collab-badge { font-size: 11px; padding: 2px 7px; border-radius: 5px; background: light-dark(rgba(0,0,0,.06), rgba(255,255,255,.09)); }
.dsh-collab-pri { font-size: 10px; padding: 1px 5px; border-radius: 4px; background: light-dark(rgba(0,0,0,.07), rgba(255,255,255,.10)); }
.dsh-collab-pri.urgent { background: light-dark(#fde8e8, #4a1f1f); color: light-dark(#b42318, #ff9b95); }
.dsh-collab-pri.high { background: light-dark(#fff1e0, #402a12); color: light-dark(#a15c00, #f2b45e); }
.dsh-collab-done { margin-top: 10px; opacity: .55; font-size: 12px; }
.dsh-collab-handoff { margin-bottom: 10px; }
.dsh-collab-summary { font-size: 12px; opacity: .8; white-space: pre-wrap; }
.dsh-collab-muted { opacity: .45; font-size: 12px; }
.dsh-collab-entry { display: flex; align-items: center; gap: 8px; width: 100%; padding: 9px 12px; margin: 2px 0; border: 0; border-radius: 8px; background: transparent; color: inherit; font: inherit; cursor: pointer; text-align: left; }
.dsh-collab-entry:hover { background: rgba(128,128,128,.14); }
.dsh-collab-entry[data-active] { background: rgba(128,128,128,.22); }
.dsh-collab-entry .dsh-collab-entry-label { font-size: 13px; line-height: 1.2; opacity: .92; }
.dsh-collab-drawer { position: fixed; top: 0; right: 0; bottom: 0; width: min(720px, 94vw); z-index: 999999; background: light-dark(#ffffff, #171a1f); border-left: 1px solid light-dark(rgba(0,0,0,.08), rgba(255,255,255,.10)); box-shadow: -12px 0 40px rgba(0,0,0,.18); }
.dsh-collab-drawer[hidden] { display: none !important; }
`

    function time(iso) {
      try {
        return new Date(iso).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' })
      } catch {
        return ''
      }
    }

    function Icon({ size = 16 }) {
      return h(
        'svg',
        {
          width: size,
          height: size,
          viewBox: '0 0 24 24',
          fill: 'none',
          stroke: 'currentColor',
          strokeWidth: 1.7,
          strokeLinecap: 'round',
          strokeLinejoin: 'round',
          'aria-hidden': true,
        },
        h('rect', { x: 3.5, y: 4.5, width: 17, height: 15, rx: 2 }),
        h('path', { d: 'M3.5 9.5h17' }),
        h('path', { d: 'M9.5 9.5v10' }),
      )
    }

    function BoardPanel() {
      const [data, setData] = useState(null)
      const [error, setError] = useState('')

      useEffect(() => {
        let alive = true
        let timer
        const load = async () => {
          try {
            const res = await fetch(API, { cache: 'no-store' })
            if (!res.ok) throw new Error('HTTP ' + res.status)
            const next = await res.json()
            if (alive) {
              setData(next)
              setError('')
            }
          } catch (e) {
            if (alive) setError(e && e.message ? e.message : String(e))
          }
        }
        void load()
        timer = setInterval(load, REFRESH)
        return () => {
          alive = false
          clearInterval(timer)
        }
      }, [])

      const claims = data && Array.isArray(data.claims) ? data.claims : []
      const tasks = data && Array.isArray(data.tasks) ? data.tasks : []
      const handoffs = data && Array.isArray(data.handoffs) ? data.handoffs : []
      const counts = (data && data.counts) || { open: 0, claimed: 0, done: 0 }

      const groups = new Map()
      for (const claim of claims) {
        const key = claim.tag || 'unknown'
        if (!groups.has(key)) groups.set(key, [])
        groups.get(key).push(claim)
      }
      const active = tasks.filter((t) => t.status !== 'done').slice(0, 20)
      const done = tasks.filter((t) => t.status === 'done').slice(0, 5)

      const claimColumn = h(
        'div',
        { className: 'dsh-collab-col' },
        h('h4', null, '文件认领（' + claims.length + '）'),
        claims.length === 0
          ? h('div', { className: 'dsh-collab-muted' }, '无')
          : [...groups].map(([session, list]) =>
              h(
                'div',
                { key: session, className: 'dsh-collab-group' },
                h('div', { className: 'dsh-collab-session' }, session),
                list.slice(0, 20).map((c, i) =>
                  h(
                    'div',
                    { key: i, className: 'dsh-collab-item' },
                    h('span', { className: 'dsh-collab-path' }, c.file || c.path || ''),
                    c.note ? h('span', { className: 'dsh-collab-note' }, ' — ' + c.note) : null,
                    c.stale ? h('span', { className: 'dsh-collab-stale' }, 'stale') : null,
                  ),
                ),
              ),
            ),
      )

      const taskColumn = h(
        'div',
        { className: 'dsh-collab-col' },
        h('h4', null, '任务'),
        h(
          'div',
          { className: 'dsh-collab-counts' },
          ['open', 'claimed', 'done'].map((s) => h('span', { key: s, className: 'dsh-collab-badge' }, s + ' ' + (counts[s] || 0))),
        ),
        active.length === 0
          ? h('div', { className: 'dsh-collab-muted' }, '无进行中的任务')
          : active.map((t) =>
              h(
                'div',
                { key: t.id, className: 'dsh-collab-item' },
                h('span', { className: 'dsh-collab-pri ' + (t.priority || '') }, t.priority || '-'),
                ' ' + t.title,
                h('span', { className: 'dsh-collab-note' }, '（' + t.status + (t.claimedBy ? ' · ' + t.claimedBy : '') + '）'),
              ),
            ),
        done.length
          ? h(
              'div',
              { className: 'dsh-collab-done' },
              done.map((t) => h('div', { key: t.id, className: 'dsh-collab-item' }, '✓ ' + t.title + (t.result ? ' — ' + t.result : ''))),
            )
          : null,
      )

      const handoffColumn = h(
        'div',
        { className: 'dsh-collab-col' },
        h('h4', null, '交接'),
        handoffs.length === 0
          ? h('div', { className: 'dsh-collab-muted' }, '无')
          : handoffs.slice(0, 8).map((x, i) =>
              h(
                'div',
                { key: i, className: 'dsh-collab-handoff' },
                h('div', { className: 'dsh-collab-session' }, (x.sessionId || '') + ' · ' + time(x.updatedAt)),
                h('div', { className: 'dsh-collab-summary' }, x.summary || ''),
              ),
            ),
      )

      return h(
        'div',
        { className: 'dsh-collab-root' },
        h(
          'div',
          { className: 'dsh-collab-head' },
          h('div', { className: 'dsh-collab-title' }, '协作看板'),
          h('div', { className: 'dsh-collab-sub' }, error ? '读取失败：' + error : data ? '更新于 ' + time(data.generatedAt) : '加载中…'),
        ),
        h('div', { className: 'dsh-collab-grid' }, claimColumn, taskColumn, handoffColumn),
      )
    }

    function apply(ctx) {
      // The module injects ["slots"], so this runs after the slot service exists. Mirror the
      // dsh-logcat pattern: register the main panel and its sidebar row, and never throw — a thrown
      // client entry aborts the whole web boot ("entry did not activate").
      try {
        const style = document.createElement('style')
        style.textContent = STYLE
        style.dataset.dshCollabStyle = ''
        document.head.appendChild(style)
        if (ctx && ctx.slots && typeof ctx.slots.inject === 'function') {
          ctx.slots.inject('main', () => ctx.slots.register({ name: 'main', key: 'collab' }, () => h(BoardPanel)))
          ctx.slots.inject('sidebar.panellist', () =>
            ctx.slots.register({ name: 'sidebar.panellist', id: 'collab', order: 101, label: '协作看板' }, Icon),
          )
        }
      } catch (error) {
        console.warn('[dsh-task-relay-lite] mount failed:', error)
      }
    }

    return { apply, inject: ['slots'] }
  },
})
