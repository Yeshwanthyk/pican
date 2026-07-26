# Sequence Flow: Chat Message

This flow covers a user typing a message in the session page chat composer and sending it through Pi, Codex, Claude, or OpenCode. Attachments are parsed only when the runtime declares the corresponding capability; OpenCode 1.18.4 is text-only in pican.

The live composer has one unambiguous route per action. Idle shows `Send`. A runtime that supports steering shows an independent `Stop`, primary `Steer now`, and secondary `Queue next` while a turn is running. Queue rows show the server timestamp and `queued next`; a steer chip appears only after `/api/chat` accepts the request and shows its browser submission time. Runtimes without steering or a persistent queue omit those controls from their trusted capability set.

## Sequence Diagram

The HTTP handler resolves and validates the request, starts `chatSender.Send` in a goroutine, and immediately returns HTTP 202 `queued`. The worker portion below is the asynchronous path after that response; worker startup or prompt failures are logged and reflected by subsequent status/reload behavior, not returned by the accepted request.

```
┌─────────┐   ┌─────────┐   ┌────────────┐   ┌──────────────┐   ┌─────────────┐   ┌──────────┐
│ Browser │   │  Server │   │  sessions  │   │    chat      │   │   workers   │   │  pi rpc  │
│         │   │         │   │  (resolve) │   │  (request)   │   │  (manager)  │   │ (worker) │
└────┬────┘   └────┬────┘   └─────┬──────┘   └──────┬───────┘   └──────┬──────┘   └────┬─────┘
     │             │              │                  │                  │               │
     │ POST /api/chat?id=abc
     │ (multipart: message + images)
     │────────────▶│              │                  │                  │               │
     │             │              │                  │                  │               │
     │             │─── ResolveByID ────────────────▶│                  │               │
     │             │              │                  │                  │               │
     │             │◀───────────── Session + Path ────│                  │               │
     │             │              │                  │                  │               │
     │             │─── Check ChatAvailable ──────────│                  │               │
     │             │   (return 409 if disabled)       │                  │               │
     │             │              │                  │                  │               │
     │             │─── chat.ParseRequest(r) ────────▶│                  │               │
     │             │              │                  │                  │               │
     │             │              │─── ParseMultipartForm               │               │
     │             │              │─── Extract text + image files       │               │
     │             │              │─── Validate size / mime type        │               │
     │             │              │─── base64 encode images             │               │
     │             │              │                  │                  │               │
     │             │◀───────────── chat.Request ──────│                  │               │
     │             │   {Message, Images}               │                  │               │
     │             │              │                  │                  │               │
     │             │─── chatSender.Send(ctx, id, path, req) ──────────▶│               │
     │             │              │                  │                  │               │
     │             │              │                  │                  ├─── workerFor(id, path)
     │             │              │                  │                  │               │
     │             │              │                  │                  ├─── Get existing?
     │             │              │                  │                  │   ┌─ yes ─┐   │
     │             │              │                  │                  │   ▼       │   │
     │             │              │                  │                  │  use it   │   │
     │             │              │                  │                  │   │       │   │
     │             │              │                  │                  │   └───┬───┘   │
     │             │              │                  │                  │       │       │
     │             │              │                  │                  │   no  │       │
     │             │              │                  │                  │   ▼   │       │
     │             │              │                  │                  │─── factory(id, path)──▶│
     │             │              │                  │                  │       │       │
     │             │              │                  │                  │       │─── exec.Command("pi", "--mode", "rpc")
     │             │              │                  │                  │       │─── Start()
     │             │              │                  │                  │       │─── switch_session RPC
     │             │              │                  │                  │       │─── goroutines: consume stdout, wait
     │             │              │                  │                  │       │
     │             │              │                  │                  │◀────── ChatWorker ─│
     │             │              │                  │                  │               │
     │             │              │                  │                  ├─── worker.Prompt(ctx, chatReq)
     │             │              │                  │                  │               │
     │             │              │                  │                  │               ├─── touch() (update idle tracking)
     │             │              │                  │                  │               │
     │             │              │                  │                  │               ├─── BuildPromptCommand(id, chat, streaming)
     │             │              │                  │                  │               │
     │             │              │                  │                  │               ├─── sendAndAwait(ctx, cmd)
     │             │              │                  │                  │               │
     │             │              │                  │                  │               │─── Write JSONL to stdin
     │             │              │                  │                  │               │
     │             │              │                  │                  │               │─── Block on pending channel
     │             │              │                  │                  │               │
     │             │              │                  │                  │               │◀── consume() goroutine
     │             │              │                  │                  │               │    reads stdout line-by-line
     │             │              │                  │                  │               │    matches response by id
     │             │              │                  │                  │               │
     │             │              │                  │                  │               │─── Response arrives
     │             │              │                  │                  │               │─── status → idle
     │             │              │                  │                  │               │
     │             │              │                  │                  │◀────────────── nil
     │             │              │                  │                  │               │
     │             │◀───────────── nil ──────────────│                  │               │
     │             │              │                  │                  │               │
     │◀──────────── 202 {ok: true, status: "queued"} ─│                  │               │
     │             │              │                  │                  │               │
     │             │              │                  │                  │               │
     │             │              │                  │                  │               │
     │ GET /api/worker-status?id=abc
     │────────────▶│              │                  │                  │               │
     │             │─── computeRunningStatus ─────────────────────────▶│               │
     │             │              │                  │                  │               │
     │             │              │                  │                  ├─── Status()
     │             │              │                  │                  │   (may return running)
     │             │              │                  │                  │               │
     │◀──────────── {state: "running", model: "…", thinkingLevel: "…"} ─│                  │               │
     │             │              │                  │                  │               │
     │             │              │                  │                  │               │
     │  [Later]    │              │                  │                  │               │
     │  SSE: agent_end
     │◀──────────── event: reload ──────────────────────────────────────────────────────│
     │             │              │                  │                  │               │
     │  (browser reconciles from `/api/session`; interim assistant text may have appeared earlier via `chat-preview` SSE)
```

