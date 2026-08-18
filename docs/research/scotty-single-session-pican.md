# Lean single-session Pican for Scotty

Research date: 2026-07-28

This note distinguishes current behavior from a recommended design. The sources are the current
Pican checkout at `d3d4de66eba3d79e443217fb1617a98e64a20215` and the current Scotty checkout at
`32282d4ef6a05a58978d4a43daa2bf7e12f501e5`. The application boundary comes from those primary
sources. Current Cloudflare lifecycle and billing implications are checked against Cloudflare's
official Containers and Sandbox documentation.

## Bottom line

Scotty should not embed Pican's general session catalog and then try to make it look like a single
session with navigation changes. It should launch an explicit bound-session backend profile and
serve a separate bound-session frontend artifact.

The bound profile has one durable identity pair:

- `picanSessionId` is Pican's projection ID and is the only ID accepted by the bound HTTP surface.
- `codexThreadId` is the native Codex thread ID used for native resume, rollout selection, and
  beam-down.

Scotty remains authoritative for repository preparation, provider runtime, workspace backup,
sleep/resume, hard cap, and destruction. Pican remains authoritative for the bound Codex
conversation, chat/steer/cancel, transcript projection, model/effort controls, files, diff, and the
session UI. Neither side may silently switch the binding to a newly created, forked, archived, or
deleted session.

This is a new profile, not a replacement for standalone or today's hosted profile. Keep the
existing hosted behavior during migration.

## What Amp Orbs teaches this design

### Confirmed product behavior

