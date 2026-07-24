# Multi-runtime Wave 0 evidence

Date: 2026-07-19

Branch: `multi-runtime-opencode-claude`

Baseline: `32b6b0861582e4ee54589a5171a911e0bcaa23a5`

This note records the disposable protocol and persistence proofs required before production OpenCode or Claude adapters. It does not add runtime wiring.

## Baseline

| Runtime | Installed version | Executable |
|---|---:|---|
| Pi | 0.80.10 | `~/.nvm/versions/node/v22.21.1/bin/pi` |
| Codex | 0.144.5 | `~/.nvm/versions/node/v22.21.1/bin/codex` |
| OpenCode | 1.18.3 | `~/.opencode/bin/opencode` |
| Claude Code | 2.1.215 | `~/.local/bin/claude` |

The required architecture and sequence-flow documents were re-read against the live source. From the planning commit `d52dfbe` to this baseline, no runtime/backend architecture file changed. The only overlapping changes were the already-separated session-navigation and command-palette UI commits plus the plan itself.

## OpenCode 1.18.3

### Launch and authentication

A disposable server was launched with a generated password, explicit loopback binding, mDNS disabled by default, and no shell interpolation in the intended argv:

```bash
OPENCODE_SERVER_USERNAME=pican-wave0 \
OPENCODE_SERVER_PASSWORD='<generated>' \
opencode serve \
  --hostname 127.0.0.1 \
  --port '<random-loopback-port>' \
  --print-logs \
  --log-level INFO
```

Observed:

- `GET /global/health` without Basic Auth returned `401`.
- The authenticated request returned `200 {"healthy":true,"version":"1.18.3"}`.
- `GET /doc` returned the OpenAPI 3.1 document. The relevant supported operations were session list/create/read/update/delete/fork, message history, `prompt_async`, abort, commands, providers, status, `/event`, and `/global/event`.
- The generated password did not appear in server output.

### Shared-server cwd isolation

Two temporary cwd values were passed through the API's `directory` query parameter. Both sessions were active concurrently on one server:

```text
POST /session?directory=<project-a>  {"title":"pican Wave 0 project a"}
POST /session?directory=<project-b>  {"title":"pican Wave 0 project b"}
POST /session/<id>/prompt_async?directory=<matching-project>
```

Both async submissions returned `204`. Each prompt required the agent to run `pwd` and read a cwd-local `marker.txt`. Native message history recorded:

```text
project-a: pwd -> /private/tmp/.../project-a; marker -> alpha
project-b: pwd -> /private/tmp/.../project-b; marker -> beta
```

No tool output, message, status, or SSE event crossed session/cwd boundaries. OpenCode canonicalized macOS `/tmp` to `/private/tmp`; pican must compare canonical paths.

`/global/event` was the correct single subscription for this topology. Its envelope carried the canonical `directory` plus a native payload. For both sessions the observed progression was:

```text
session.created
session.updated
message.updated / message.part.updated        # user input
session.status {type: busy}
message.updated / message.part.delta           # reasoning and text deltas
message.part.updated                           # tool start/completion
message.updated                                # completed assistant message
session.status / session.idle
```

`sync` events were interleaved throughout and must not be mistaken for session-local content.

### Abort, restart, and history

A second async prompt started `sleep 30`. With the same `directory` scope:

1. `GET /session/status` reported the native session as `busy`.
2. `POST /session/<id>/abort` returned `200 true`.
3. Status removed the session from the busy map.
4. Message history retained `MessageAbortedError`; the shell part recorded that the user aborted the command.
5. After terminating and restarting `opencode serve`, both native IDs, canonical directories, completed messages, tool results, and abort errors were readable.

The disposable native sessions were deleted through `DELETE /session/<id>` after the restart proof.

### Topology decision and gaps

**Decision:** keep the preferred one-server topology. One authenticated loopback server safely addressed simultaneous sessions in different canonical cwd values, and one global SSE subscription provided an explicit directory/session demultiplexing boundary.

Required adapter rules discovered by the proof:

- Include the canonical `directory` on every project/session-scoped API call, including status and abort. An unscoped status call did not include the temporary sessions.
- Do not rely on `scope=project` alone for catalog isolation. Both temporary repositories were assigned OpenCode `projectID: "global"`, so a scoped list returned unrelated global sessions. Treat each session's native `directory` as authoritative and filter/validate explicitly.
- On restart, reconnect global SSE and complete a list/read reconciliation before declaring OpenCode recovered.

## Claude Code 2.1.215

### Launch shape and input

The successful proof used one fixed UUID, OAuth from the configured default Claude home, and removed a stale `ANTHROPIC_API_KEY` from the child environment:

