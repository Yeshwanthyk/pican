# OpenCode Runtime

pican integrates OpenCode 1.18.4 through its supported headless HTTP/SSE API. It supervises one shared `opencode serve` child rather than scraping a terminal or starting one CLI process per session.

## Configuration and security

```bash
pican -runtime=opencode
pican -runtime=pi,codex,claude,opencode \
  -opencode-command=/absolute/path/to/opencode
```

Command precedence is `-opencode-command`, `PICAN_OPENCODE_COMMAND`, `~/.opencode/bin/opencode` when installed there, then `opencode` from `PATH`. The value is one executable path, never a shell fragment.

pican starts the child with direct argv, an ephemeral port, and `--hostname 127.0.0.1`. Each launch gets a generated Basic Auth password in the child environment. The password is never returned by the pican API or written to logs. The OpenCode port is an internal transport only: clients continue to use pican's authenticated HTTP surface.

Startup verifies `/global/health`, including the native version, before catalog or chat operations are enabled. The same supervised child serves every OpenCode project. Every project-scoped request carries a canonical directory, and responses are checked against that directory and native session identity. This is required because OpenCode may assign unrelated directories the same `projectID`.

## Native authority and projections

OpenCode's own storage is authoritative. pican reads native sessions and messages through the API and materializes:

```text
~/.pi/agent/sessions/<encoded-cwd>/opencode-<native-id>.jsonl
```

These files are replaceable presentation caches. `internal/projections.Store` supplies canonical cwd validation, identity locking, safe paths, local metadata preservation, duplicate migration, and atomic replacement. Deleting or rebuilding a projection does not delete the native session.

A complete successful list may prune validated OpenCode projections absent from native membership. A partial list, per-session read failure, or cwd mismatch never authorizes pruning; healthy native sessions and new work remain available while the bad records are reported. A failed authoritative list or unavailable child marks OpenCode unavailable. Cached projections remain viewable, downloadable, and exportable in either case.

## Shared events and live workers

One authenticated `/global/event` subscription serves the child generation. pican demultiplexes native events by canonical directory and native session ID; global `sync` events are not session content. Each pican OpenCode worker is lightweight state attached to that shared connection, not another process.

For a prompt, pican submits `prompt_async` and consumes ordered message, part, and status events. The transient browser preview is bounded. Relevant native events trigger a session/message read and atomic projection refresh; the authoritative projection replaces the preview through the normal `replaceable-projection` reconciliation path.

Cancellation posts to the native `/session/<id>/abort` endpoint with the session's canonical directory. Only a native `true` response returns the worker to an idle/reusable state. A rejected `false` response or transport failure preserves running state with the error until native session status or the shared event stream provides an authoritative transition.

Models come from OpenCode's provider/model API. The selection is stored as pican-local projection metadata and applied to subsequent prompts. The browser exposes model listing and switching, but not effort or reasoning controls.

## Lifecycle and capabilities

OpenCode supports create, resume, full-session fork/clone, rename, delete, chat, cancel, model listing, and model switching. Forking at a projected message is allowed only when that entry maps to a native OpenCode message; cloning forks the complete native session. Terminal resume copies:

```text
opencode --session <native-session-id>
```

using the configured command path.

Native archive/unarchive, steering a running response, persistent queues, attachments/file references, effort/reasoning selection, slash commands, subagent UI, approvals, and user questions are disabled. The live UI omits those runtime controls from the server-provided capability set, and direct or stale-client requests fail closed with the runtime-specific unsupported-operation reason. Pican's runtime-neutral local Archive action is separate curation metadata and never calls OpenCode.

OpenCode may expose command, agent, child, and other metadata through its API, but pican does not claim a UI capability until that complete interaction has been proven.

## Failure isolation and recovery

An OpenCode child or SSE failure affects only OpenCode. Existing Pi, Codex, and Claude sessions and workers continue operating, while cached OpenCode projections remain readable.

Recovery uses bounded restart/backoff. A new child gets a new port and credential, passes health/version checks, reconnects the global event stream, and completes list/read reconciliation before OpenCode is declared available again. In-flight OpenCode work fails clearly and dead per-session workers are evicted; the next prompt attaches to the recovered shared service.

Shutdown closes the event stream, aborts active work where possible, and terminates the supervised process tree.

## Rendering and export

OpenCode projections use the common list, search, viewer, pagination, labels, download, and static export paths. The live app uses API calls, worker state, and pican SSE. Static export renders only the persisted projection snapshot and contains no OpenCode credential, child URL, HTTP request, SSE connection, chat composer, or SPA behavior.
