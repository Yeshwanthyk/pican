# pican: OpenCode + Claude multi-runtime plan

Branch at planning time: `redesign-effect-ts` at `d52dfbe2b772330416babedd800cb3c1f18c494c`.

This plan is self-contained for a fresh implementation session. Re-check the branch, HEAD, working tree, and current architecture before starting because the frontend redesign/TypeScript work may continue independently. Do not revert unrelated changes. Work in waves and stop at every gate; do not roll multiple waves into one implementation pass.

## 0. Outcome and locked decisions

pican will support Pi, Codex, OpenCode, and Claude through one runtime registry while preserving each runtime's native persistence and protocol semantics.

Locked decisions:

1. Keep the Go core. Do not add Rust, FFI, or a Rust sidecar.
2. Do not depend on `@anthropic-ai/claude-agent-sdk` or any Claude SDK.
3. Claude runs through the installed `claude` CLI with bidirectional `stream-json` and `--dangerously-skip-permissions`.
4. Claude's files under `~/.claude/projects/` are the authoritative catalog and transcript source. Claude stdout is transient live state only.
5. OpenCode runs through its supported headless HTTP/SSE API (`opencode serve`), not terminal scraping.
6. Runtime IDs are open strings registered at startup, not a closed `pi|codex|both` enum.
7. Runtime capabilities are explicit. Unsupported operations remain unavailable rather than being approximated silently.
8. Native runtime state remains authoritative. pican's non-Pi JSONL files are rebuildable projections and must never become the only copy of a Claude, Codex, or OpenCode session.
9. Live app and static export remain separate renders. No worker, API, SSE, or live-only runtime behavior may enter static export/share output.

## 1. Current system to preserve

pican currently has two materially different runtime paths:

- Pi owns append-only JSONL transcripts and uses one `pi --mode rpc` worker per active session.
- Codex owns native threads under `~/.codex`; pican talks to `codex app-server --stdio` and atomically materializes rebuildable projections under `~/.pi/agent/sessions`.

The shared execution seam is `internal/workers.ChatWorker`, managed by `internal/workers.Manager`. Preserve its important behavior:

- one worker per pican session;
- single-flight worker creation;
- pending-send protection so status does not dip to idle during launch;
- crashed-worker eviction;
- idle reaping after ten minutes;
- cancellation and shutdown cleanly terminate child process trees.

The current hard-coded runtime surfaces that must be generalized include:

- `internal/app/runtime.go` and CLI runtime flags;
- `internal/app/app.go` dependency wiring and worker factory selection;
- `internal/server/server.go`'s Codex-specific service dependency;
- runtime-specific branches across session CRUD, models, chat, scheduling, btw, fork/clone, and availability;
- Codex-only replaceable-projection assumptions in backend pagination and frontend live reconciliation;
- runtime lists and capabilities exposed to the Svelte app.

Read before structural changes:

- `docs/architecture/system-overview.md`
- `docs/architecture/backend.md`
- `docs/architecture/codex-runtime.md`
- `docs/sequence-flows/chat.md`
- `docs/sequence-flows/session-viewing.md`
- `docs/sequence-flows/live-reload.md`
- `docs/sequence-flows/share.md`

Update the relevant documents in the same wave whenever architecture changes.

## 2. Target runtime architecture

Introduce a runtime registry owned by app startup. Each runtime registration exposes four narrow concerns rather than one large lowest-common-denominator interface.

### 2.1 Descriptor and capabilities

Every runtime declares:

- stable runtime ID and display label;
- availability probe and disabled reason;
- native command/version information;
- projection mode;
- capability flags.

Projection modes:

- `append-only-native`: Pi transcript is directly rendered and only `session_info` metadata is appended by pican.
- `replaceable-projection`: Codex, OpenCode, and Claude native state is transformed into an atomically replaced pican projection.

Capabilities must cover at least:

- create, resume, fork, clone, rename, archive, delete;
- chat, cancel, steer, persistent queue;
- images/files;
- model listing and in-session model switching;
- effort/reasoning selection;
- slash commands;
- subagents;
- interactive approvals and user questions.

Claude approvals are always bypassed in this plan. Do not build approval UI or an MCP permission bridge. `AskUserQuestion` is a separate capability and remains unsupported until a dedicated protocol proof exists.

### 2.2 Catalog adapter

The catalog adapter lists native sessions and materializes projections. A catalog result must say whether it is complete. Projection pruning is allowed only after a complete successful catalog scan; partial failure must retain existing projections.

Catalog failure for one runtime must not disable or remove sessions from another runtime.

### 2.3 Worker adapter

Retain `ChatWorker` as the active execution seam, expanding or splitting it only when a capability cannot be represented honestly. Runtime-specific workers translate native protocol events into pican worker status, live previews, and reload notifications.

