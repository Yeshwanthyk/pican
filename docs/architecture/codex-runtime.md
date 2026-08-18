# Codex App-Server Runtime

pican can host Pi sessions, Codex threads, or both from the same binary. Codex integration uses the installed Codex CLI's `app-server --stdio` protocol; it does not treat Codex's on-disk files as Pi transcripts.

## Runtime selection

```bash
pican                              # auto-discover installed runtimes
pican -runtime=pi                  # explicit Pi-only override
pican -runtime=codex
pican -runtime=both                 # legacy alias for pi,codex
pican -runtime=pi,codex             # explicit ordered-registry selection form
pican -runtime=both -codex-command=/absolute/path/to/codex
PICAN_CODEX_COMMAND=/absolute/path/to/codex pican -runtime=both
```

`-codex-command` and `PICAN_CODEX_COMMAND` name the **Codex executable**, not a shell command. The flag wins over the environment variable; the fallback is `codex` from `PATH`. pican appends `app-server --stdio` and executes the resulting argv directly.

Startup registers Pi, Codex, Claude, and OpenCode in one ordered runtime registry. The default `auto` selection enables runtimes whose configured executables resolve on the host; an explicit `-runtime` value overrides discovery. The selected subset, not a closed enum, is passed to the server and worker factory. The exact legacy value `both` aliases `pi,codex`; comma-separated input is case-normalized, deduplicated, and returned in registration order.

The Codex registration declares `replaceable-projection`, its current supported capabilities, command metadata, independent executable/auth availability probe, catalog adapter, and worker factory. The registry owns dispatch metadata only. Codex remains authoritative for thread state, `internal/projections.Store` owns generic projection replacement mechanics, the Codex adapter owns native-to-pican translation, `workers.Manager` retains worker lifecycle, and Codex-native archive/delete/unarchive plus rename/fork semantics stay on the separate `CodexService` rather than widening the common contract.

Session-directory startup behavior is runtime-specific:

- Any selection containing `pi` requires the configured `~/.pi/agent/sessions` directory to exist.
- Projection-only selections create it when absent because it contains only pican's generated projections.

At startup, Codex-enabled modes first probe the installed executable, version, and login status. Catalog freshness is separate from operational health. Initial reconciliation gets a 15-second startup budget; if it is deferred, the background syncer retries immediately with a ten-minute bound and then repeats every minute. Each periodic pass performs paginated `thread/list`, then compares each row's `UpdatedAt` with the value retained by the syncer. Only new or changed threads, or threads whose projection disappeared out of band, require `thread/read` and materialization. Restarting pican intentionally performs one full hydration.

A failed sync forcibly reports `Complete: false` and cannot authorize pruning, but it does not make a healthy Codex executable unavailable or stop pican in Codex-only mode. Existing projections remain viewable/exportable while background reconciliation retries. A successful complete native list is authoritative for membership: validated projections that existed before the list began and are absent from its ID set are pruned, except a newly created empty projection carrying durable `codexFresh` creation intent. Native list visibility or the first native turn clears that marker; a later complete list may then prune the cache normally. A projection created concurrently with the list is outside that pre-list snapshot and is also retained.

The startup and first-chat call graph is:

```text
app.Main
 ├─ runtimes.Codex(descriptor, catalogSyncer, workerFactory)
 ├─ initial Catalog.Sync → thread/list + thread/read → atomic projections
 ├─ periodic catalogSyncer.start (1 minute) → thread/list + UpdatedAt-gated reads
 └─ workers.Manager factory
      └─ parse projection header → selected Registry.NewWorker("codex", ...)
           └─ Codex factory validates projection metadata
                └─ codex.NewWorker → codex app-server --stdio → thread/resume
```

This is a dispatch prefactor only: Codex native protocol, projection replacement, live preview handoff, process-tree termination, and worker reuse/reap behavior are unchanged.

## Authentication and interaction policy

