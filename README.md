# dsh-task-relay-lite

Cross-session task queue + handoff notes + a small collaboration board for DeepSeek Harness
**0.2.x** (the original `dsh-task-relay` is pinned to `dsh-tools < 0.2.0`). Zero dependencies,
plain ESM host plugin.

## Tools

| Tool | Purpose |
|---|---|
| `task_push` | add a task (title, description, priority, tags) to the shared queue |
| `task_list` | filter by status/priority/tags/workspace; sort by priority (default) or creation time |
| `task_claim` | claim an open task for this session; `force` only when the current claim is stale |
| `task_renew` | manually refresh this session's claim heartbeats |
| `task_done` | finish a claimed task and record the result |
| `task_cancel` | delete an open task; return your claimed task to open |
| `handoff_write` | write/replace this session's handoff summary |
| `handoff_read` | read handoffs by session or most recent |
| `task_whoami` | session id, cwd, queue path, claimed task count |
| `task_board` | markdown board: file claims (`*.dshclaim` sidecars) + task queue + handoffs |

## Behaviour

- **Priority order**: `urgent > high > normal > low`, then newest first; `task_list(sort:"created")` keeps creation order.
- **Heartbeats**: active agents renew their claimed tasks every `renewMs` (default 60 s); a claim goes
  stale after `staleMs` (default 2 h), and only then can another session `task_claim(force:true)`.
- **Done TTL**: completed tasks older than `doneTtlMs` (default 7 days; `0` disables) are pruned on access.
- **Disposed sessions**: their claimed tasks return to `open` automatically.
- **Storage**: `~/.dsh/task-relay-lite/queue.json` (dir 0700, file 0600, atomic temp+rename writes).
  Writes are serialized inside one host process; separate DSH processes are last-write-wins.

## Config (cordis.patch.yml)

```yaml
- id: dsh-task-relay-lite
  name: dsh-task-relay-lite
  config:
    root: '~/.dsh/task-relay-lite'
    staleMs: 7200000
    renewMs: 60000
    doneTtlMs: 604800000
```

## Install / test

```sh
# from this checkout (development)
dsh plugin --profile desktop add link:<this-repo>

# from GitHub (once the repo is pushed)
dsh plugin --profile desktop add github:Jack-Yang-ai/dsh-task-relay-lite

# from npm (after `npm publish --access public`)
dsh plugin --profile desktop add dsh-task-relay-lite

node --test test/*.test.mjs
```