## Step-by-Step

### 1. User Submits Chat

Browser sends a `multipart/form-data` POST:

```
POST /api/chat?id=2026-01-15T10-30-00.000Z_a1b2c3d4.jsonl
Content-Type: multipart/form-data; boundary=----WebKitFormBoundary

------WebKitFormBoundary
Content-Disposition: form-data; name="message"

Hello, can you refactor this function?
------WebKitFormBoundary
Content-Disposition: form-data; name="images"; filename="screenshot.png"
Content-Type: image/png

<binary data>
------WebKitFormBoundary--
```

### 2. Request Parsing

`chat.ParseRequest`:

1. Sets `MaxBytesReader` (32 MB default)
2. Calls `ParseMultipartForm`
3. Extracts `message` text field
4. For each `images` file:
   - Read with `io.LimitReader` (10 MB per image)
   - Validate size
   - Detect MIME type (`http.DetectContentType`)
   - Reject non-image types
   - Base64 encode
5. Validate at least one of message or images is present

### 3. Worker Resolution

`workers.Manager.workerFor(sessionID, sessionPath)`:

```text
lock → reuse healthy worker / evict error worker / join in-flight creation
  → parse session runtime
      → Pi: start `pi --mode rpc`, then switch_session
      → Codex: validate projection, start `codex app-server --stdio`, then thread/resume
      → Claude: validate projection/native UUID, start installed `claude` stream-json with fresh `--session-id` or existing `--resume`
      → OpenCode: attach a lightweight worker to the supervised shared HTTP/SSE service
  → store one worker for the session
```

The manager reuses that worker until it fails, the server exits, or it has been idle for 10 minutes. Codex resumes from its native thread. Claude resumes from its native UUID and read-only transcript; neither replays the pican projection as authority.

`Manager.Send` reserves the session before worker lookup, so the accepted-send window reports `running` even while a worker process is still starting. The reservation has its own cancellable context. Stop cancels pending sends before they reach `Prompt`, and also calls the native abort operation when a worker already exists; a cancellation never creates a worker.

### 4. Runtime prompt

For Pi, `piRPCWorker.Prompt` builds and sends:

```json
{"id":"req-1","type":"prompt","message":"Hello, can you refactor this function?","images":[{"type":"image","data":"iVBORw0…","mimeType":"image/png"}],"streamingBehavior":"steer"}
```

If the Pi worker is already running, `streamingBehavior` is `"steer"`.

For Codex, `codex.Worker.Prompt` converts text and attachments to app-server input (`text` and image data URLs):

- no active turn → `turn/start`, with the selected model and reasoning effort;
- active turn → `turn/steer` with the expected native turn ID;
- `/review` → `review/start` targeting uncommitted changes;
- `/compact` → `thread/compact/start`.

For Claude, `claude.Worker.Prompt` writes one stream-json user object containing text and base64 image content blocks. The first input triggers and validates `system:init` within a bounded launch timeout; subsequent sequential prompts reuse the process. Concurrent sends are rejected because Claude does not declare `steer`.

For OpenCode, the worker sends `prompt_async` with the canonical directory and
native session ID. One authenticated global SSE subscription carries all
OpenCode events; pican demultiplexes them by directory/session identity.
OpenCode does not declare attachments or steering, so those requests fail
before native dispatch.

