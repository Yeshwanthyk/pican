# Pican hosted workspace and multi-Thread contract

Research date: 2026-07-28

This document replaces the earlier single-bound-session proposal. The historical filename is
retained so existing links continue to work, but a hosted Pican instance is not bound to one
Pican session or one native Codex thread.

The document deliberately separates repository-backed current behavior from the recommended
product contract. “Recommended” statements are design requirements, not claims that the current
implementation already satisfies them.

## Product boundary and terminology

Pican has two product modes:

- **Standalone mode is full Pican.** It includes the complete local product and catalog, all
  supported runtimes, and all supported features. Hosted constraints must not reduce or redefine
  standalone behavior.
- **Hosted mode is Pican in one host-owned, fixed workspace.** It is Codex-only, but it still
  contains and presents many conversations.

The recommended hosted user-interface and product language calls each conversation a **Thread**.
Existing internal Pican API routes, payload fields, persisted formats, Go types, JavaScript
symbols, and source names continue to use **Session** where they do today. For example,
`SessionPage`, `/api/session`, `/api/sessions`, and a Pican session ID remain internal names. The
translation is:

```text
hosted UI “Thread” = one Pican Session projection of one native Codex thread
```

This is a presentation boundary, not an API migration. User-facing hosted strings should say
“Thread”; source and wire contracts should not be renamed merely to match that label.

## Confirmed current behavior

### Hosted narrows runtime, security, and workspace—not the application

Hosted configuration requires an absolute workspace root, an absolute state root, proxy
authentication, and the Codex runtime
([`internal/app/config.go`](../../internal/app/config.go)). Startup canonicalizes the workspace,
contains the state root within it, builds a Codex-only runtime registry, disables local browser and
Tailscale publication, and runs Codex from that workspace
([`internal/app/app.go`](../../internal/app/app.go)).

Those restrictions do not create a single-session product. The current server still initializes
the general SQLite schema, watchers, scheduler, queue drainer, and other broad application services
([`internal/server/server.go`](../../internal/server/server.go)). It registers the catalog, create,
fork, clone, rename, archive, delete, chat, file, Git, settings, workflow, task, subagent, and other
routes through the same server registration. The live frontend is also the general application:
the root renders `SessionsPage`, and `/session?id=...` renders `SessionPage`
([`web/src/App.svelte`](../../web/src/App.svelte)).

Therefore, current hosted mode narrows the available runtime and enforces a security/workspace
boundary; it does not narrow the broad catalog or application to one immutable conversation.
The current shared UI also still uses “Session” in user-facing copy; changing hosted product copy
to “Thread” is recommended work, not confirmed implementation.

### One fixed workspace can contain many Codex threads

The configured `WorkspaceRoot` is the shared containment boundary for hosted create, catalog,
session, file, Git, task, project, and child-working-directory operations. It is not a Thread ID.
Codex catalog reconciliation lists native threads and materializes the ones whose authoritative
working directories pass the hosted workspace resolver
([`internal/codex/catalog.go`](../../internal/codex/catalog.go),
[`internal/app/codex_configured.go`](../../internal/app/codex_configured.go)).

Hosted creation can also create additional contained Codex threads. A current Scotty bootstrap may
begin by making one idempotent create request, but that is an initial action, not the hosted Pican
product boundary. Reconciliation and later create requests can produce many contained Threads in
the same fixed workspace.

### Identity already has workspace and per-Thread layers

The host supplies the workspace-level identity indirectly through the fixed mount/base path,
canonical `WorkspaceRoot`, and host authentication context. Each Thread then has two Pican-side
identifiers:

- the Pican projection/session ID returned as `id`; and
- the native Codex thread ID returned as `nativeId`.

The hosted create flow starts a native Codex thread and persists both values
([`internal/server/new_session.go`](../../internal/server/new_session.go)). The projection ID is the
ID accepted by Pican’s Session APIs and selected by the current `/session?id=...` route. The native
ID is used by the Codex adapter for native operations. Their current derivation is an
implementation detail and does not collapse the two identity domains
([`internal/codex/projection.go`](../../internal/codex/projection.go)).

An `Idempotency-Key` belongs to one normalized create request. Replaying the same key and request
returns the same projection/native pair; conflicting reuse is rejected
([`internal/server/hosted_create_test.go`](../../internal/server/hosted_create_test.go)). The key
does not identify or bind the workspace. A different create intent uses a different key and may
create another Thread in the same workspace.

Selection state and deep links identify the Thread being viewed. They do not turn that Thread into
the identity of the hosted product.

