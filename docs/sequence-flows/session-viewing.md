# Sequence Flow: Viewing a Session

This flow covers a user opening a native Pi transcript or a materialized Codex, Claude, or OpenCode projection.

## Sequence Diagram

```txt
Browser ── GET /session?id=abc ──▶ Server
Server  ── render SPA shell ─────▶ Browser
Browser ── GET /api/session?id=abc ──▶ Server
Server  ── cache.Resolve + ParseFile ─▶ sessions
Server  ◀─ Session struct ─────────── sessions
Browser ◀─ JSON session payload ───── Server
Browser ── GET /events?id=abc ──────▶ Server (SSE)
```

## Step-by-Step

### 1. Browser Route Shell

`GET /session?id=...` is handled by `handleSession`, which serves the single SPA shell (`internal/ui/embedded/app.html`) through `ui.RenderAppShell`. The shell loads the hashed Vite/Svelte SPA entrypoint from `web/dist/.vite/manifest.json`.

### 2. Session Route Data Fetch

`web/src/routes/SessionPage.svelte` reads the `id` query parameter and fetches:

```txt
GET /api/session?id=<session-id>
```

The route normalizes `runtime`, `nativeId`, and the projected/native session UUID from the API/header, builds the renderer payload, and mounts the session UI. The server builds and shell-quotes each terminal command: Pi uses `pi --session`, Codex uses `codex resume`, Claude uses `claude --resume` with any configured home, and OpenCode uses `<configured-command> --session <nativeId>`.

`SessionContent` derives render items from the active root-to-leaf path. Consecutive tool-only activity stays as individual entries through four tool calls; longer runs render inside a collapsed native `<details>` while preserving the original entry components and `entry-<id>` anchors. Navigation opens ancestor details before scrolling to a nested anchor.

### 3. Session Resolution

`sessions.Cache.Resolve` validates and locates the file, then returns a cached parsed session when the file modtime is unchanged:

```go
func (c *Cache) Resolve(sessionsDir, id string) (ResolvedSession, error) {
    // Validate: must be a basename ending in .jsonl
    if id == "" || filepath.Base(id) != id || filepath.Ext(id) != ".jsonl" {
        return ResolvedSession{}, ErrInvalidSessionID
    }
    // Use the path index or walk all project subdirs to find the file.
    path, err := findPathByFilename(sessionsDir, id)
    // …
}
```

Security: `filepath.Base(id) != id` prevents path traversal.

### 4. Parse Session

`sessions.ParseFile` reads and transforms the JSONL file:

1. Stream file line-by-line with a scanner
2. Unmarshal each JSONL line into `map[string]any`
3. Categorize:
   - `type == "session"` → `sess.Header`
   - `type == "session_info"` → latest metadata such as renamed display title
   - `type == "message"` → increment `MessageCount`, sum `TokenTotal`/`CostTotal`
   - all lines → `sess.Entries`
4. Read `runtime`/`nativeId` from the session header (`runtime` defaults to `pi`)
5. Set display name: latest `session_info.name`, else header `session.name`, else first user message, else filename
6. Set `LastActivity` to latest timestamp (or file modtime as fallback)
7. Check chat availability: disable it when the working directory or selected runtime is unavailable

### 5. API Response

`handleApiSession` returns JSON used by the Svelte route and live reload:

```json
{
  "header": { "cwd": "/path/to/project" },
  "entries": [],
  "name": "Session title",
  "total": 123,
  "from": 0,
  "chatAvailable": true,
  "chatDisabledReason": "",
  "model": "...",
  "modelProvider": "...",
  "runtime": "pi|codex|claude|opencode",
  "nativeId": "<native session id, when applicable>",
  "runtimeLabel": "Pi|Codex|Claude|OpenCode|configured label",
  "capabilities": { "chat": true, "rename": true },
  "projectionMode": "append-only-native|replaceable-projection",
  "resumeCommand": "server-built safe terminal command, or empty"
}
```

For large sessions, `from`/`count` pagination can return an entry window. The Svelte route and `load-earlier` UI use this to prepend older entries.

### 6. SSE Subscription

After session UI initialization, the browser connects to:

```txt
GET /events?id=<session-id>
```

The server:

1. Creates an `sseClient` with buffered channel
2. Sends `:ok\n\n` (SSE comment to confirm connection)
3. Blocks reading from `client.ch` or `r.Context().Done()`

When a Pi transcript append or atomic replaceable projection update changes the file, the session-directory watcher calls `broadcast(sessID, "reload")`. The browser fetches `/api/session`, updates the visible session header and browser `<title>`, and reconciles canonical entries. Codex and OpenCode workers request reload after projection materialization; Claude native changes pass through its read-only watcher.

## Rename Flow

The command menu's **Rename** action calls:

```txt
POST /api/rename-session?id=<session-id>
{ "name": "New title" }
```

For Pi, the server appends a `session_info` line, preserving the append-only transcript rule. For Codex, it calls `thread/name/set` on the authoritative thread and atomically refreshes the projection. OpenCode calls its native update endpoint and refreshes the projection. Claude does not declare rename support, so the action is absent and direct requests return `409`.

## Runtime unavailable / cached viewing

Availability and trusted capabilities are applied after parsing. If a runtime is unavailable or does not support chat, an existing projection still loads through the normal cache and renderer, including download, export, and share. The live UI gates runtime-dependent actions using the server-provided capability set; the server independently returns `409` for unsupported operations and `503` for supported operations whose runtime is unavailable. This does not mean the browser works without the pican HTTP server: the service worker intentionally does not cache session pages or JSON.