### 5. Response handling

For Pi, the `consume()` goroutine reads JSONL lines from `pi`'s stdout:

```
{"type":"response","id":"req-1","success":true}
```

It matches by `id` and delivers to the waiting `pending` channel. The worker then updates its status to `idle`.

Codex uses JSON-RPC responses plus notifications. `turn/started`, item deltas/completions, `turn/completed`, and thread-status notifications update worker state, emit best-effort `chat-preview`, refresh the projection, and trigger canonical `reload` reconciliation.

Claude translates `system:init`, `stream_event`, `assistant`, `result`, and `error` records to worker status/preview callbacks. Unknown valid record types are ignored with bounded metadata-only diagnostics; malformed output or identity mismatch fails the worker. On `result`, the worker waits for the matching native assistant message to reach the read-only transcript projection before retiring the preview and becoming idle.

OpenCode translates native message/part/status events to bounded preview and
worker status, then re-reads native history and atomically replaces the
projection. Global `sync` events aren't treated as session content.

### 6. Streaming events

While the AI is generating, Pi may emit stream events:

```
{"type":"message_update", …}
{"type":"message_update", …}
{"type":"message_end"}
{"type":"turn_end"}
{"type":"agent_end"}
```

These update `lastStreamActivity` so `Status()` continues to report `running` until the stream completes.

### 7. Error Handling

| Error | Response |
|-------|----------|
| Empty request | 400 `{"error": "message or image required"}` |
| Image too large | 413 `{"error": "image attachment too large"}` |
| Unsupported image type | 415 `{"error": "only image attachments are supported"}` |
| Session not found | 404 `{"error": "not found"}` |
| Chat disabled | 409 `{"error": "This session can be viewed, but chat is disabled because its working directory no longer exists."}` |
| Runtime does not support the requested chat operation | 409 `<label> runtime does not support <operation>` |
| Runtime supports the operation but is unavailable | 503 with the registry probe's current reason |

Before parsing or dispatching, the server resolves the persisted session runtime and checks the trusted registry descriptor. Chat requires `chat`; a send against a running worker also requires `steer`; images require `images`; cancel, queue, model/thinking changes, commands, and file references each require their corresponding capability. The composer receives the same complete capability set from `/api/session` and does not offer unsupported paths, but the server remains authoritative for direct requests and stale clients.

Codex workers use `approvalPolicy: "never"`. Server requests for command/file approval are declined, permissions and user-input answers are empty, and MCP elicitation is declined; no approval dialog is exposed in the browser.

### 8. Worker Lifecycle

After 10 minutes of idle time (no user-initiated actions), the reaper goroutine closes idle workers to free resources.

### 9. Cancelling a Chat

`POST /api/chat/cancel?id=<id>` checks the runtime's `cancel` capability and calls the existing runtime worker's abort operation. If a replaceable projection disappears during a live turn, cancellation may fall back to the manager's existing-worker lookup by session ID; it does not recreate the projection or worker. The HTTP operation has a five-second bound even if an adapter fails to honor context cancellation. On success the server removes any terminal session-status file, broadcasts reload/status updates, and returns `{"ok": true, "status": "cancelled"}`.

The native requests are:

- Pi writes `{"type":"abort"}` through its JSONL RPC. Pi replies only after `AgentSession.abort()` completes; pican clears the recent-stream overlay and publishes idle after that acknowledgement.
- Codex sends JSON-RPC `turn/interrupt` with the exact active `{threadId, turnId}`. It is not serialized behind a pending `turn/start` acknowledgement. The worker bounds the call to five seconds; an unknown timeout outcome stays `running` instead of claiming completion.
- Claude writes `{"type":"control_request","request_id":"...","request":{"subtype":"interrupt"}}`. A successful matching `control_response` leaves the process reusable; timeout terminates the process tree and reports an error.
- OpenCode posts `/session/<native-id>/abort?directory=<canonical-cwd>`. Only a native `true` response moves the worker to idle. Rejection or transport failure retains running state plus the error until authoritative native status says otherwise.

The browser treats HTTP success as interrupt acknowledgement, not terminal completion. It shows `stopping`, disables repeated Stop clicks, clears the optimistic working preview, and reloads persisted content. Polling keeps `stopping` visible while the worker still reports running and changes to idle only on an authoritative worker transition.

### 10. Model and effort

The browser requests `/api/models?id=<sessionId>`, which selects the session runtime. Pi retains its existing model behavior. Codex uses app-server `model/list`; model and effort selections are appended as local projection metadata, preserved across refresh, and applied to later turns. The selected model is also supplied when a reaped worker resumes.

