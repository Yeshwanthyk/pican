# Data Flow & Session File Format

## Session Storage and Authority

The session pipeline reads JSONL from `~/.pi/agent/sessions`, but the ownership model depends on `runtime`:

- **Pi:** the JSONL file is the native, append-only transcript. Pi supplies conversation entries; pican only creates new files and appends supported local metadata.
- **Codex:** `~/.codex` is authoritative. pican lists/reads threads through app-server and atomically materializes rebuildable `codex-<thread-id>.jsonl` projections under the matching encoded project directory. Projection refresh preserves local `session_info`, label, model-change, and thinking-level metadata.
- **Claude:** configured `<claude-home>/projects/*/*.jsonl` files are authoritative and strictly read-only. pican consumes complete records from stable snapshots and atomically materializes `claude-<session-id>.jsonl`; partial scans refresh valid prefixes but never prune.
- **OpenCode:** the supervised OpenCode service's native session/message store is authoritative. pican reads it through authenticated loopback HTTP, follows one global native event stream, and atomically materializes `opencode-<session-id>.jsonl`; failed or partial reconciliation never prunes cached projections.

See [codex-runtime.md](./codex-runtime.md), [claude-runtime.md](./claude-runtime.md), and [opencode-runtime.md](./opencode-runtime.md) for runtime-specific authority boundaries.

## Session File Format

The unified parser consumes **JSONL** files (one JSON object per line):

```
~/.pi/agent/sessions/--project-name--/
├── 2026-01-15T10-30-00.000Z_a1b2c3d4.jsonl  # native Pi transcript
├── codex-<thread-id>.jsonl                    # generated Codex projection
├── claude-<session-id>.jsonl                  # generated Claude projection
└── opencode-<session-id>.jsonl                # generated OpenCode projection
```

### Example JSONL Content

```jsonl
{"type":"session","version":3,"id":"uuid","timestamp":"2026-01-15T10:30:00Z","cwd":"/Users/me/project","name":"My Session"}
{"type":"message","timestamp":"2026-01-15T10:30:01Z","message":{"role":"user","content":"Hello"}}
{"type":"message","timestamp":"2026-01-15T10:30:05Z","message":{"role":"assistant","content":"Hi!"},"usage":{"totalTokens":42,"cost":{"total":0.0001}}}
{"type":"session_info","timestamp":"2026-01-15T10:30:06Z","name":"Renamed Session"}
{"type":"tool_call","timestamp":"2026-01-15T10:30:06Z","tool":"bash","command":"ls -la"}
{"type":"tool_result","timestamp":"2026-01-15T10:30:07Z","tool":"bash","output":"..."}
{"type":"branch_summary","timestamp":"2026-01-15T10:35:00Z","branch":"main","summary":"..."}
{"type":"compaction","timestamp":"2026-01-15T10:40:00Z","before":"...","after":"..."}
```

### Entry Types

| `type` | Description |
|--------|-------------|
| `session` | Header metadata (cwd, name, version, id) |
| `message` | User or assistant message with optional `usage` and `cost` |
| `session_info` | Session metadata update; latest `name` is used as display title |
| `tool_call` | Agent invoked a tool |
| `tool_result` | Tool execution result |
| `bash` / `bash_output` | Shell command and its output |
| `branch_summary` | Summary of work on a git branch |
| `compaction` | Conversation history was compacted |
| `model_change` | Model switched mid-session |
| `thinking_level_change` | Thinking level changed mid-session |
| `diff` | Code diff output from edit/tool operations |

### Project Directory Encoding

Project names are filesystem-safe encoded:

```go
EncodeProjectName("/Users/me/project") → "--Users-me-project--"
DecodeProjectName("--Users-me-project--") → "/Users/me/project"
```

## Parse Flow

