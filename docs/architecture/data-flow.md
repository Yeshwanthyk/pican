# Data Flow & Session File Format

## Session Storage and Authority

The session pipeline reads JSONL from `~/.pi/agent/sessions`, but the ownership model depends on `runtime`:

- **Pi:** the JSONL file is the native, append-only transcript. Pi supplies conversation entries; pi-web only creates new files and appends supported local metadata.
- **Codex:** `~/.codex` is authoritative. pi-web lists/reads threads through app-server and atomically materializes rebuildable `codex-<thread-id>.jsonl` projections under the matching encoded project directory. Projection refresh preserves local `session_info`, label, model-change, and thinking-level metadata.

See [codex-runtime.md](./codex-runtime.md) for the protocol and lifecycle boundary.

## Session File Format

The unified parser consumes **JSONL** files (one JSON object per line):

```
~/.pi/agent/sessions/--project-name--/
├── 2026-01-15T10-30-00.000Z_a1b2c3d4.jsonl  # native Pi transcript
└── codex-<thread-id>.jsonl                    # generated Codex projection
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

`sessions.Cache` avoids re-parsing unchanged files:

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
           ├──▶ sessions.ResolveByID → Session + Path
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
           │         │         └──▶ Codex: `codex app-server --stdio` + `thread/resume`
           │         │
           │         └──▶ worker.Prompt(ctx, chatReq)
           │               ├──▶ Pi: prompt RPC (`steer` while running)
           │               └──▶ Codex: `turn/start` or `turn/steer`, with text/images
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
           ├──▶ record modtime + broadcast `reload`
           └──▶ Return {"ok": true, "name": "New Name"}
```

For Pi, rename preserves the append-only transcript rule. For Codex, the native thread name is authoritative; the rebuilt projection also preserves pi-web-local metadata.

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
           ├── thread/read(includeTurns=true) per thread
           └── Materialize
                 ├── map items to common session entries
                 ├── preserve local metadata from existing projection
                 └── temp write + fsync + rename + directory fsync
```

Per-thread failures are recorded without deleting older projections. In `both` mode a failed sync marks Codex unavailable but leaves Pi and cached Codex viewing intact.

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
           ├──▶ Pre-initialize the runtime worker
           └──▶ Return {"ok": true, "id": <session-or-projection filename>}
```

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

For Codex, clone is `thread/fork` without `lastTurnId`, so it clones the current native thread rather than copying projected JSONL entries.

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