OpenCode discovers provider/model pairs through the shared service and supports
model switching. It does not expose effort or reasoning controls.

### 11. Steering and Queuing

While a response is running the composer stays enabled and the toolbar swaps the
**Send** button for **Steer** plus a **Queue** button (`ChatToolbar.svelte`). A
docked panel (`QueuePanel.svelte`) sits above the composer card showing every
pending message — queued and in-flight steers alike — with keyboard navigation,
pause/resume, and per-row delete / send-now / edit actions.

- **Steer** sends the message immediately through the same `POST /api/chat` path.
  Because the worker is already `running`, `piRPCWorker.Prompt` tags the command
  `streamingBehavior:"steer"` (step 4) so pi folds it into the active turn. The
  message appears as a steer row in the panel until the run completes; the user
  can also dismiss the row early (the message is still with pi). Steers are
  **browser-local** — closing the tab discards any unsent steer chip.
- **Queue** holds the message on the **server** in the `chat_queue_items`
  SQLite table (see `internal/chatqueue`). The autonomous backend drainer
  (`internal/server/chat_queue_drainer.go`) watches every session: whenever a
  worker transitions `running → idle`, the periodic 5-second tick fires, or a
  queue mutation arrives, the drainer pops the head item and feeds it to
  `chatSender.Send`. The browser is just a viewer; queues survive refreshes,
  browser closes, and pican restarts.
- **Pause / Resume** (header button): pause is per-session state in
  `chat_queue_state.paused`, so it persists across tabs and reloads. The
  drainer skips paused sessions; resuming PATCHes `paused=false` and kicks the
  drainer to pick up the next item if the worker is idle.
- **Keyboard** (document-level, only when textarea is empty): ↑↓ navigate, ⌫
  delete the focused row, ↩ send the focused queued message now (skip-ahead),
  **E** pop the focused queued message back into the textarea for editing, Esc
  blur the panel.

Claude and OpenCode declare neither steering nor persistent queues. Their
composer waits for the active turn to finish or be cancelled; stale-client
requests receive the runtime's `409` unsupported-operation response.

REST surface (single handler in `internal/server/chat_queue.go`):

- `GET    /api/chat/queue?id=<sessionID>`            → `{items, paused}`
- `POST   /api/chat/queue?id=<sessionID>`            body `{message, displayText}`
- `DELETE /api/chat/queue?id=<sessionID>&position=N`
- `PATCH  /api/chat/queue?id=<sessionID>`            body `{paused}`

On every mutation the server broadcasts an SSE `queue` event on the session
topic; `live-events.js` translates it to a `pi-queue-event` window event that
`ChatComposer.svelte` listens for and re-fetches the queue from. That keeps
multi-tab and drainer-driven changes (auto-dequeue, etc.) in sync without
polling.

State lives in `web/src/components/session/chat/queue-store.svelte.js` (a
Svelte 5 `$state` class with `items`, `paused`, `focusIndex`). The runtime glue
in `steer-queue.js` calls `queue-api.js` for the queued-side mutations, and
installs `sendNow` / `edit` / `resume` callbacks the panel calls back into. An
`activeRun` flag — driven solely by the `pi-chat-message-sent` (→ true) and
`pi-worker-done` (→ false) events — distinguishes the run-starting message
from later steers, so the first message of a run and auto-dequeued messages
are never mistaken for steers. Dismissed steers are browser-local and gone on
reload; queued rows persist server-side until the drainer dispatches them or
the user removes them.

### 12. Extension UI requests

Extensions running inside the RPC worker can pause for browser input by emitting
an `extension_ui_request`. The worker stores dialog methods (`confirm`, `select`,
`input`, and `editor`) in memory and broadcasts the full request as a named
`extension-ui-request` SSE event on the session topic. Fire-and-forget `notify`
requests become `extension-notify`; the other display-only methods are ignored.

`ChatComposer.svelte` hydrates pending dialogs from
`GET /api/extension-ui/pending?session=<id>` and keeps them synchronized from
the session EventSource. `ExtensionUiCard.svelte` renders them above the composer.
Submitting a card posts to `/api/extension-ui/respond`; the manager finds the
already-running worker without spawning one, writes an `extension_ui_response`
JSONL line to its stdin, and broadcasts `extension-ui-resolved` so every open tab
dismisses the request. Pending dialogs are process-local and are cleared when the
worker exits or is reaped.

---

**E2E coverage:** `e2e/tests/chat.spec.ts` drives this flow end-to-end with a stub `pi` worker (`e2e/lib/stub-pi/pi`); `e2e/tests/steer-queue.spec.ts` covers the steer/queue flow. See [docs/dev/e2e-testing.md](../dev/e2e-testing.md).