The installed Codex CLI owns authentication and persistent state. In standalone mode, app-server children retain the existing ambient-environment behavior and use the same `~/.codex` state as `codex` itself. In hosted mode, the host supplies an exact safe environment and a validated workspace working directory. Pican preserves the minimum execution variables plus opaque Codex/OpenAI and GitHub sentinels, but strips Pican proxy authentication and unrelated host/provider secrets. It never resolves, persists, logs, returns, or exposes a real credential, and never reads or writes Codex's private authentication files. Scotty provides `/workspace/<id>/.codex` as the Codex home while Pican-owned state stays under the separate configured state root.

Codex sessions always run in YOLO mode: thread start/resume/fork send `approvalPolicy: "never"` with sandbox `danger-full-access`, and every new turn reasserts the equivalent `dangerFullAccess` sandbox policy. This matches Codex CLI's `--yolo` / `--dangerously-bypass-approvals-and-sandbox`: model-generated commands can access the whole host filesystem and network without confirmation.

If app-server unexpectedly sends a server request despite that policy, pican responds defensively rather than leaving it pending:

- command and file-change approvals are declined/denied;
- permission requests receive an empty permission set;
- user-input requests receive an empty answer map;
- MCP elicitation is declined;
- unknown server request methods receive JSON-RPC `Method not found`.

There is no browser approval or Codex user-input bridge in this implementation. Command/file approval requests should be unreachable under the enforced YOLO policy; the defensive decline remains a protocol fallback.

## Authority and projections

Codex remains authoritative for threads in `~/.codex`. pican obtains threads through `thread/list` and `thread/read`; it does not parse Codex's private storage format. For the existing browse/render/export pipeline, it materializes each thread as:

```text
~/.pi/agent/sessions/<encoded-cwd>/codex-<thread-id>.jsonl
```

Each projection has `runtime: "codex"`, the native thread ID in `nativeId`, and provider `openai-codex`. Codex items are mapped into pican message/tool/compaction entries while the original item payload is retained in `codexRaw` for forward compatibility. Working directories are canonicalized through filesystem symlinks before path encoding (for example, macOS `/tmp` and `/private/tmp`), and materialization migrates preserved local metadata before removing any duplicate projection for the same native thread.

A projection is a **cache**, not another authoritative transcript. User and assistant conversation is rebuildable from Codex. Some persisted `thread/read` snapshots omit command/file/MCP activity that was delivered through live notifications, so captured tool turns are retained monotonically across sparse native refreshes; deleting the projection can therefore discard that best-effort tool presentation without deleting or changing the native thread. Codex keeps that sparse-turn merge and all native item translation inside `internal/codex`, then delegates path derivation, keyed identity locking, local metadata preservation/mutation, duplicate migration, validation, and atomic replacement to `internal/projections.Store`. Materialization writes a temporary file, fsyncs it, atomically renames it over the target, and fsyncs the directory. Refreshes preserve pican-local `session_info`, labels, model changes, thinking-level changes, and the temporary `codexFresh` marker until list visibility or native turn activity clears it. The native placeholder used to persist a new empty thread is marked as generated so normal auto-titling can replace it; a manual rename records user-owned `session_info` after the native rename so it takes precedence over any older auto-title across later refreshes.

This differs from native Pi sessions:

- Pi owns and appends conversation entries to its JSONL transcript; pican only appends supported local metadata such as `session_info`.
- Codex owns conversation state in `~/.codex`; pican atomically replaces the projected conversation after native thread updates.
- Local projection metadata is preserved across replacements. Native archive/delete APIs call app-server first and remove only the validated projection after success; deleting a cache file directly still does not delete the Codex thread.