### 2.4 Projection adapter

Extract Codex's proven projection mechanics into reusable infrastructure:

- per-projection locking;
- safe path derivation from runtime ID and native session ID;
- canonical cwd handling;
- atomic replacement;
- preservation of pican-owned local metadata such as names, labels, model/effort selection where appropriate;
- raw native IDs and runtime markers in trusted projection headers;
- rejection of mismatched runtime/native IDs before deletion or mutation;
- pagination/reconciliation metadata declaring that the file is replaceable.

Do not force all runtimes into Codex's native item schema. Normalize only the pican rendering contract and preserve unknown native records as raw payloads where useful for forward compatibility.

## 3. OpenCode design

Preferred topology: one pican-supervised `opencode serve` process bound to a random loopback port, protected with a generated per-launch Basic Auth password. Never expose the child server directly on a non-loopback interface.

Use OpenCode's HTTP/OpenAPI surface for:

- health and version;
- providers and models;
- session list/create/read/update/delete/fork;
- message history;
- asynchronous prompt submission;
- abort;
- commands, agents, children/subagents, and session status where supported.

Use one OpenCode SSE subscription and demultiplex events by native session ID. A lightweight pican worker per active session references the shared child server; it does not spawn an OpenCode process per turn.

OpenCode remains authoritative for its sessions. pican materializes replaceable projections from OpenCode session/message reads and refreshes the affected projection after relevant SSE events.

Before locking the shared-server topology, prove that one server can address sessions from multiple project directories without cwd leakage. If the supported API cannot isolate projects safely, fall back to one supervised server per canonical cwd. Record that decision in `docs/architecture/` rather than hiding it in worker code.

On OpenCode server failure:

- mark only OpenCode unavailable;
- keep existing projections viewable/exportable;
- fail in-flight OpenCode workers clearly;
- restart with bounded backoff;
- re-list and reconcile before declaring recovery;
- never prune from a failed or partial list.

## 4. Claude design

Claude uses a hybrid of durable filesystem truth and transient process events.

```text
~/.claude/projects/*/*.jsonl  -> catalog, authoritative history, projection rebuild
claude stream-json stdout     -> live preview, reasoning deltas, status, errors
claude process lifecycle      -> running, completion, cancellation, crash state
```

### 4.1 Catalog and transcript authority

Scan `~/.claude/projects/*/*.jsonl`, with the root resolved from the effective Claude home used by the configured runtime. Support an explicit Claude home so separate work/personal installations remain isolated.

For each parseable session, derive:

- native session ID from the filename and validated transcript records;
- cwd from transcript records, with encoded-directory inference only as a fallback;
- created/updated timestamps;
- first-user-message preview and display name fallback;
- model and other stable metadata when present;
- authoritative conversation entries.

The parser must be permissive:

- process complete JSONL lines only;
- ignore or preserve unknown record types;
- tolerate malformed individual lines without deleting the session;
- never rewrite Claude's files;
- never infer catalog deletion from one failed scan;
- keep an existing projection viewable if a newer native record cannot yet be decoded.

Watch Claude project directories for changes. Debounce updates, parse from a stable snapshot, and atomically refresh only the affected projection. A full periodic scan remains the recovery path for missed filesystem events and sessions created by other Claude clients.

### 4.2 Active worker

Use a long-lived Claude process per active pican session, managed by the existing worker manager.

Fresh session:

```text
claude -p
  --input-format stream-json
  --output-format stream-json
  --include-partial-messages
  --verbose
  --dangerously-skip-permissions
  --session-id <uuid>
```

Resumed session uses `--resume <session-id>` instead of `--session-id`. These flags are mutually exclusive; tests must lock that invariant.

Add configured model, effort, cwd/additional directory, and command path without shell interpolation. User content is encoded as stream-json input, including supported image content blocks.

The worker:

- waits for Claude initialization before accepting the first prompt;
- writes one JSON object per stdin line;
- continuously drains and bounds stdout/stderr;
- parses stdout into temporary assistant/reasoning previews and worker state;
- captures the native session ID and validates it against the requested session;
- cancels through the supported stream/process mechanism and escalates to process-tree termination after a deadline;
- evicts itself on unexpected exit;
- requests projection refresh when the native transcript changes or the turn completes.

stdout is not persisted as authoritative conversation history. Temporary previews disappear when the file-backed projection catches up. Deduplicate by native message/content identifiers where available; otherwise clear the preview on projection revision advancement rather than guessing at textual equality.

After worker reaping or pican restart, resume from the native Claude session ID and rebuild history from the transcript file. Do not maintain a second private Claude journal.