### Current security boundary

Hosted mode is Codex-only and proxy-authenticated. Pican’s mounted HTTP server accepts the private
proxy credential rather than a browser login, query token, Bearer token, or Pican cookie. The host
is responsible for browser-facing authentication and for injecting the private header on the
internal hop.

Workspace access passes through the canonical, symlink-aware hosted resolver. Catalog materializes
only native Codex threads whose authoritative working directories are within the fixed workspace,
and direct operations repeat containment checks at their relevant boundaries
([`internal/workspace`](../../internal/workspace),
[`internal/codex/catalog.go`](../../internal/codex/catalog.go)).

The hosted child environment is reduced to process basics and allowlisted `CODEX_*`, `OPENAI_*`,
`GH_*`, and `GITHUB_*` names. The proxy credential and unrelated host/provider secrets are stripped
before the Codex child boundary
([`internal/app/hosted_env.go`](../../internal/app/hosted_env.go)). This filter is name-based:
current Pican trusts the host to place only opaque sentinels, not raw provider credentials, under
the allowlisted names. Pican does not resolve those sentinel values and does not own provider
credential resolution or rotation. Preserving the no-provider-credentials boundary therefore
requires Scotty to withhold raw provider credentials from Pican.

## Recommended hosted design contract

### Ownership

The host (Scotty) owns the workspace and execution environment:

| Concern | Owner | Contract |
|---|---|---|
| Execution-provider selection and provisioning | Scotty | Pican neither selects nor creates the provider runtime. |
| Fixed workspace identity and canonical root | Scotty | One hosted Pican mount maps to one workspace root. |
| Workspace sleep and stop | Scotty | Pican may shut down cleanly but does not decide provider sleep. |
| Workspace resume, restore, and backup | Scotty | Scotty restores the complete workspace/state before starting Pican. |
| Provider and repository credentials | Scotty | Raw provider credentials are not exposed to Pican. |
| Workspace deletion and final teardown | Scotty | Pican never deletes the workspace, provider runtime, backups, or host record. |

Pican owns the application inside that boundary:

- discovering and reconciling contained Codex threads;
- projecting native Codex threads into Pican Sessions;
- listing, creating, selecting, switching, viewing, and operating on Threads;
- chat, cancel/steer, model/effort controls, approvals/questions, transcript projection, files, and
  Git views supported by the hosted product; and
- individual Thread lifecycle operations that Pican supports and authorizes within containment,
  such as rename, fork/clone, archive, or delete.

Individual Thread deletion is not workspace deletion. A destructive Thread operation must target
one resolved contained Thread and must never trigger provider teardown or removal of the fixed
workspace.

### Identity and create semantics

The durable identity model is:

```text
host workspace identity
  ├─ Pican projection/session ID A ↔ native Codex thread ID A
  ├─ Pican projection/session ID B ↔ native Codex thread ID B
  └─ …
```

The host identity authenticates and locates the workspace. Each projection/native pair identifies
one Thread inside it. Neither per-Thread ID replaces the workspace identity.

Every create request has its own idempotency key and normalized fingerprint. The mapping persisted
for that request is one `{pican session ID, native Codex thread ID}` pair. Replaying the request
must converge on that pair; a new create request may produce a new pair. No create key becomes a
global “bound Thread” field for the workspace.

The selected Thread may be represented in navigation state or a deep link using the Pican
projection/session ID. Missing selection should open the Thread list or a documented default view.
A stale or deleted selection should report that Thread as unavailable and return to the list; it
must not rebind the workspace or silently substitute the newest native thread.

### Hosted UI and routes

The hosted UI must include:

- a Thread list containing the visible, contained Codex Threads;
- a create-Thread action;
- explicit Thread selection;
- switching between Threads without leaving the hosted workspace; and
- a Thread view with the supported conversation and workspace tools.

All hosted user-facing labels, empty states, navigation, confirmations, and errors use “Thread.”
Internal Session symbols remain unchanged.

The route contract remains a catalog application rather than a bound-only artifact:

| Surface | Design contract |
|---|---|
| Hosted mount root | Show the Thread list and create/select affordances for the fixed workspace. |
| Thread deep link | Select exactly one projection ID, currently expressible as `/session?id=<pican-session-id>`. |
| Catalog API | Return only Threads authorized within the fixed workspace. |
| Create API | Create another contained Codex Thread with a request-scoped idempotency key. |
| Thread APIs and SSE | Resolve the selected projection/native pair and enforce workspace containment. |
| Thread lifecycle APIs | Operate on one resolved contained Thread; never mutate workspace lifecycle. |