```
File on disk
     │
     ▼
sessions.ParseFile(path, dirName, fileName)
     │
     ├──▶ stream file line-by-line
     │
     ├──▶ json.Unmarshal each line
     │        ├──▶ type=="session" → sess.Header
     │        ├──▶ type=="message" → increment MessageCount, sum tokens/cost
     │        ├──▶ type=="session_info" → latest rename/title metadata
     │        └──▶ all types → append to Entries
     │
     ├──▶ Name = latest session_info.name, else session.name, else first user text, else filename
     ├──▶ Model = last message model or last model_change modelId
     ├──▶ ModelProvider = provider for last-known model
     ├──▶ LastActivity = latest timestamp (or file modtime fallback)
     │
     └──▶ ChatAvailable = cwd still exists?
```

## Cache Strategy

`sessions.Cache` is the canonical server read path for both summary listings
and full session resolution. Server handlers call `Cache.Resolve`; the legacy
`sessions.ResolveByID` path remains only for code that cannot reach the
process-wide cache.

```
LoadAll(dir)
    │
    ├──▶ ReadDir all project subdirs
    │
    ├──▶ For each .jsonl file:
    │         ├──▶ Check modtime against cache
    │         ├──▶ MATCH → return cached SessionSummary
    │         └──▶ MISMATCH → ParseSummary + store in cache
    │
    ├──▶ Evict files no longer on disk
    │
    └──▶ SortByActivity (descending by timestamp)
```

`Cache.Resolve` indexes filenames after their first lookup, incrementally folds
appended JSONL lines, and retains parsed `Session` values in a byte-budgeted LRU
(200 MB by default). The byte budget bounds memory across sessions whose sizes
vary widely; least-recently-used sessions are reparsed on their next access.
`LoadAll` and failed resolves prune cached sessions whose files disappeared.
Summary and full-session cache hit/parse counters, occupancy, and evictions are
reported by `/api/metrics`.

## Data Flow: Viewing a Session

```
Browser GET /session?id=<id>
           │
           ▼
    server.handleSession → SPA shell
           │
           ▼
Browser GET /api/session?id=<id>
           │
           ▼
    server.handleApiSession
           │
           ├──▶ sessions.Cache.Resolve → find file path + parse/cache by modtime
           │
           ├──▶ sessions.ParseFile → Session struct when cache is stale
           │
           └──▶ Write JSON response for SessionPage.svelte
```

## Data Flow: Chat Message

```
Browser POST /api/chat?id=<id>
           │
           ▼
    server.handleChat
           │
           ├──▶ sessions.Cache.Resolve → cached Session + Path
           │
           ├──▶ chat.ParseRequest(r)
           │         ├──▶ ParseMultipartForm
           │         ├──▶ Extract text + image files
           │         └──▶ Validate (not empty, image size, mime type)
           │
           ├──▶ launch workers.Manager.Send in a background goroutine
           │         │
           │         ├──▶ Get or create ChatWorker for session
           │         │         ├──▶ Pi: `pi --mode rpc` + `switch_session`
           │         │         ├──▶ Codex: `codex app-server --stdio` + `thread/resume`
           │         │         ├──▶ Claude: installed CLI stream-json + `--session-id`/`--resume`
           │         │         └──▶ OpenCode: lightweight worker over the shared authenticated HTTP/SSE service
           │         │
           │         └──▶ worker.Prompt(ctx, chatReq)
           │               ├──▶ Pi: prompt RPC (`steer` while running)
           │               ├──▶ Codex: `turn/start` or `turn/steer`, with text/images
           │               ├──▶ Claude: one NDJSON user frame; no concurrent steering
           │               └──▶ OpenCode: native asynchronous text prompt; no attachments or steering
           │
           └──▶ Return HTTP 202 {"ok": true, "status": "queued"}
```

## Data Flow: Rename Session

```
Browser POST /api/rename-session?id=<id>
           │
           ▼
    server.handleRenameSession
           │
           ├──▶ Resolve runtime from session metadata
           ├──▶ Pi: append `session_info` metadata
           ├──▶ Codex: `thread/name/set` → `thread/read` → atomic projection refresh
           ├──▶ OpenCode: native session update → read → atomic projection refresh
           ├──▶ record modtime + broadcast `reload`
           └──▶ Return {"ok": true, "name": "New Name"}
```

For Pi, rename preserves the append-only transcript rule. For Codex and OpenCode, the native title is authoritative; the rebuilt projection also preserves pican-local metadata. Claude does not declare rename, so the action is absent and direct requests fail closed.