### 4.3 Explicitly deferred Claude behavior

Do not silently emulate these in the first implementation:

- interactive approvals;
- `AskUserQuestion` round trips;
- forking by copying private Claude transcript files;
- archive/delete operations that Claude does not expose safely;
- complete subagent transcript reconstruction unless the file and stream formats prove stable;
- mid-turn model/effort changes unless verified against the installed CLI.

Expose capability-disabled UI and clear reasons instead.

## 5. Implementation waves

### Wave 0 — Protocol and persistence proofs

Research/prototype narrowly inside tests or disposable fixtures before production wiring:

1. OpenCode: start a loopback server, authenticate, create sessions in two different cwd values, send asynchronously, consume SSE, abort, restart, and read history.
2. Claude: start with a fixed UUID, send two stream-json prompts through one process, observe partial output, interrupt a running turn, verify the native JSONL path/content, terminate, and resume with the same UUID.
3. Claude watcher: prove when durable records appear relative to stdout deltas and process completion.
4. Record fixture samples for unknown/malformed Claude records without checking in secrets or real session content.

Gate: a short evidence note in this plan or `docs/architecture/` records exact installed versions, commands, observed event ordering, chosen OpenCode topology, Claude cancellation behavior, and unresolved gaps. No production adapter work begins without this proof.

Wave 0 evidence: [`docs/architecture/multi-runtime-wave-0-evidence.md`](../docs/architecture/multi-runtime-wave-0-evidence.md).

Verification: targeted tests for any checked-in fixture/parser scaffolding, then `make test`.

### Wave 1 — Runtime registry prefactor

Introduce descriptors, capabilities, availability, catalog, worker factory dispatch, and projection modes. Register only Pi and Codex. Preserve all observable behavior and API compatibility.

Replace `pi|codex|both` internals with a set/list representation. Keep legacy CLI values working if practical, but add an explicit multi-runtime form suitable for four runtimes. Do not make OpenCode or Claude selectable yet.

Remove Codex-specific routing only where the new registry has an equivalent. Codex-native lifecycle methods may remain in its adapter rather than bloating a universal interface.

Gate: existing Pi and Codex unit, integration, frontend, and E2E behavior is unchanged. `make check` passes. Update architecture docs. Commit this wave separately.

Wave 1 implementation record on `multi-runtime-opencode-claude`:

- Added the startup-owned ordered registry contract, explicit Pi/Codex descriptors and capabilities, availability/catalog/factory bindings, validated open runtime IDs, and projection modes. Only Pi and Codex are registered; OpenCode and Claude remain unselectable.
- Replaced the internal runtime enum with a deduplicated selected set ordered by registration. Legacy `pi`, `codex`, and exact alias `both` remain accepted; comma-separated registered IDs provide the future multi-runtime form.
- Routed worker construction, runtime availability, `/api/runtimes`, model selection, status-file policy, and backend pagination policy through the selected registry while retaining the shared `ChatWorker`/manager lifecycle.
- Kept Codex native lifecycle methods on its separate service, Pi transcripts append-only, Codex projections replaceable and native-backed, and live/export rendering separate. Legacy `server.Deps` runtime fields remain a Pi/Codex-only compatibility boundary.
- Architecture is recorded in `docs/architecture/system-overview.md`, `backend.md`, and `codex-runtime.md`. `make check` completed successfully in the uncommitted Wave 1 worktree. `make e2e` was not run, so this record makes no standalone Playwright/E2E claim. Per the implementation-session instruction, no commit was created.

Wave 1 gate status: repository lint, typecheck, format check, dependency analysis, frontend/extension/memory/Go/install tests, vet, and the required `make build` passed through `make check`. The separate E2E evidence remains open.

### Wave 2 — Runtime-neutral projection infrastructure

Extract generic atomic projection and preservation logic from `internal/codex` while leaving Codex translation inside `internal/codex`. Add explicit projection metadata consumed by backend pagination and frontend live reconciliation instead of `runtime == "codex"` checks.

Gate: Codex catalog refresh, local metadata preservation, watcher reload, pagination, export, fork, rename, archive/delete safety, and unavailable-runtime viewing tests pass. `make check` passes. Commit separately.

### Wave 3 — OpenCode adapter

Implement child supervision, authenticated HTTP client, SSE reader, catalog, projection translator, worker adapter, models, create/resume, chat, cancellation, and supported lifecycle operations.

Keep the UI capability-driven: only show actions OpenCode actually supports. One OpenCode failure must not affect Pi or Codex.

Gate: OpenCode acceptance suite passes against fixtures and an opt-in live installed-CLI test. `make check` passes. Update architecture and sequence-flow docs. Commit separately.

### Wave 4 — Claude catalog and projection