The exact future URL shape may evolve, but routes must support list/create/select/switch and stable
deep links. Do not ship a separate bound-only frontend artifact, bound-only application profile,
or startup field that makes one Thread the only reachable product.

### Security and authorization

The following are invariants, not optional UI behavior:

1. Hosted runtime registration is Codex-only.
2. One canonical, fixed workspace resolver contains catalog entries and every filesystem or
   working-directory operation.
3. Browser users authenticate to Scotty; Pican accepts only the private proxy-authenticated
   internal hop.
4. Scotty owns provider credentials. Pican receives no raw provider credential, does not resolve
   opaque credential sentinels, and does not return credential material in state, responses, or
   logs.
5. Every ID-bearing operation resolves the Pican projection to its native Codex identity and
   verifies the authoritative working directory is contained before reading or mutating it.

Authentication grants access to the hosted workspace, not to a secretly bound Thread. Authorization
still filters every list result and direct Thread operation to the same workspace. A valid Thread
ID from another workspace must fail even if the caller guesses it or puts it in a deep link.

Scotty may additionally apply workspace-level user/tenant authorization before proxying. That host
decision must not be encoded as a single-Thread allowlist inside Pican.

### Restore and recovery

Scotty checkpoints and restores the workspace as a unit, including the Pican state needed for
projection and idempotency records and the Codex state needed for native threads. On restart,
Pican must:

1. start against the same canonical workspace and contained state root;
2. reconcile all visible contained Codex threads, not only the bootstrap-created thread;
3. preserve each projection/native identity mapping;
4. recover interrupted create records according to the existing idempotency state machine; and
5. allow a requested deep link to reselect its Thread after reconciliation.

Recovery must not pick the newest rollout as a workspace binding, discard other contained Threads,
or require the bootstrap Thread to exist before the catalog is usable. If one Thread is missing or
unrecoverable, surface that Thread’s failure while leaving the rest of the workspace catalog
available.

Pican can gracefully stop workers and flush its own state when Scotty requests checkpoint or
shutdown. Pican does not initiate provider backup, sleep, resume, restore, credential reseeding, or
workspace deletion.

### Performance contract

Hosted performance work should optimize the actual multi-Thread product: catalog reconciliation,
time to authenticated list, time to selected Thread, incremental switching, and idle work. It must
not claim savings by removing the catalog, compiling a bound-only frontend, or budgeting resources
around one permanent Thread.

Record measurements with the implementation and environment that produced them. Do not preserve
stale bundle, binary, container, or provider-billing measurements in this design contract.

## Tests and acceptance

### Pican acceptance

- Standalone still exposes the complete product/catalog, all supported runtimes, and supported
  features.
- Hosted startup rejects non-Codex runtime selection, non-proxy authentication, non-absolute or
  outside-workspace state roots, and invalid mounts.
- Hosted catalog reconciliation includes multiple in-workspace Codex threads and excludes
  outside-workspace and symlink-escape threads.
- Two create requests with different keys can create two Threads in one workspace; replaying either
  key returns only that request’s stable projection/native pair.
- The hosted UI lists, creates, selects, deep-links, and switches among Threads using “Thread” in
  user-facing copy while existing Session API/symbol names remain compatible.
- Chat, files, Git, SSE, and individual Thread lifecycle handlers reject a valid ID whose
  authoritative cwd is outside the fixed workspace.
- Deleting or archiving one Thread leaves the workspace and other Threads intact.

### Scotty integration acceptance

- Bootstrap may create one initial Thread, then the same mounted product can create and reconcile
  additional Threads without provisioning another workspace.
- Scotty authenticates the browser, strips browser credentials, and injects only the private proxy
  header to Pican.
- Scotty selects and provisions the execution provider, supplies opaque credential access to Codex
  without exposing raw provider credentials to Pican, and owns credential rotation.
- Checkpoint/restore preserves the full contained Thread catalog and every stable projection/native
  mapping; a deep link reopens its selected Thread without becoming a workspace binding.
- Sleep, resume/restore, and workspace deletion operate once at workspace scope and are never
  triggered by Pican Thread lifecycle endpoints.

## Decision

Hosted Pican is a Codex-only, proxy-authenticated, fixed-workspace deployment of the catalog
product. The workspace contains many Threads. Scotty owns provider and workspace lifecycle; Pican
owns the contained Thread experience and may manage individual Thread lifecycle. A startup-created
Thread, idempotency key, selected row, or deep link never narrows the product to one immutable
conversation.