```bash
claude -p \
  --input-format stream-json \
  --output-format stream-json \
  --include-partial-messages \
  --verbose \
  --dangerously-skip-permissions \
  --safe-mode \
  --tools Bash \
  --model haiku \
  --session-id '<fixed-uuid>'
```

One NDJSON input object was written and flushed per turn:

```json
{"type":"user","message":{"role":"user","content":[{"type":"text","text":"..."}]}}
```

The process returned `42` and `63` for two prompts, with the same session ID, and remained alive after both per-turn `result` events while stdin stayed open. Closing stdin terminated it with exit code 0.

### Initialization and streaming order

No stdout initialization event arrived during two seconds before the first input. The first user line triggered `system:init` about 14 ms later. The second prompt emitted another `system:init` on the same process.

Production implication: process start alone cannot satisfy an "init before first prompt" handshake. The worker must serialize and queue the first accepted send, write that input to trigger initialization, then validate the returned cwd/session ID/permission mode before treating launch as healthy. It must tolerate repeated `system:init` events.

With `--include-partial-messages`, each turn emitted:

```text
system:init
system:status requesting
stream_event message_start
stream_event content_block_start
stream_event content_block_delta (thinking_delta/signature_delta/text_delta)
assistant
stream_event message_delta/message_stop
result success
```

The init payload reported the requested fixed session ID, canonical cwd, Claude Code version, model, tools, and `permissionMode: "bypassPermissions"`.

### Transcript authority and watcher timing

The native transcript appeared at:

```text
~/.claude/projects/-private-tmp-pican-claude-wave0-...-project-default/<fixed-uuid>.jsonl
```

Observed record types included `queue-operation`, `user`, `ai-title`, `assistant`, `last-prompt`, and `mode`. Conversation records carried the fixed `sessionId`, canonical cwd, UUID/parent UUID chain, role, content blocks, and timestamp; several metadata record types did not carry cwd.

In this run:

- complete user records were visible before assistant stdout deltas;
- first-turn assistant records became visible about 104 ms after stdout `result`;
- second-turn assistant records became visible about 83 ms after stdout `result`;
- `last-prompt` and `mode` records arrived later still.

Therefore stdout completion is not projection completion. A worker should request refresh at turn completion, but temporary preview retirement must wait for a newer stable file-backed revision or a debounced watcher refresh. The parser must consume complete lines only and retain the prior projection when a new line cannot yet be decoded.

### Cancellation and resume

After the first process exited, the same session was reopened with `--resume '<fixed-uuid>'` and no `--session-id`. A running turn was cancelled over stdin without killing the process:

```json
{"type":"control_request","request_id":"<unique>","request":{"subtype":"interrupt"}}
```

Observed response and state:

```text
control_response success {still_queued: []}
result error_during_execution {terminal_reason: "aborted_streaming"}
process remained alive
next prompt returned 23 successfully
```

The transcript persisted a normal user record, assistant progress, and a user record containing `[Request interrupted by user]`. This is the preferred cancellation mechanism; process-tree termination remains the timeout/crash escalation path.

Passing `--session-id` and `--resume` together without `--fork-session` exited 1:

```text
Error: --session-id can only be used with --continue or --resume if --fork-session is also specified.
```

Fresh and resumed argv builders must remain separate and tests must lock that invariant.

### Configured-home behavior and gaps

`CLAUDE_CONFIG_DIR=<dir>` redirected Claude's config/project storage. A fresh directory was correctly isolated but unauthenticated (`Not logged in`); an invalid inherited `ANTHROPIC_API_KEY` produced streamed authentication failures. The installed CLI's `auth status --json` nevertheless reported `loggedIn: true` for any inherited key before that key was validated by a request. Production probes and workers must therefore both remove `ANTHROPIC_API_KEY` and use the configured home's OAuth identity; otherwise availability can pass while the first turn fails or a key can cross explicitly isolated homes. Each configured Claude home needs its own availability/auth probe and disabled reason.

Other boundaries retained from the plan:

- filesystem JSONL remains authoritative; stdout is transient preview/status only;
- unknown records must remain opaque rather than being dropped;
- malformed complete lines and incomplete tails must not hide or delete a session;
- `AskUserQuestion`, approvals, transcript copying for forks, and unsupported lifecycle mutation remain deferred.

Synthetic, secret-free parser cases are recorded under `internal/claude/testdata/`. No real transcript content is checked in.

## Wave 0 gate

The protocol proofs support the planned runtime registry and adapter split, with two clarified contracts:

1. OpenCode can use one shared loopback server, but cwd must accompany every scoped request and catalog filtering cannot trust `projectID`/`scope=project` alone.
2. Claude initialization is first-input-driven, and durable assistant records can lag stdout completion. First-send launch and preview-to-projection convergence must model that ordering explicitly.

No production adapter or runtime registry work starts until this gate is reviewed.
