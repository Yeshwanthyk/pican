# Perf: memory, CPU, and base-layer improvements

Status: Phases 1–4 implemented 2026-07-24. Phase 5 is held because the Phase 1–4 remeasurement met the memory/idle-CPU targets; Phase 6 remains evidence-driven. Baseline measured 2026-07-24 against the live server (`./pican -runtime=pi,codex,claude`, pid uptime ~3 days).

## Baseline evidence (treat as ground truth)

Measured with `/api/debug/pprof/heap` + 15s CPU profile on the running binary, plus lsof, plus four code audits:

- RSS ~1 GB. Go heap 429 MB live; **349 MB (81%) retained under `internal/claude.parseTranscript`** via `Watcher.run → Catalog.RefreshPath`. GOGC=100 doubles the live heap → ~1 GB RSS.
- 667 CPU-minutes over ~3 days (~15% of a core sustained). Idle CPU is only ~2.5%; the burn is recurring background work.
- 3,490 open FDs: 2,734 files + 453 dirs under `~/.pi`, 173 files + 100 dirs under `~/.claude/projects` (kqueue fsnotify = 1 FD per watched path).
- Data scale: `~/.pi` 5.1 GB / ~2,200 JSONL; `~/.claude/projects` 831 MB / 1,186 transcripts; `~/.codex/sessions` 5.9 GB / 4,320 threads.

### Root causes