Projection files intentionally use the normal session parser and cache. That gives Codex threads the unified session list, viewer, SSE reload, download, and static export paths. `/api/session` and the embedded bootstrap declare `projectionMode: "replaceable-projection"`; live reload uses that metadata, not a Codex runtime check, to force full entry reconciliation. Pi's `afterCount` optimization is invalid for an atomically replaced projection because new native entries can be inserted before preserved local metadata. Same-ID entries are replaced from the new snapshot because running tool output and status evolve under stable item IDs; Pi's append-only identity reuse remains unchanged. If the Codex executable or login later becomes unavailable, already-materialized projections remain browseable and exportable. Runtime-dependent operations are disabled with the probe's reason; catalog lag alone is reported in logs and does not disable healthy operations. This is local cached viewing while the Codex runtime is offline; the PWA service worker does not cache session data for use when the pican HTTP server itself is offline.

## Worker and thread lifecycle

The shared `workers.Manager` selects an adapter from the session header. For each active Codex browser session it creates one long-lived:

```text
codex app-server --stdio
```

The worker initializes app-server, calls `thread/resume` with the projection's `nativeId`, reads the native thread, and refreshes the projection. Resuming therefore restores the native Codex thread rather than replaying projected JSONL. Concurrent creation is single-flight, the worker is reused for that session, crashed/error workers are evicted, and idle workers are closed after 10 minutes. Separate short-lived app-server processes perform catalog/model discovery and create, rename, fork, or refresh operations. App-server launchers run in an isolated process group/tree so timeout, shutdown, and worker eviction terminate both the CLI wrapper and its native child rather than leaving an orphan holding the RPC pipes open.

Notifications update authoritative turn identity/status. While an agent-message item is active, its deltas are owned exclusively by the ephemeral `chat-preview` stream, keyed end-to-end by turn and item identity; the item enters the projection only at `item/completed`, and the completed projection is committed and rendered before the preview retires. This avoids competing partial and projected copies, stale completion text, and blank handoff frames. Command, file, MCP, plan, and reasoning progress remains projection-owned, and tool deltas never enter the assistant preview buffer. Tool results retain an explicit running marker until terminal completion. Turn completion and reconnect/resume reconcile through `thread/read`; the just-completed notification turn is protected against lagging snapshots and locally captured tool turns survive later sparse reads. Revision and turn-ID checks prevent late completion from clearing or replacing a newer turn. Retryable errors remain visible warnings, while terminal protocol errors fail and evict the worker.

## Supported surface

Codex sessions use the same browser routes and controls where the semantics match:

| Surface | Codex behavior |
|---|---|
| Create | `thread/start`, then `thread/read` and projection materialization; model and reasoning effort can be inherited from the source session. |
| Hosted create | The existing `POST /api/new-session` requires a bounded `Idempotency-Key`, accepts an optional bounded `initialPrompt`, and persists the normalized request fingerprint plus Pican/native identity and prompt-dispatch state in Pican SQLite. Same-key/same-payload replay returns the same identities; a conflicting payload returns `409`; concurrent callers converge on one mapping. |
| List/read | Startup hydrates every visible, non-archived thread source kind. In hosted mode, authoritative cwd containment is checked before a thread can enter catalog membership or be materialized, and direct loads repeat the check. Periodic standalone sync always runs `thread/list` but gates `thread/read` and materialization on `UpdatedAt`; hosted sync rereads before validation. Missing projections are rehydrated. A fully successful list prunes validated Codex projections absent from its ID set, except a fresh empty session awaiting first native visibility; list failure never prunes, and Pi files are never candidates. |
| Chat | `turn/start` with text and image data URLs. Threads and turns enforce `approvalPolicy: never` plus danger-full-access sandboxing (Codex YOLO mode). Start and steer carry unique `clientUserMessageId` values; returned turn IDs are authoritative. While a turn is active, immediate sends use `turn/steer`. |
| Queue | Uses the same persistent server-side SQLite queue and drainer; dispatch reaches the Codex worker when it becomes idle. |
| Cancel | `turn/interrupt` with the exact active `{threadId, turnId}`. Interrupt does not wait behind a pending start acknowledgement, has a five-second bound, and retains running state when delivery is unknown. |
| Model/effort | Session-scoped `/api/models?id=<session>` uses `model/list`; selections are retained in projection metadata and applied to later turns, with the model also supplied when a reaped worker resumes. |
| Review/compact | `/review` calls `review/start` for uncommitted changes, retains its review thread/turn identity, and projects detached review notifications/output; `/compact` calls `thread/compact/start`. |
| Rename | Updates the native thread with `thread/name/set`, refreshes the projection, then records the user-owned local name so preserved auto-title metadata cannot override it. |
| Archive/delete/unarchive | Authenticated explicit Codex routes perform native lifecycle mutations. Archive/delete remove only a validated local projection after native success; unarchive validates against the archived native catalog, reads/materializes it, and returns the session ID. |
| Labels | Stored as pican-local projection metadata and preserved during refresh. |
| Fork | Maps the selected projected entry to its native Codex turn and calls `thread/fork` at that turn. Entries without a turn boundary cannot be forked. |
| Clone | Calls `thread/fork` without a turn boundary, cloning the current native thread. |
| Status/live updates | Worker notifications drive idle/running/error status, `chat-preview`, projection replacement, `reload`, and index status SSE. Codex does not use Pi's `session-status` files. |
| View/export | Uses the common renderer over an authorized projection. Static export remains separate from live chat and SSE. |
| Terminal resume | The session header copies `codex resume <native-thread-id>`; Pi sessions continue to copy `pi --session <session-uuid>`. |