## Data Flow: Live Reload

```
Editor saves session file
           │
           ▼
    fsnotify detects Write event
           │
           ▼
    debouncer.schedule(path)  (50ms debounce)
           │
           ▼
    Server.recordModTime(sessID, modTime)
           │
           ├──▶ Update fileMod map
           ├──▶ Broadcast "reload" to SSE clients for this sessID
           └──▶ Recompute running status → broadcast status-delta
           │
           ▼
    Browser EventSource receives "reload"
           └──▶ fetch /api/session
                └──▶ append/upsert canonical entries and clear preview
```

## Data Flow: Share to Gist

```
Browser POST /share?id=<id>
           │
           ▼
    server.handleShare
           │
           ├──▶ share.FindGh → locate `gh` CLI
           │
           ├──▶ gh auth status → verify login
           │
           ├──▶ deps.Resolve(id) → find matching session
           │
           ├──▶ renderExportSessionPage(session)  (no live chrome)
           │
           ├──▶ Write to temp file
           │
           ├──▶ gh gist create --public=false <tmpfile>
           │
           └──▶ Return {gistUrl, gistId, previewUrl}
```

## Data Flow: Codex Catalog Sync

```text
startup, then every minute
           │
           ▼
short-lived `codex app-server --stdio`
           ├── initialize / initialized
           ├── thread/list (all pages; visible non-archived source kinds)
           ├── compare UpdatedAt with the retained catalog state
           ├── unchanged + projection present → skip hydration
           └── new, changed, or missing projection
                 ├── thread/read(includeTurns=true)
                 └── Materialize
                       ├── map items to common session entries
                       ├── preserve local metadata from existing projection
                       └── temp write + fsync + rename + directory fsync
```

Restart performs one full hydration. Later passes retain `UpdatedAt` state, so
the recurring work is the paginated list plus targeted reads. Per-thread
failures are recorded without deleting older projections. Codex executable and
authentication health is probed independently: a deferred or failed catalog
pass leaves cached viewing intact without disabling healthy create, resume, or
chat operations.

## Data Flow: Claude Catalog Sync

```text
startup, debounced native fsnotify, and ten-minute recovery reconcile
           │
           ▼
configured <claude-home>/projects/*/*.jsonl (read-only)
           ├── unchanged (mtime,size) + projection present → skip
           └── changed, new, or missing projection
                 ├── validate UUID filename against record sessionId
                 ├── snapshot initial size; consume newline-terminated records only
                 ├── preserve unknown valid records; mark malformed/tail/race partial
                 └── Materialize through projections.Store
                       ├── deterministic Claude record/block IDs
                       ├── preserve pican-local metadata
                       └── temp write + fsync + rename + directory fsync
```

The watcher is the primary freshness path; the slow reconcile covers missed or
out-of-band filesystem changes. Per-file watcher refreshes never prune. A full
pass may remove only validated Claude projections from its initial projection
snapshot, and only when every native directory and transcript snapshot is
complete. CLI/auth availability is probed separately and does not change
cached projection readability.

## Data Flow: OpenCode Service and Catalog

```text
startup or bounded recovery
           │
           ▼
supervise `opencode serve`
           ├── generated Basic Auth
           ├── 127.0.0.1 + ephemeral port
           ├── authenticated health/version
           └── connect one `/global/event` SSE stream
                     │
                     ▼
native session list/read with canonical directory
           ├── validate native ID + canonical cwd
           ├── read messages/parts
           └── Materialize through projections.Store
                     ├── preserve pican-local metadata
                     └── atomic replace + directory fsync
```

Only a complete successful list/read reconciliation may prune absent validated
OpenCode projections. SSE events are demultiplexed by canonical directory and
native session ID; affected sessions are read again before the projection is
replaced. A child or stream failure keeps cached projections viewable, marks
only OpenCode unavailable, and triggers bounded restart followed by full
reconciliation before recovery is reported.

## Data Flow: Create New Session