1. **60 s unconditional full-corpus catalog resync** for Claude and Codex (`internal/app/app.go:68,74`; ticker in `internal/app/runtime.go:384-405`).
   - Claude (`internal/claude/catalog.go:47-147`): walks `~/.claude/projects` twice per tick, `ParseTranscript` (full read + per-line unmarshal, retains a `Raw` copy of every line — `internal/claude/transcript.go:74-253`) on **all** transcripts, then `Materialize` per session. All parsed transcripts held simultaneously in a local map during the cycle → the permanent ~350 MB heap plateau.
   - Codex (`internal/codex/catalog.go:23-76`): `ListThreads` drains all pages (no `since`; `internal/codex/rpc.go:27-66`), then for every non-archived thread `ReadThread{includeTurns:true}` + `Materialize` — ~4 full-file passes each (`readLocalEntriesFrom` `internal/projections/store.go:431-461`, `readCapturedToolTurns` `internal/codex/projection.go:270-331`, `ReadProjectionMetadata` `internal/codex/projection.go:40-103` (no early exit), and `WriteJSONLAtomic`'s full `os.ReadFile` byte-compare `internal/projections/store.go:488-541`).
   - Combined ≈ 2.5–2.8 GB of parse/scan/compare work per minute, forever. Redundant with the fsnotify path (`internal/claude/watcher.go:119-141`), which is already correct.
   - Key unlock: Codex `thread/list` already returns `UpdatedAt` per thread, parsed into `internal/codex/types.go:24` and **ignored**. No protocol change needed.
2. **Unbounded conversation cache**: `sessions.Cache.sessionCache` (`internal/sessions/cache.go:38`) retains the fully parsed `Session` (`Entries []map[string]any`, ~3–6× raw JSONL size) for every session ever resolved — no LRU/TTL; only evicted by targeted `Invalidate(id)` (`cache.go:309-323`, called from `internal/server/runtime.go:437,457`). ~7–14 MB pinned per opened session, forever. API pagination trims only the HTTP response, not the cache.
3. **Uncached full reparse as the common read path**: `sessions.ResolveByID` (`internal/sessions/lookup.go`) does a full dir walk + `ParseFile` with no caching, and is called from ~25 sites across `internal/server/{chat,chat_queue,chat_queue_drainer,handlers,git,share,btw,scheduler,extension_ui,new_session,auto_title,runtime}.go` and `internal/app/runtime.go:428`. Worst: `readSessionStatus` (`internal/server/chat.go:96-123`) full-parses the session just to read the `Runtime` field, per 1 s sweeper tick (`internal/server/status_sweeper.go:18-29`) and per debounced fsnotify append (~50 ms while streaming). `Cache.Resolve` (mtime-gated, incremental via `internal/sessions/incremental.go`) exists but is barely wired.
4. **Worker lifecycle leaks**:
   - Crashed workers never reaped: `reapOnce` skips non-`WorkerStateIdle` (`internal/workers/manager.go:169-171`); error-state workers evicted only lazily on next send to the same session (`manager.go:379-388`).
   - pi worker stderr is an uncapped `strings.Builder` (`internal/rpc/worker.go:34,105-106`); claude/codex cap theirs at 64 KB.
   - Codex `Worker` retains the full `Thread` and deep-clones it (incl. all `Raw` payloads) on essentially every notification (`internal/codex/worker.go:44,793,871,901,970-987`) — O(conversation size) per streamed delta.
   - Codex `preview` map entries leak on aborted/errored turns (`internal/codex/worker.go:44,881`; no cleanup in `Abort()`/`protocolError()`).
   - `bufio.Scanner` buffers never shrink: 10 MB cap pi (`internal/rpc/worker.go:482-483`), 32 MB claude (`internal/claude/worker.go:473-474`), 32 MB codex (`internal/codex/client.go:144-145`) — high-water pinned until worker close.
5. Minor: untruncated `firstUserText` duplicated per summary cache entry (`internal/sessions/session.go:301`); `Server.fileMod` map never pruned (`internal/server/server.go:106`); claude watcher directory events escalate to full-fleet `Sync` (`internal/claude/watcher.go:96-133`); no incremental tail-parse for Claude transcripts (unlike pi's `incremental.go`).

## Design reference: Litter (GPLv3 — patterns only, NEVER copy code; pican is MIT)

Litter (dnakov/litter) is a native mobile Codex client speaking the same app-server protocol. Its source is not vendored in this repository; if it must be inspected again, clone it outside pican (for example, `/tmp/litter`). Patterns to emulate:

- **View-triggered listing + event-driven freshness; no polling ticker.** Cursor-paginated `thread/list` on UI demand only; notifications applied as targeted upserts/removals; membership pruned by id-set diff, not stat sweeps.
- **Windowed hydration**: `thread/resume` with `exclude_turns: true` + small probe, then `thread/turns/list` pages on demand ("pulling the entire embedded turn archive would OOM mobile clients on long threads"). pican always uses `thread/read{includeTurns:true}`.
- **Capability negotiation**: semver parsed from the `initialize` handshake `user_agent`, runtime downgrade on `-32601` — prerequisite for adopting windowed reads safely across Codex versions.
- **Targeted mutations over deep clones**: streaming deltas mutate retained state and emit patches; never clone the whole thread per event.
- **Bounded lifecycle**: process pool (max 16, 600 s idle TTL, LRU eviction); two-phase reaping (cancel pending after 60 s grace, drop after TTL); replay ring with dual count+byte caps.
- **Incremental index hydration**: merge only unseen thread ids into a persisted index; atomic tmp-rename writes.

## Phases

Each phase is independently landable. `make check` must pass per phase. Confirm before changing public APIs/schemas or deleting >50 lines (user contract).

### Phase 1 — Worker lifecycle correctness (S) — implemented

1. `internal/workers/manager.go` `reapOnce`: evict `WorkerStateError` workers unconditionally (no TTL wait), keeping the existing `pendingSends > 0` guard. Makes AGENTS.md's "evict crashed workers" true.
2. Add a small bounded-writer primitive in `internal/workers` (e.g. `BoundedWriter{Max int}`, ring/tail-truncate semantics like `internal/claude/worker.go:1009-1017`); migrate pi stderr capture (`internal/rpc/worker.go:34,105-106`) to it, 64 KB cap.
3. Clear codex `preview` map entries on `Abort()` and `protocolError()` (`internal/codex/worker.go`).
Tests: manager reap test for error-state eviction; worker stderr cap test.

### Phase 2 — Event-first catalog sync, list-then-gate (M) — implemented

1. **Codex** (`internal/codex/catalog.go`): keep the periodic `thread/list` (cheap), retain `map[nativeThreadID]updatedAt` across ticks, and call `ReadThread`+`Materialize` **only** for new/changed threads. Replace the mtime-grace pruning heuristic (`catalog.go:57-70`) with an id-set diff from the list response. Restart = one full pass (same as today), acceptable.
2. **Claude**: demote the 60 s ticker (`internal/app/app.go:74`) to a 5–10 min reconcile; inside `Sync`, gate per-file on `(mtime,size)` so unchanged transcripts skip `ParseTranscript` + `Materialize`. fsnotify (`internal/claude/watcher.go`) remains the primary freshness path. Drop the second `scanPaths()` membership pass if it falls out naturally.
3. **Shared store**: replace `WriteJSONLAtomic`'s full read + `bytes.Equal` change detection (`internal/projections/store.go:488-541`) with a stat/size+hash cache; cache the last-materialized projection per worker keyed by the revision the worker already tracks (`w.revision`) to collapse `Materialize`'s multi-pass reads on the 100 ms debounced path.
4. No changes to `runtimes.CatalogAdapter`/`Registration` contracts — this lands as adapter/scheduling internals.
Docs: update `docs/architecture/codex-runtime.md`, `claude-runtime.md`, `data-flow.md` ("every minute" full-sync language → "cheap list + gated read; slow reconcile").
Tests: catalog sync skips unchanged (mtime/UpdatedAt fixtures); reconcile still picks up out-of-band changes.

### Phase 3 — One cached read path (M) — implemented with Phase 4

Route the ~25 `sessions.ResolveByID` call sites through `s.cache.Resolve(...)`. Keep `ResolveByID` only where no `*Cache` is reachable. **Pre-flight audit**: verify no caller mutates `resolved.Session.Entries`/`Header` in place (cached backing slice is shared). `readSessionStatus` should end up reading `Runtime` via the summary/cache path — no full parse.
Docs: `data-flow.md` "Cache Strategy" — `Cache.Resolve` is canonical.

### Phase 4 — Byte-budgeted LRU on sessionCache (M) — implemented with Phase 3

`internal/sessions/cache.go`: bound `sessionCache` with `container/list` + map LRU, evicted by approximate byte budget (sum of entry sizes; sessions vary 10×, so count caps don't bound memory). Default ~200 MB, constructor option for tests/tuning. Also evict entries whose files disappear (today only `entries` is pruned in `LoadAll`). Surface existing hit/parse counters via `/api/metrics`. Do NOT build a generic cache abstraction across summaries/projections — `sessionCache` is the only unbounded structure.
Tests: eviction under budget pressure; reparse-on-evicted-access.

### Phase 5 — Windowed Codex hydration + delta patches (M–L) — held

1. Capability negotiation à la litter: parse server version from `initialize` user-agent in `internal/codex/client.go`; gate features; downgrade on `-32601`.
2. Use `exclude_turns` on resume/read and `thread/turns/list` cursor pages instead of full `thread/read{includeTurns:true}` per open and per notification reconcile (`internal/codex/worker.go:816,916`, `internal/codex/rpc.go:68-74`).
3. Remove `cloneThread` whole-thread deep copy per delta (`internal/codex/worker.go:970-987`): mutate retained state in place, emit only the changed turn/item.
Confirm with user before changing any user-visible API shape for windowed session fetches.

### Phase 6 — Only if remeasurement demands it

- Sparse line-offset index built during the incremental scan so pagination can seek pages without holding full `Entries` resident.
- Incremental tail-parse for Claude transcripts in the watcher path (mirror `internal/sessions/incremental.go`).
- Per-directory instead of per-file watches in `internal/server/watcher.go` to cut ~3,500 kqueue FDs (also de-risks silent fallback to the 1.5 s polling path when FD limits are hit).
- Truncate `firstUserText` at fold time (`internal/sessions/session.go:301`); prune `Server.fileMod`.

## Phase 1–4 remeasurement (2026-07-24)

Measured with the production `make build` binary, all three runtimes enabled, an isolated pican state/SQLite root, and the real session corpus. The existing live pican process was not restarted.

- In-use heap fell from **461.5 MB to 39.7 MB**. The pre-change profile retained 351.9 MB below `internal/claude.parseTranscript`; that frame is absent from the post-change top allocation paths.
- Post-change RSS was **40.8 MB before heap capture** and 29.3 MB after the profiling GC, below the 200 MB target.
- Idle CPU sampled **80 ms over 15 seconds (0.53%)**, with no catalog or transcript parser among the dominant frames.
- Open descriptors fell from 2,914 regular files + 557 directories to 2,345 regular files + 407 directories. The remaining watcher footprint is intentionally deferred to Phase 6 because it no longer drives the memory/CPU target.
- `/api/metrics` reported 2,159 summary parses, 6 full-session parses, 5 full-session hits, and one retained parsed session using about 0.7 MB. The 200 MB byte budget and eviction/reparse behavior are covered by focused tests.

One measurement caveat: the isolated process's initial Codex catalog attempt hit the existing 15-second startup deadline while the live pican instance remained active, so Codex reported unavailable in that measurement process. Codex list gating, changed-thread hydration, and missing-projection recovery are covered by catalog integration tests; no Phase 5 wire changes were made.

## Verification protocol (run before Phase 1 and after each phase)

Against a locally running build (`make build`, run with all three runtimes):

```bash
curl -s -o /tmp/heap.pb.gz http://127.0.0.1:<port>/api/debug/pprof/heap
go tool pprof -top -inuse_space -nodecount=15 ./pican /tmp/heap.pb.gz
curl -s -o /tmp/cpu.pb.gz "http://127.0.0.1:<port>/api/debug/pprof/profile?seconds=60"
go tool pprof -top -nodecount=15 ./pican /tmp/cpu.pb.gz
lsof -p <pid> | awk '{print $5}' | sort | uniq -c | sort -rn   # FD counts
ps -o rss= -p <pid>
```

Success criteria after Phases 1–4: no `parseTranscript`/catalog-sync frames dominating inuse_space; sustained CPU near zero when idle; RSS < 200 MB with realistic browsing; RSS plateaus (does not grow with distinct sessions opened).

## Constraints

- Session files are append-only for `session_info`; conversation entries come from the `pi --mode rpc` worker. Live app vs static export separation must hold.
- Keep the multi-runtime registry contracts (`internal/runtimes/registry.go`) unchanged.
- Litter is GPLv3: design reference only, no code copying or vendoring. Clone it outside this repository (for example, `/tmp/litter`) if fresh inspection is required.
- TypeScript rules don't apply here (Go), but: no scope creep beyond the phase being implemented.
