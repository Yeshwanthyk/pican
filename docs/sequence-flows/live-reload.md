# Sequence Flow: Live Reload

pican pushes real-time updates to the browser via **Server-Sent Events (SSE)**. This document covers both the file-watching → SSE path and the status-tracking → SSE path.

## Overview

There are five cooperating live-update mechanisms:

1. **File Change Reload** — when an append-only transcript is appended or a replaceable projection is atomically replaced, the session page fetches `/api/session`, reconciles canonical entries according to `projectionMode`, and refreshes its title
2. **Claude native watcher/worker convergence** — changes under configured `<claude-home>/projects` are debounced, parsed from read-only stable snapshots, and atomically projected; a live worker also retries result-time refresh until the matching native message is authoritative
3. **Worker-driven reload** — Codex worker callbacks can emit reload immediately after projection materialization
4. **OpenCode shared event stream** — one native global SSE connection is demultiplexed by canonical directory/session ID, followed by native read and projection replacement
5. **Running Status Updates** — when a session starts/stops running, the index page updates card badges in real time

## 1. File Change Reload

### Sequence Diagram

```
┌─────────┐   ┌──────────┐   ┌─────────────┐   ┌────────────┐   ┌─────────┐
│ Editor  │   │  fsnotify │   │  debouncer  │   │   Server   │   │ Browser │
│         │   │  watcher  │   │             │   │            │   │         │
└────┬────┘   └────┬─────┘   └──────┬──────┘   └─────┬──────┘   └────┬────┘
     │             │                │                │               │
     │ saves file  │                │                │               │
     │────────────▶│                │                │               │
     │             │                │                │               │
     │             │ Write event    │                │               │
     │             │────────────────▶                │               │
     │             │                │                │               │
     │             │                │ schedule(path) │               │
     │             │                │─── 50ms timer ─▶                │
     │             │                │                │               │
     │ [more saves]│                │                │               │
     │────────────▶│ Write event    │                │               │
     │             │────────────────▶                │               │
     │             │                │ reset timer    │               │
     │             │                │                │               │
     │             │                │─── timer fires ─▶               │
     │             │                │                │               │
     │             │                │                │ recordModTime │
     │             │                │                │               │
     │             │                │                │─── update fileMod map
     │             │                │                │─── broadcast(sessID, "reload")
     │             │                │                │─── broadcast(__all__, "reload:"+sessID)
     │             │                │                │               │
     │             │                │                │─── recomputeAndBroadcastStatus
     │             │                │                │               │
     │             │                │                │               │
     │             │                │                │   SSE: reload │
     │             │                │                │───────────────▶
     │             │                │                │               │
     │             │                │                │               │─── fetch /api/session
     │             │                │                │               │─── update document/header title from data.name
     │             │                │                │               │─── append/upsert canonical entries
     │             │                │                │               │
```

### fsnotify Path

At startup, `watchFilesFsnotify()`:

1. Creates an `fsnotify.Watcher`
2. Watches `sessionsDir`
3. Watches each existing project subdir
4. Spawns a goroutine to consume events

On `Create` events:
- If it's a new directory → add to watcher
- If it's a `.jsonl` file → broadcast `new-session` to `__all__`

On `Write`, `Create`, or `Rename` events for `.jsonl` files:
- Schedule debounce (50ms)

`Create`/`Rename` matter because replaceable Codex/Claude/OpenCode projections are atomically renamed over their prior files rather than appended. New files also broadcast `new-session`.

### Debouncer

```go
type debouncer struct {
    delay  time.Duration   // 50ms
    timers map[string]*time.Timer
}

func (d *debouncer) schedule(path string) {
    // Reset existing timer or create new one
    // After delay: send path to wakeCh
}
```

The debouncer prevents multiple reloads when editors write files in chunks (e.g., atomic saves).

### Claude native path

Claude has a second watcher because its authoritative files live outside `sessionsDir`. It watches the configured home, `projects`, and direct project directories. A 100 ms debounce coalesces append bursts. Create/write refreshes only the affected transcript and can never prune. Remove/rename or directory changes request a full catalog scan; pruning occurs only if every native directory and transcript snapshot is complete. A ten-minute reconcile is the recovery path for missed events or watcher startup failure, and unchanged `(mtime,size)` transcripts with existing projections skip parsing and materialization. The adapter never writes beneath the Claude home.

### OpenCode native path

OpenCode events arrive through one authenticated `/global/event` subscription
owned by the supervised child generation. pican validates the canonical
directory and native session ID before routing an event. Message, part, and
status updates refresh only the affected native session and atomically replace
its projection. A child/SSE failure marks only OpenCode unavailable; bounded
restart assigns a new port and credential, then list/read reconciliation
completes before availability returns.

### Polling Fallback

If `fsnotify` fails to initialize (e.g., on NFS or some container environments), the server falls back to polling:

```go
func (s *Server) watchFilesPolling() {
    ticker := time.NewTicker(1500 * time.Millisecond)
    for range ticker.C {
        s.scanForChanges()
    }
}
```

Polling scans all `.jsonl` files and compares modtimes against `fileMod` map.

## 2. Running Status Updates

### Sequence Diagram