Implement configured Claude homes, filesystem scanning, permissive transcript parsing, catalog completeness, projection translation, watchers, and periodic reconciliation. Do not add chat yet.

Existing Claude sessions must become viewable, searchable, exportable, and resumable-in-terminal from pican. Unsupported records must degrade locally rather than hiding the session.

Gate: fixture tests cover discovery, malformed lines, unknown records, cwd fallback, multiple Claude homes, partial scan failure, projection preservation, concurrent file append, and external-session appearance. `make check` passes. Update docs. Commit separately.

### Wave 5 — Claude live worker

Implement the SDK-free stream-json worker, live previews, images, resume, cancellation, status, crash eviction, idle reaping, and file-backed projection convergence.

Do not add permission UI. Always pass `--dangerously-skip-permissions` and make that security posture explicit in settings/help copy.

Gate: live tests prove fresh start, multiple prompts on one process, external resume, worker reap/resume, pican restart, partial streaming, image input, cancellation during generation, process crash, transcript convergence without duplicate messages, and simultaneous Pi/Codex/OpenCode activity. `make check` passes. Commit separately.

### Wave 6 — Product hardening and final verification

Finish runtime-aware settings, commands, scheduling, btw behavior, queues, new-session UX, disabled reasons, metrics, copy-resume commands, and runtime-specific empty/error states. Keep unsupported capabilities absent or disabled with precise copy.

Final gate:

```bash
make test
make check
make e2e
```

Also run opt-in live acceptance tests against installed `pi`, `codex`, `opencode`, and `claude` binaries. Verify a static export from every runtime with the pican server stopped: no chat, SSE, SPA, or runtime calls may remain.

Update root `README.md`, `user-docs/en/`, architecture docs, sequence flows, and any CLI/service installation docs. Commit separately and leave push/PR to the user unless explicitly requested.

## 6. Acceptance contract

Every enabled runtime must satisfy the applicable subset of this contract:

1. Availability: missing binary/auth/config disables only that runtime with a useful reason.
2. Catalog: existing sessions appear without starting a worker; partial scans never prune valid projections.
3. Start/resume: native ID and cwd survive worker reap and pican restart.
4. Streaming: previews are ordered, bounded, and replaced cleanly by authoritative projection data.
5. Persistence: native storage remains authoritative and pican projections are rebuildable.
6. Cancellation: cancellation reaches the native runtime, status converges, and the next prompt can proceed.
7. Crash recovery: dead workers are evicted; cached sessions remain viewable; resume creates a healthy replacement.
8. Model/effort: only supported controls are exposed and selections survive restart when the runtime supports them.
9. Attachments: supported MIME types and size limits are enforced before launch; unsupported runtimes fail clearly.
10. Concurrency: multiple sessions and multiple runtimes cannot cross-deliver events or state.
11. Security: child services bind loopback, credentials are not logged, argv avoids shell interpolation, paths are validated, and bypass-permissions copy is explicit.
12. Export: live-only behavior never appears in static export/share output.

## 7. Main risks

- Claude transcript JSONL is not a stable public API. Keep parsing permissive, fixture-driven, and isolated behind the Claude adapter.
- stdout can lead the durable transcript. Treat it as a preview with a bounded lifetime, not a second history database.
- Filesystem events can be missed or observed mid-write. Debounce, consume complete lines, and retain periodic full reconciliation.
- OpenCode's shared-server cwd semantics must be proven before production topology is chosen.
- Runtime capability flattening creates false parity. Preserve honest differences in both API responses and UI.
- A four-runtime startup flag can become an invalid combinatorial enum. Use a registered set, not new names such as `all-but-claude`.
- Existing frontend redesign/Effect migration work may touch the same runtime UI. Re-check live files and split commits so runtime prefactors do not absorb unrelated visual work.

## 8. Fresh-session kickoff

Use this prompt in a fresh session:

```text
Work in /Users/yesh/code/personal/pican.

Read AGENTS.md and plans/multi-runtime-opencode-claude.md completely. This is staged implementation work. First verify the current branch, HEAD, working tree, relevant docs, installed runtime versions, and whether the redesign/TypeScript plan has changed overlapping files.

Implement Wave 0 only. Keep the work narrowly scoped to protocol/persistence proofs and their evidence. Do not start the runtime registry prefactor or production adapters. Do not add Rust or the Claude Agent SDK. Claude must use the installed CLI with stream-json and --dangerously-skip-permissions; ~/.claude/projects is authoritative history and stdout is transient live state. OpenCode must use its headless HTTP/SSE API.

Run the Wave 0 verification, update the evidence note, report exact commands/results and changed files, then stop at the Wave 0 gate for review.
```