```
Browser POST /api/new-session
           │
           ▼
    server.handleNewSession
           │
           ├──▶ Decode path, optional sourceSessionId, and runtime
           ├──▶ Default runtime from server; a sibling inherits its source runtime
           ├──▶ Validate runtime availability and working path
           ├──▶ Pi: create a fresh native JSONL file with inherited settings
           ├──▶ Codex: `thread/start` with model/effort → `thread/read` → materialize projection
           ├──▶ Claude: write only a fresh local UUID projection; first prompt creates native state
           ├──▶ OpenCode: native `POST /session` in the canonical directory, then materialize
           ├──▶ Pre-initialize the runtime worker
           └──▶ Return {"ok": true, "id": <session-or-projection filename>}
```

Hosted Codex creation uses this same endpoint, not a host-only parallel API. Before `thread/start`, the handler canonicalizes the request path inside `WorkspaceRoot`, normalizes the optional initial prompt, hashes the payload, and claims the bounded `Idempotency-Key` in SQLite. One owner creates the Codex thread and persists both Pican and native IDs before prompt dispatch. Same-key replays wait for or return that stable mapping; a different normalized payload returns `409`. Prompt dispatch advances `pending → dispatching → accepted`; a failed or interrupted acknowledgement becomes `unknown`, and startup recovers leftover `dispatching` rows to `unknown` instead of blindly resending.

## Data Flow: Fork Session

```
Browser POST /api/fork-session?id=<sourceId>
           │
           ▼
    server.handleApiForkSession
           │
           ├──▶ Decode JSON body → {"entryId": "..."}
           ├──▶ Resolve source session ID → filesystem path
           ├──▶ sessions.ForkSessionFile(sessionsDir, sourcePath, entryId, now)
           │         ├──▶ Parse source session into by-ID map
           │         ├──▶ Walk from entryId back to root (via parentId)
           │         ├──▶ Reverse to chronological order
           │         ├──▶ Create new session header with parentSession reference + forkedFrom
           │         └──▶ Write new JSONL file in same project directory
           ├──▶ Initialize worker for the new session (async)
           │
           └──▶ Return {"ok": true, "id": <newFilename>}
```

For Codex, the handler resolves the projected entry's `codexTurnId`, calls native `thread/fork(lastTurnId)`, reads the new thread, and materializes its projection. An entry without a native turn boundary returns a conflict instead of fabricating a branch.

For OpenCode, the handler maps the selected projected entry to its native
message and calls the native fork endpoint. Missing native message identity
fails closed. Clone uses the same endpoint without a message boundary to fork
the complete native session.

## Data Flow: Clone Session

```
Browser POST /api/clone-session?id=<sourceId>
           │
           ▼
    server.handleApiCloneSession
           │
           ├──▶ Decode JSON body → {"leafId": "..."}  (optional, defaults to last entry)
           ├──▶ Resolve source session ID → filesystem path
           ├──▶ sessions.CloneSessionFile(sessionsDir, sourcePath, leafId, now)
           │         ├──▶ Parse source session into by-ID map
           │         ├──▶ Walk from leafId back to root (via parentId)
           │         ├──▶ Reverse to chronological order
           │         ├──▶ Create new session header with parentSession reference
           │         └──▶ Write new JSONL file in same project directory
           ├──▶ Initialize worker for the new session (async)
           │
           └──▶ Return {"ok": true, "id": <newFilename>}
```

For Codex, clone is `thread/fork` without `lastTurnId`, so it clones the current native thread rather than copying projected JSONL entries. For OpenCode, clone calls the native fork endpoint without a message boundary. Neither path copies projected JSONL as authority.

## Data Flow: Scratchpad (Notes)

```
Browser GET /api/scratchpad?project=<cwd>
           │
           ▼
    server.handleGetScratchpad
           │
           ├──▶ Query SQLite: SELECT content FROM scratchpads WHERE project_path = ?
           │
           └──▶ Return {"content": "..."}  (empty string if no notes exist)

Browser POST /api/scratchpad
           │
           ▼
    server.handleSaveScratchpad
           │
           ├──▶ Decode JSON body → {"project": "...", "content": "..."}
           ├──▶ UPSERT into SQLite scratchpads table (INSERT ... ON CONFLICT DO UPDATE)
           │
           └──▶ Return {"ok": true}
```
```