The sessions index normalizes runtime metadata, shows a Codex badge, includes runtime/native ID in search, and shows configured runtimes when creating a session while disabling any that are unavailable or lack `create`. Creating a sibling session preserves the source session's runtime. Browser create intents generate an idempotency key and retain it across a failed retry; success clears it so the next deliberate create is new. Session pages consume trusted server-provided capabilities and the server-built terminal resume command, so Codex controls are available by descriptor while a future runtime's unsupported actions remain absent.

For an initial hosted prompt, Pican commits `pending`, changes it atomically to `dispatching`, then invokes the normal Codex worker. Only that transition owns dispatch, so a retry cannot send a second prompt at the Pican database boundary. A successful `turn/start` acknowledgement becomes `accepted`. If Pican cannot determine whether dispatch crossed the process boundary, or it restarts while the row is `dispatching`, the row becomes explicit `unknown` and is never resent automatically. This is retry-safe at-most-once dispatch, not exactly-once execution across process death; crash reconciliation of ambiguous Codex work is intentionally deferred.

## Protocol scope and boundaries

The implemented surface is the core coding-session subset, not all 122 generated app-server methods. It includes thread create/read/list/resume/fork/name/archive/unarchive/delete/compact, turn start/steer/interrupt, review start, model list, and coding-session notifications for item/turn progress, status, lifecycle, usage, compaction, reroute/verification, and warnings.

The following families remain explicitly separate:

- **Skills/config/account:** discovery and mutation APIs are not part of this delivery. Installed-CLI subscription authentication remains CLI-owned; pican does not implement account login/logout or parse `auth.json`.
- **Interactive approvals/input:** Codex command/file prompts are bypassed by enforced YOLO mode. Unexpected command/file requests and permission/input/MCP requests retain the documented non-interactive defensive responses; approval UI is not implemented.
- **Excluded app-platform families:** marketplace/plugins/apps, realtime/audio, filesystem/fuzzy search, standalone command/process, remote control, environment/admin/experimental, Windows setup, feedback, and external-agent import APIs are not implemented.

- Codex threads are not converted into native Pi transcripts.
- Projection filenames alone are not trusted; the worker validates the header runtime, provider, native ID, and working directory.
- Unknown Codex item types remain visible as explicit fallback entries with their raw payload instead of being silently dropped.
- Static exports contain the projected snapshot only. They do not include app-server, chat, or SSE behavior.