```
┌─────────────┐   ┌────────────────┐   ┌──────────────┐   ┌─────────┐   ┌─────────┐
│ Terminal pi │   │ session-status │   │ status watcher│   │ Server  │   │ Browser │
│  (writing)  │   │    directory   │   │  (fsnotify)   │   │         │   │ (index) │
└──────┬──────┘   └───────┬────────┘   └───────┬───────┘   └────┬────┘   └────┬────┘
       │                  │                    │                │             │
       │ writes status    │                    │                │             │
       │─────────────────▶│                    │                │             │
       │                  │                    │                │             │
       │                  │ Create/Write/Rename event │                │             │
       │                  │───────────────────▶│                │             │
       │                  │                    │                │             │
       │                  │                    │─── recomputeAndBroadcastStatus
       │                  │                    │                │             │
       │                  │                    │                │ computeRunningStatus
       │                  │                    │                │             │
       │                  │                    │                │─── readSessionStatus
       │                  │                    │                │─── chatSender.Status
       │                  │                    │                │─── hasRecentSessionActivity
       │                  │                    │                │             │
       │                  │                    │                │─── if changed:
       │                  │                    │                │     update lastKnown
       │                  │                    │                │     broadcast to __all__
       │                  │                    │                │             │
       │                  │                    │                │   SSE: status-delta
       │                  │                    │                │─────────────▶
       │                  │                    │                │             │
       │                  │                    │                │             │─── applyDelta()
       │                  │                    │                │             │─── toggle CSS class
       │                  │                    │                │             │
```

### Three Signals for "Running"

`computeRunningStatus(sessionID)` returns true if **any** of these are true:

1. **session-status file** exists and is fresh/running (Pi only; ignored for replaceable projections)
2. **Runtime worker** status is `running` (Pi, Codex, Claude, or OpenCode)
3. **Recent transcript/projection activity** is within the short grace window

### Status Sweeper

A background ticker runs every second:

```go
func (s *Server) runStatusSweeper(stop <-chan struct{}, interval time.Duration) {
    for {
        select {
        case <-ticker:
            s.sweepStatusOnce()  // recompute all known running sessions
        case <-stop:
            return
        }
    }
}
```

This catches cases where a signal goes stale (e.g., terminal process crashes without cleaning up its status file).

### SSE Event Types

| Event | Topic | Payload | Trigger |
|-------|-------|---------|---------|
| `reload` | `sessID` | `"reload"` | Session file modified |
| `reload` | `__all__` | `"reload:<sessID>"` | Session file modified (index-wide echo, carries the touched id so the index page can skip refetching unrelated/already-known sessions) |
| `new-session` | `__all__` | `"new-session"` | New `.jsonl` file created |
| `status-snapshot` | `__all__` | `{"running": ["id1", "id2"]}` | Client connects to `/events?id=__all__` |
| `status-delta` | `__all__` | `{"id": "abc", "running": true}` | Running status changes |
| `chat-preview` | `sessID` | `{"content": "...", "done": false}` | Best-effort runtime preview before authoritative transcript/projection convergence |

### Browser Handling

**Index page** (`/events?id=__all__`):
```js
es.addEventListener('status-snapshot', (e) => this.applySnapshot(e.data))
es.addEventListener('status-delta', (e) => this.applyDelta(e.data))
es.onmessage = (e) => {
  if (e.data === 'new-session') return refetchSessions()
  const reload = parseReload(e.data) // matches "reload:<id>" (or bare "reload")
  if (reload && shouldRefetchOnReload({ id: reload.id, knownIds, lastRefreshAt, now: Date.now(), throttleMs: 5000 })) {
    refetchSessions()
  }
}
```
Known session ids are always throttled to at most one refetch per 5s; an unknown/empty id (new session, or a legacy bare `"reload"`) always refetches immediately.

**Session page** (`/events?id=<sessID>`):
```js
es.onmessage = (e) => {
  if (e.data !== 'reload') return
  fetch('/api/session?id=' + encodeURIComponent(sessId))
    .then((r) => r.json())
    .then((data) => {
      if (data.name) updateTitle(data.name)
      clearChatPreview()
      // projectionMode append-only-native: append delta/reuse same-ID entries
      // projectionMode replaceable-projection: full snapshot/replace same-ID entries
    })
}
es.addEventListener('chat-preview', (e) => renderChatPreview(JSON.parse(e.data)))
```

Both `/api/session` and the embedded first-paint bootstrap include additive `projectionMode`. The browser sends `afterCount` only when the current model is untruncated and explicitly `append-only-native`. A replaceable or unknown mode requests a full snapshot. During that full reconcile, fresh objects replace existing objects with the same ID because canonical tool output/status may evolve under stable native IDs. Append-only sessions continue reusing known entry objects. The server independently applies the same projection-mode policy to `afterCount`, so a stale or malformed client request still falls back safely to a full snapshot. Claude assistant projections also expose `claudeMessageId`; when it matches the active preview item, the browser removes that preview even if the worker is still finishing result-time convergence, preventing canonical/preview duplication during watcher races.

---

**E2E coverage:** `e2e/tests/live-reload.spec.ts` appends to a session file on disk and asserts the change surfaces in the browser via SSE. See [docs/dev/e2e-testing.md](../dev/e2e-testing.md).