Amp treats a thread as the primary task object: its manual recommends one thread per task, and an
orb thread gets its own remote machine
([Amp manual](https://ampcode.com/manual#how-to-prompt),
[Orbs manual](https://ampcode.com/manual/orbs#what-are-orbs)). The binding is explicit enough that
an orb can mint workload identity containing the workspace, project, user, and thread
([Orbs manual](https://ampcode.com/manual/orbs#oidc-workload-identity)). That supports Scotty's
immutable `{scotty session, pican projection, Codex thread}` identity instead of a broad Pican
catalog that happens to have one selected row.

Amp also separates the conversation from workspace tool planes. Officially, users can review a
thread's changes and browse its files without syncing, open a shell that shares the agent's
filesystem and working copy, and open authenticated development servers from the thread's Portal
tab
([Orbs manual](https://ampcode.com/manual/orbs#features),
[Orbs manual](https://ampcode.com/manual/orbs#portals)). Changes are scoped to the thread and can be
reviewed directly on desktop or mobile; Amp also provides a command-palette action that opens the
current thread's diff in the browser
([Amp Diffs](https://ampcode.com/news/diffs)). Amp's web UI can likewise open and remote-control
threads on desktop or mobile
([Agents, Everywhere](https://ampcode.com/news/agents-everywhere)). The lesson for Scotty is to
deep-link directly to the bound task and expose conversation, Changes, Files, Terminal, and Portal
as sibling views over that task's one workspace, not as navigation to unrelated Pican sessions.

### UI inference from the supplied screenshot

The screenshot presents `Changes`, `Files`, `Terminal`, `Portal`, and `Desktop` as adjacent tabs
beside one conversation. This visually reinforces the two-plane model: conversation is the task
timeline, while the tabs are views or controls over its execution environment. The official
sources above confirm Changes, file browsing, Terminal, Portal, and desktop web access, but they do
not document the pictured `Desktop` tab's behavior. Treat that tab as evidence for information
architecture only, not as evidence that Scotty needs remote-desktop streaming or a particular
implementation.

### What Scotty should not copy

Scotty should not copy Amp's entire orb workspace product into embedded Pican. In particular, do
not add Amp-style project/activity feeds, collaboration, generic terminal multiplexing,
portal orchestration, or Desktop merely to resemble the screenshot. Scotty already owns the
workspace lifecycle and outer navigation. Pican should remain the lean bound conversation surface;
Scotty may place its existing Changes, Files, terminal, preview, or desktop capabilities beside it
when those capabilities exist. Direct open and per-thread identity are the reusable design
principles. Amp's breadth, naming, and chrome are not requirements.

## Confirmed current behavior

### The two IDs already exist

Pican's hosted create flow starts a native Codex thread, then persists both `projection.ID` and
`projection.NativeID` in the idempotency record
([`internal/server/new_session.go#L157-L188`](../../internal/server/new_session.go#L157-L188)).
The response calls them `id` and `nativeId`
([`internal/server/new_session.go#L296-L304`](../../internal/server/new_session.go#L296-L304)).
For Codex, the projection ID is currently `codex-` plus the native thread ID, but that is an
implementation mapping rather than permission to collapse the two domains
([`internal/codex/projection.go#L420-L427`](../../internal/codex/projection.go#L420-L427)).

Scotty decodes both values
([`worker/src/pican.ts#L54-L79`](../../../scotty/worker/src/pican.ts#L54-L79)), but the Cloudflare
create path stores only `hosted.nativeId` as `codexThreadId`
([`worker/src/session.ts#L495-L512`](../../../scotty/worker/src/session.ts#L495-L512)). The runner
path makes the same reduction
([`worker/src/session.ts#L698-L715`](../../../scotty/worker/src/session.ts#L698-L715),
[`worker/src/session.ts#L777-L782`](../../../scotty/worker/src/session.ts#L777-L782)).
`SessionRecord`, its projection/view, and the beam-down manifest have no Pican projection ID
([`worker/src/contracts.ts#L91-L175`](../../../scotty/worker/src/contracts.ts#L91-L175),
[`worker/src/contracts.ts#L203-L212`](../../../scotty/worker/src/contracts.ts#L203-L212)).

That identity loss explains why a Scotty URL opens Pican's home. The current SPA renders
`SessionsPage` at `/` and `SessionPage` only at `/session?id=<pican-session-id>`
([`web/src/App.svelte#L88-L108`](../../web/src/App.svelte#L88-L108)). A mounted URL must therefore
be `/s/<scotty-id>/session?id=<picanSessionId>`, not only `/s/<scotty-id>`.

### Hosted mode narrows runtimes, not the application

Pican hosted configuration already requires an absolute workspace/state root, proxy
authentication, and runtime `codex`
([`internal/app/config.go#L101-L133`](../../internal/app/config.go#L101-L133)). `app.Run` builds
only the Codex runtime registration in hosted mode
([`internal/app/app.go#L206-L261`](../../internal/app/app.go#L206-L261)). Scotty reinforces that
contract in its launch command and environment
([`worker/src/pican.ts#L7-L13`](../../../scotty/worker/src/pican.ts#L7-L13),
[`worker/src/pican.ts#L156-L184`](../../../scotty/worker/src/pican.ts#L156-L184)).

The backend remains broad. `server.New` always opens and migrates the general SQLite schema,
creates push support, starts file/workflow/task/status watchers, starts the status sweeper and
scheduler, and starts the autonomous chat queue drainer
([`internal/server/server.go#L231-L353`](../../internal/server/server.go#L231-L353),
[`internal/server/server.go#L356-L419`](../../internal/server/server.go#L356-L419)). `Register`
then installs the home, settings, catalog, session creation/fork/clone/rename/archive/delete,
peers, scratchpad, schedules, workflows, tasks, subagents, metrics, pprof, sounds, and
update surfaces alongside the session APIs
([`internal/server/server.go#L437-L509`](../../internal/server/server.go#L437-L509)).

The frontend is also one general bundle. Vite has one `app` entry at `src/main.ts`
([`web/vite.config.js#L5-L29`](../../web/vite.config.js#L5-L29)); that entry mounts `App`
([`web/src/main.ts#L1-L26`](../../web/src/main.ts#L1-L26)); and `App` statically imports the
sessions, settings, schedules, workflows, tasks, subagents, and session routes
([`web/src/App.svelte#L1-L12`](../../web/src/App.svelte#L1-L12)). Merely returning 404 for broad
backend routes would not remove those modules from the generated asset graph.

The measured build at this Pican SHA contains 313 files under `web/dist`, totaling 11,865,315
bytes raw and 2,482,864 bytes when every file is gzipped independently. The initial app entry is
685,937 bytes raw and 209,531 bytes gzip. The optional `@pierre/diffs` plus Shiki closure accounts
for 10,169,871 bytes raw and 1,952,652 bytes gzip across 309 manifest files; `app-icon.png` alone
is 1,243,291 bytes and is effectively incompressible. The complete local Pican binary is
30,218,178 bytes; Scotty's checked-in Linux Pican binary is 30,671,010 bytes. These are current
measurements, not targets.

The current Go asset boundary embeds all of `web/dist`
([`web/assets_embed.go#L8-L19`](../../web/assets_embed.go#L8-L19)). A separate Vite entry does not
reduce the hosted binary if the hosted build still embeds the full output directory. The bound
artifact therefore needs both a separate Vite output and a Go embed selection that includes only
that output.

### Scotty owns the outer lifecycle

On both providers Scotty prepares the repository and branch, launches Pican with fixed roots,
waits for `/api/settings`, performs idempotent hosted creation, and publishes `warm` only after the
Pican response is stable
([`worker/src/pican.ts#L134-L193`](../../../scotty/worker/src/pican.ts#L134-L193),
[`worker/src/session.ts#L515-L565`](../../../scotty/worker/src/session.ts#L515-L565),
[`worker/src/session.ts#L682-L805`](../../../scotty/worker/src/session.ts#L682-L805)).

Cloudflare resume restores the workspace backup, reseeds sentinel auth, relaunches Pican, and marks
the outer session warm; it does not reselect or validate the original Pican projection
([`worker/src/session.ts#L1182-L1221`](../../../scotty/worker/src/session.ts#L1182-L1221)).
Runner resume similarly ensures the existing runtime and relaunches Pican without rebinding a
session
([`worker/src/session.ts#L986-L1053`](../../../scotty/worker/src/session.ts#L986-L1053)).
Checkpointing stops Pican before `sync` and workspace backup; the fixed state and Codex homes make
the binding recoverable with the workspace.

### Cloudflare cost and lifecycle are separate from browser weight

Scotty currently provisions `standard-2` for the Cloudflare container: one vCPU, 6 GiB memory, and
12 GB disk
([`worker/wrangler.jsonc#L47-L54`](../../../scotty/worker/wrangler.jsonc#L47-L54)). Its Sandbox
class overrides the normal idle timeout to 60 minutes
([`worker/src/session.ts#L263-L268`](../../../scotty/worker/src/session.ts#L263-L268)).

Cloudflare's current pricing bills memory and disk from provisioned resources while CPU is billed
from active usage. Containers stop accruing container charges after going to sleep
([Cloudflare Containers pricing](https://developers.cloudflare.com/containers/pricing/)).
Sandbox files and processes are lost when the container stops, so Scotty's explicit
checkpoint/restore contract remains necessary
([Cloudflare Sandbox lifecycle](https://developers.cloudflare.com/sandbox/concepts/sandboxes/)).
The Sandbox default idle timeout is ten minutes and is configurable with `sleepAfter`; `keepAlive`
disables automatic sleep
([Cloudflare Sandbox options](https://developers.cloudflare.com/sandbox/configuration/sandbox-options/)).

Consequently:

- reducing Pican's bundle, startup work, and idle loops improves browser latency, startup CPU,
  binary/image transfer, and warm idle CPU;
- it does not materially reduce provisioned-memory billing while Scotty remains on `standard-2`;
- moving to a smaller instance is a separate Scotty decision that requires measured Codex peak
  memory, repository build load, and restore behavior. Do not infer it from Pican RSS alone.

## Recommended bound-session backend profile

Add a profile orthogonal to runtime selection, for example
`ProfileStandalone | ProfileHostedCatalog | ProfileHostedBoundSession`. Do not infer it from
`ModeHosted`: today's hosted mode is already deployed and changing its meaning would make rollback
unsafe.

The bound profile requires these immutable startup inputs:

```text
workspaceRoot
stateRoot
basePath
proxy auth header + token
runtime = codex
bound Pican projection ID
bound native Codex thread ID
```

The identity pair should be created before the long-running bound server becomes externally
available, or installed through one startup-only bootstrap transition guarded by Scotty's outer
idempotency key. After binding, ordinary HTTP requests cannot replace either ID.

### Bound authorization

Authorization must happen after authentication and before handler dispatch. A handler that accepts
a session ID, native ID, source-session ID, project path, or session-scoped queue key must prove it
matches the bound pair and workspace. Hiding navigation is not authorization.

The minimum invariant is:

```text
resolved projection ID == bound picanSessionId
resolved native ID == bound codexThreadId
resolved canonical cwd is within workspaceRoot
```

Perform the check again after resolving projection/native records so a crafted alias or stale
projection cannot cross the boundary. Requests with another valid in-workspace session ID must
still fail. Treat a missing/deleted bound projection as an explicit unhealthy state, not as a cue
to select the newest session.

Creating, cloning, forking, archiving, unarchiving, deleting, pinning, switching, or renaming the
bound session changes or destroys identity and should not exist in the lean profile. Scotty's outer
vaporize owns destructive teardown. If product requirements later need a fork, create a new Scotty
session with a new immutable identity pair rather than mutating the current binding.

## Retained backend surface

The exact recommended live surface is:

- `GET /session`: render only the bound session shell. A request without `id` redirects internally
  or renders the bound ID; a different `id` is rejected.
- `GET /api/session`: snapshot/pagination for only the bound projection.
- `POST /api/chat`, `POST /api/chat/cancel`, `GET /api/worker-status`, and `GET /api/commands`.
- `POST /api/set-model`, `POST /api/set-thinking-level`, and `GET /api/models`.
- `GET /events` for the bound session's stream.
- `GET /api/files` and `GET /api/git/info`, both still contained by `workspaceRoot`.
- `GET /api/git/diff` only if the embedded product retains a lightweight diff view. The current
  rich diff dependency graph is too large for the lean default.
- The extension UI request/respond endpoints, chat queue endpoint, and Codex interactive
  approval/question support if they are required for full Codex operation.
- `GET /api/settings` only for the settings required by the retained session UI. Make it read-only
  unless a setting is explicitly part of the bound product.
- Hashed JS/CSS/font/image assets needed by the bound frontend.
- A narrow unmounted health/readiness endpoint, or the existing authenticated settings endpoint
  until Scotty migrates.

Chat, cancel, model control, and transcript reads are already session-scoped handlers in the broad
server registration
([`internal/server/server.go#L440-L460`](../../internal/server/server.go#L440-L460)). Retaining them
still requires the new bound check; the current route list alone does not impose it.

## Removed backend surface and services

Do not register:

- `/`, `/api/sessions`, `/api/new-session`, fork, clone, rename, label, Codex archive/unarchive/
  delete, Pican archives, pins, recent locations, projects, peers, settings page, or
  filesystem browsing.
- scratchpad unless the bound-session product explicitly retains it.
- schedules, schedule runs, workflows, tasks, subagents index APIs, metrics dashboard, pprof,
  sounds, push subscription, version/update/restart, and PWA service-worker routes.

Do not initialize:

- push manager and VAPID persistence;
- scheduler and schedule store;
- workflow, task, general session-file, or status-directory watchers;
- global status sweeper;
- broad catalog reconciliation after the bound pair is validated;
- session index cache population;
- project/peer/pin/archive/scratchpad tables;
- update checker, sounds seeding, Tailscale publication, browser opening, or PWA registration;
- global queue draining. If persistent queued chat remains a requirement, run a drainer scoped to
  the bound ID only.

The current unconditional starts are visible in `server.New`
([`internal/server/server.go#L257-L353`](../../internal/server/server.go#L257-L353)); the Pican
profile must prevent constructing them rather than construct-and-disable them afterward.

Codex still needs a worker manager or equivalent one-worker lifecycle for the bound projection,
the Codex app-server client, its transcript projection, and enough reconciliation to recover that
one projection after restart. Replace periodic whole-catalog sync with a bound-thread refresh if
the native adapter can load by thread ID. If it cannot, retain catalog sync temporarily but filter
its published/authorized result to the bound identity and measure its cost.

## Separate bound frontend artifact

Add a second Vite entry such as `src/bound-main.ts` that mounts a `BoundSessionApp`. It should
import `SessionPage` and only the components reachable from the retained session experience. It
must not import `App.svelte`, `SessionsPage`, settings, schedules, workflows, tasks, subagents,
command-palette catalog navigation, pinned-session switchers, new-session controls, fork/clone,
archive/delete controls, version controller, or PWA registration.

Build it as a separately named manifest entry, for example `bound`, and let the bound backend shell
select only that entry. Shared session rendering, chat, diff, Markdown, syntax highlighting, and
file mention modules remain ordinary shared chunks.

This separate entry is necessary for measurable reduction. The current single entry imports every
top-level page before route selection
([`web/src/App.svelte#L1-L12`](../../web/src/App.svelte#L1-L12)); runtime flags or CSS hiding would
retain those imports and can leave mutation code reachable.

The lean default should include the transcript, composer, stop/cancel, worker state, model and
effort controls, slash commands, file mentions, approval/question UI, a compact static title/cwd,
and Git branch/Create PR status if Scotty requires it. It should not import the home router,
pinned-session models, Back/New controls, session tree, Scratchpad/Artifacts sidebar, BTW,
fork/label/model-usage/image/diff modals, version controller, or PWA code.

Use separate build products rather than a runtime boolean:

```text
web/dist                         full Pican output, unchanged
web/dist-bound                   bound-session output only
web/src/main.ts                  full entry, unchanged
web/src/bound/main.ts            bound entry
web/assets_embed.go              full asset FS
web/assets_bound_embed.go        bound-only asset FS
```

The hosted bound binary must link exactly one asset filesystem. If it links both, the user-visible
UI may be smaller but the image and binary will not be.

## Scotty contract

Extend Scotty's record without changing the meaning of existing fields:

```ts
picanSessionId?: string
codexThreadId?: string
```

Persist `hosted.id` and `hosted.nativeId` atomically in both provider create paths. Add
`picanSessionId` as an optional field to record, projection, view, and CLI schemas so existing
version-1 records continue to decode. Keep `codexThreadId` for native operations.

New sessions return and attach to
`/s/<outer-id>/session?id=<encodeURIComponent(picanSessionId)>`. Existing records without the new
field retain the mount-root fallback during the compatibility window; do not derive a projection
ID by adding `codex-` to the native ID.

Before marking a restored session warm, probe the bound-session endpoint and require it to return
the same identity pair. Checkpoint still sends Pican `SIGTERM`, waits, runs `sync`, and backs up the
whole workspace. Beam-down must select the rollout matching `codexThreadId`, not the newest JSONL
under `CODEX_HOME`, because a pre-migration workspace may contain multiple threads.

The outer lifecycle remains:

```text
prepare repo/branch
  -> launch private Pican
  -> idempotently create and persist both IDs
  -> publish warm + bound deep link
  -> graceful Pican stop + sync + backup
  -> provider sleep/stop
  -> restore same workspace + validate same pair
  -> warm
  -> vaporize runtime/backups/credentials/projection
```

## Compatibility and rollout

### Phase 0: measure

Record the current hosted binary size, container compressed/uncompressed size, Pican startup RSS,
goroutine count, open file descriptors, time to authenticated readiness, initial JS transfer, and
time to bound-session interactive. Store results as CI artifacts keyed by Pican and Scotty SHAs.

### Phase 1: identity and deep link

Add optional `picanSessionId` to Scotty, persist both IDs, return the deep link, validate the pair
on restore, and fix beam-down rollout selection. Continue using today's broad hosted Pican.

### Phase 2: authorization profile

Add `ProfileHostedBoundSession` behind an explicit launch argument/environment value. Use the
broad frontend initially, but server-side reject every unbound or removed operation. This proves
the authority boundary independently of bundle work.

### Phase 3: backend service reduction

Construct only the retained route set and dependencies. Keep a temporary feature switch back to
the broad hosted profile for one release. A bound-profile startup failure must not silently fall
back to broad mode.

### Phase 4: separate frontend

Ship the `bound` Vite entry and bound shell. Remove broad chunks from the bound page's asset graph
and enforce budgets in CI. Keep standalone and broad-hosted assets unchanged.

### Phase 5: default and removal decision

Make new Scotty sessions use the bound profile. Continue restoring legacy sessions with the
profile recorded at creation. Remove the broad hosted path only after the compatibility window and
an explicit migration or vaporization policy for old sessions.

## Tests

### Pican

- Hosted create returns stable, distinct projection/native IDs under idempotent replay.
- Bound startup rejects missing, mismatched, deleted, or outside-workspace identity pairs.
- Every retained ID-bearing handler accepts the bound pair and rejects another valid session.
- Every removed route returns 404 or an explicit profile error and causes no mutation.
- The bound profile starts no scheduler, broad watcher, push manager, updater, PWA, or global queue
  drainer. Test constructors with injectable start counters rather than timing guesses.
- SIGTERM drains the bound worker and SQLite writes within the existing Scotty stop bound.
- Restart with the same state root loads exactly the same pair.
- The bound manifest contains only the bound entry and reachable shared chunks. A source-level
  forbidden-import test prevents catalog pages and mutation controls entering the graph.
- Browser E2E loads the direct bound URL, chats, steers/cancels, reconnects SSE, changes model/
  effort, opens files/diff, handles approvals/questions, and never exposes catalog or destructive
  session controls.

### Scotty

- Cloudflare and runner create paths persist both returned IDs atomically.
- Record/projection/view/CLI schemas decode old records without `picanSessionId`.
- Create and attach URLs encode the projection ID and legacy records use only the documented root
  fallback.
- Snapshot/resume preserves and validates both IDs before `warm`.
- A mismatched validation response produces a recoverable failed state, never newest-session
  selection.
- Beam-down chooses the rollout whose thread ID equals `codexThreadId` even when another rollout is
  newer.
- Vaporize removes the provider runtime, backups, credentials, and outer projection without
  calling Pican's removed delete endpoint.
- The same contract suite runs against Cloudflare transport and runner transport.

## Measurable budgets

Capture a baseline first, then enforce relative budgets so the design cannot claim savings by
removing routes while shipping the same artifacts:

- Bound frontend initial compressed JS plus CSS: at most 50% of the broad hosted baseline.
- No bound initial chunk over 250 KiB gzip; lazy diff/highlighting chunks are measured separately.
- Bound asset filesystem: at most 2,000,000 bytes raw, at most 600,000 bytes summed gzip, at most
  80 emitted files, and no raster asset above 100,000 bytes.
- Bound Linux Pican binary: target below 20,000,000 bytes under the same Go toolchain and flags.
  Track the compressed OCI layer separately; do not claim container savings from binary size
  alone.
- Bound backend steady-state RSS: at most 70% of broad hosted RSS after readiness and again after
  one completed turn.
- Background goroutines: at most 50% of broad hosted count, with zero scheduler, broad watcher,
  updater, push, or global-drainer goroutines.
- Authenticated readiness p95: no slower than the broad hosted baseline and target under 2 seconds
  after the container is accepting exec calls, excluding Codex's first network turn.
- Direct-link interactive p95: target under 1 second after readiness on the deployed Scotty path.
- Idle CPU over a five-minute warm window: below 0.5% of one vCPU and no periodic filesystem work
  outside the bound projection/state files.
- Restore correctness: 100 consecutive checkpoint/resume cycles retain both IDs and never select a
  different projection or rollout.

Treat these as proposed acceptance budgets, not measured facts. Phase 0 must publish the baseline
and may revise a target once, with the observed data recorded next to the change.

## Decision

The lean path should be an explicit bound-session product profile with a dedicated dependency
graph and asset graph. The identity addition and deep link are safe first steps, but they do not
create a security or resource boundary by themselves. The boundary is complete only when Pican
authorizes every retained operation against the immutable pair, does not construct broad
background services, and serves a frontend that cannot reach or import catalog mutation flows.
