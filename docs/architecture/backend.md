# Backend Architecture

## Package Layout

```
pican/
├── cmd/pican/
│   └── main.go                 # Thin CLI/environment/version/signal adapter over app.Run
├── web/
│   └── assets_embed.go         # Embeds Vite build output from web/dist
├── internal/
│   ├── agentdir/
│   │   └── agentdir.go         # Resolve ~/.pi/agent dir + the paths pican stores under it
│   ├── app/
│   │   ├── config.go           # Exported reusable Config and mode validation
│   │   ├── cli.go              # CLI/environment adapter
│   │   ├── app.go              # Run lifecycle, dependency wiring, HTTP mux setup
│   │   ├── serve.go            # Context cancellation and graceful HTTP shutdown
│   │   ├── network.go          # Bind host / loopback helpers
│   │   ├── tailscale.go        # Tailscale Serve detection/configuration
│   │   ├── models_cache.go     # Process-wide coalesced cache for Pi model list
│   │   ├── runtime.go          # Runtime mode, Codex service/catalog sync, model aggregation
│   │   ├── browser.go          # Open the default browser at startup
│   │   ├── update.go           # runInstall / runRestart for self-update
│   │   └── state_file_*.go     # pican-state.json + flock helpers
│   ├── frontend/
│   │   └── assets.go           # Vite manifest parsing + static asset handlers
│   ├── ui/
│   │   ├── spa_page.go         # Live SPA shell renderer (RenderAppShell)
│   │   ├── app_script.go       # SPA Vite module URL path + script tag
│   │   ├── session_page.go     # Session page data prep (bootstrap base64 + CSS)
│   │   ├── live_page.go        # Live document shell + theme/font providers
│   │   ├── export.go           # Static export renderer
│   │   ├── auth_page.go        # Auth/token entry page
│   │   ├── pwa.go              # PWA routes: manifest, sw.js, icons, css, cat.webm
│   │   └── embedded/     # Embedded HTML/CSS/assets (shells, styles, export/)
│   ├── auth/
│   │   └── auth.go             # Standalone token and hosted proxy-only middleware
│   ├── basepath/
│   │   └── basepath.go         # Shared live URL prefix and inner-mux mount
│   ├── chat/
│   │   └── request.go          # Multipart chat request parser (text + images)
│   ├── files/
│   │   └── files.go            # Bounded read-only dir listing for @mention autocomplete
│   ├── render/
│   │   ├── assets.go           # Vite manifest parsing helpers
│   │   └── json.go             # WriteJSON / WriteJSONError helpers
│   ├── git/
│   │   └── git.go              # git branch info, rename, PR URL detection
│   ├── updater/
│   │   └── updater.go          # Background version checker + changelog fetch
│   ├── claude/
│   │   ├── catalog.go          # Complete/partial native transcript reconciliation
│   │   ├── transcript.go       # Stable read-only permissive JSONL snapshots
│   │   ├── projection.go       # Claude record → deterministic pican entries
│   │   ├── worker.go           # Per-session bidirectional stream-json worker
│   │   ├── process*.go         # Injectable exec boundary + process-tree cleanup
│   │   ├── watcher.go          # Native project fsnotify + debounce
│   │   ├── probe.go            # Bounded installed-CLI version/auth availability
│   │   └── config.go           # Explicit command/home resolution
│   ├── codex/
│   │   ├── client.go           # Concurrent JSONL JSON-RPC app-server client
│   │   ├── rpc.go              # Thread/turn/model protocol calls
│   │   ├── catalog.go          # Thread catalog sync and short-lived operations
│   │   ├── projection.go       # Atomic Codex → session projection materialization
│   │   ├── worker.go           # Resumed per-session app-server worker
│   │   └── types.go            # Stable protocol subset and model mapping
│   ├── opencode/
│   │   ├── client.go           # Authenticated HTTP client + one global SSE demultiplexer
│   │   ├── supervisor.go       # Loopback child lifecycle, health, restart/backoff
│   │   ├── catalog.go          # Native list/read and partial-safe reconciliation
│   │   ├── projection.go       # OpenCode message/part translation
│   │   └── lifecycle.go        # Native create/update/fork/delete service
│   ├── projections/
│   │   └── store.go            # Runtime-neutral identity locks, preservation, migration, atomic JSONL replacement
│   ├── runtimes/
│   │   ├── registry.go         # Ordered descriptors, availability, catalogs, worker dispatch
│   │   └── builtins.go         # Pi/Codex/Claude/OpenCode registrations and explicit capabilities
│   ├── rpc/
│   │   ├── client.go           # JSONL RPC command builders
│   │   ├── worker.go           # pi --mode rpc subprocess worker
│   │   ├── stream.go           # SSE chat-preview stream accumulator
│   │   ├── prompt.go           # OneShotPrompt: spawn pi for a single prompt (auto-title)
│   │   └── oneshot.go          # One-shot RPC for model enumeration
│   ├── server/
│   │   ├── server.go           # Server type, deps, SSE registry, route registration, SQLite open
│   │   ├── handlers.go         # index, runtime-aware session CRUD, models, custom-themes
│   │   ├── runtime.go          # Runtime availability and /api/runtimes
│   │   ├── chat.go             # Chat, set-model, set-thinking, worker-status, commands handlers
│   │   ├── new_session.go      # New-session creation logic
│   │   ├── workspace.go        # Hosted workspace enforcement at server boundaries
│   │   ├── git.go              # /api/git/info, /api/git/rename-branch handlers
│   │   ├── diff.go             # /api/git/diff handler
│   │   ├── files.go            # /api/files handler + per-cwd file-walk cache
│   │   ├── settings.go         # Server-backed user settings (/api/settings) + SPA shell helpers
│   │   ├── auto_title.go       # Auto-title sessions via OneShotPrompt; title-once default, on-demand regenerate, guards against clobbering user names
│   │   ├── auto_title_heuristic.go # Heuristic fallback title from first user message
│   │   ├── metrics.go          # /metrics + /api/metrics + pprof registration (gopsutil sampler)
│   │   ├── projects.go         # Project visibility prefs: list/toggle/register + index filtering (SQLite)
│   │   ├── archives.go         # Runtime-neutral local session archive metadata and API
│   │   ├── push.go             # PushManager: VAPID, subscribe/unsubscribe, NotifyDone
│   │   ├── workflows_api.go    # Read-only workflow list/detail handlers
│   │   ├── subagents_api.go    # Merge child sessions with parent spawn/result records
│   │   ├── workflows_watcher.go # fsnotify + polling workflow run updates
│   │   ├── update.go           # /api/version, check-update, update, restart handlers
│   │   ├── events.go           # SSE endpoint (/events)
│   │   ├── sse_format.go       # SSE event framing helper
│   │   ├── watcher.go          # fsnotify + polling file watcher
│   │   ├── status.go           # Running-status computation logic
│   │   ├── status_sweeper.go   # Periodic status revalidation
│   │   └── status_watcher.go   # fsnotify on session-status/ dir
│   ├── sessions/
│   │   ├── session.go          # Session/SessionSummary structs, ParseFile, LoadAll, CreateSessionFile, RenameSession, fork/clone
│   │   ├── title.go            # ReadTitleInputs: extract auto-title source text from a session
│   │   ├── cache.go            # Modtime-aware session cache
│   │   └── lookup.go           # Resolve session by ID
│   ├── sessioncreate/
│   │   └── store.go            # Durable hosted create/idempotency state machine
│   ├── workspace/
│   │   └── containment.go      # Canonical symlink-aware hosted containment resolver
│   └── workers/
│       └── manager.go          # ChatWorker lifecycle: create, cache, reap
```

> The embedded standalone export bundle lives at `internal/ui/embedded/export/`
> (`app/*.js` + `vendor/`), **not** at `internal/ui/export/`.

## Key Types

### `server.Server`

Central state holder. Created once at startup, lives for the process lifetime.

```go
type Server struct {
    agentDir      string          // ~/.pi/agent (respects PI_CODING_AGENT_DIR)
    sessionsDir   string          // ~/.pi/agent/sessions
    clients       []*sseClient    // active SSE connections
    clientsMu     sync.RWMutex
    fileMod       map[string]time.Time  // last seen modtime per session
    fileModMu     sync.RWMutex
    chatSender    ChatSender      // workers.Manager
    cache         *sessions.Cache // modtime-aware parse cache
    auth          *auth.Middleware
    now           func() time.Time
    renderExportSession func(s sessions.Session, theme string) string
    renderAppShell      func(w io.Writer, bootstrap string) error
    models              func(ctx context.Context) (json.RawMessage, error)
    lastKnown     map[string]struct{} // sessions currently broadcast as running
    lastKnownMu   sync.Mutex
    push          *PushManager    // web-push subscriptions + done notifications
    db            *sql.DB         // SQLite (~/.pi/agent/pican.sqlite)
    updater       *updater.Checker // optional; nil disables /api/version etc.
    runInstall    func(ctx context.Context) error // optional self-update install
    runRestart    func() error                    // optional self-update restart
    updateMu      sync.Mutex      // serializes install/restart
    stopCh        chan struct{}
    stopOnce      sync.Once
    wg            sync.WaitGroup

    fileWalk     *fileWalkCache  // bounded dir-listing cache for @mention autocomplete
    fileWalkOnce sync.Once

    startedAt      time.Time      // process uptime for the metrics dashboard
    metricsSampler processSampler // swappable in tests
    metricsCPUMu   sync.Mutex
    metricsCPULast map[int]cpuMark // per-PID CPU baselines for delta %CPU

    titleMu        sync.Mutex             // auto-title bookkeeping (see auto_title.go)
    titleInFlight  map[string]bool
    titledName     map[string]string      // sessID -> title pican last set
    titledCount    map[string]int         // sessID -> user-msg count at last titling
    titleUserOwned map[string]bool        // sessID -> user named it; never auto-title
}
```

`Deps` (passed to `New`) supplies everything wired from `internal/app`: the
`RenderExportSession` and `RenderAppShell` renderers, `Models`, `Cache`, `Auth`,
`ChatSender`, the selected startup-owned `RuntimeRegistry`, configured `ClaudeHome`, the narrow
`ClaudeService` fresh-projection creator, and the separate `CodexService` lifecycle adapter. Legacy runtime fields remain accepted for
source compatibility. When
`Updater` is nil the version/update routes are not registered; when
`RunInstall`/`RunRestart` are nil the corresponding endpoints respond `503`.

On `New`, the server opens (and migrates) a SQLite database at
`~/.pi/agent/pican.sqlite` with tables for settings, project preferences,
session pins, local session archive, peer hosts, and chat queues. An enabled
`project_prefs` row whose source is
`registered` is the tracked-project contract. `session_archives` is strictly
pican-local presentation state and never mutates runtime-native state. See
`projects.go`, `pins.go`, `archives.go`, and `settings.go`. The pool is capped to a single
connection (`SetMaxOpenConns(1)`) so concurrent writers queue instead of failing
with "database is locked". A `PushManager` (when configured) persists web-push
subscriptions and VAPID keys under the agent dir.

### `sessions.Session`

The domain model for a session file. The scalar fields live on `SessionSummary`
(reused for the index, where entries aren't parsed); `Session` embeds it and adds
the full header + entries.

```go
type SessionSummary struct {
    ID                 string
    SessionUUID        string
    Filename           string
    Project            string
    LastActivity       string
    Name               string
    MessageCount       int
    TokenTotal         int
    CostTotal          float64
    Model              string  // last-known model from messages or model_change
    ModelProvider      string  // provider for the last-known model
    Runtime            string  // pi (default) or codex
    NativeID           string  // authoritative Codex thread id, when applicable
    ChatAvailable      bool
    ChatDisabledReason string
}

type Session struct {
    SessionSummary
    Header  map[string]any   // type=="session" line
    Entries []map[string]any // all JSONL lines
}
```

### `runtimes.Registry`

The app registers Pi, Codex, Claude, and OpenCode in deterministic startup order, then selects an enabled subset from the CLI. IDs are open validated strings (`[a-z][a-z0-9-]*`, without trailing or repeated hyphens), so the registry is extensible without making unregistered runtimes usable.

```go
type Registration struct {
    Descriptor        Descriptor
    AvailabilityProbe AvailabilityProbe
    Catalog           CatalogAdapter // required for replaceable projections
    WorkerFactory     workers.Factory // required when Chat is true
}

type Descriptor struct {
    ID             ID
    Label          string
    Command        string
    Version        string
    ProjectionMode ProjectionMode // append-only-native | replaceable-projection
    Capabilities   Capabilities
}

type CatalogResult struct {
    SessionIDs []string
    Complete   bool // absence may authorize pruning only when true
}
```

`Registry` owns validated registration order and dispatch metadata, not active workers or native session lifecycle. Registration rejects duplicate IDs, missing probes, chat without a factory, and replaceable projection without a catalog. `List` and `IDs` preserve registration order; `Open` distinguishes malformed IDs from well-formed but unregistered IDs. The selected registry passed to the server contains only CLI-enabled registrations.

| Concern | Owner |
|---|---|
| Registration order, descriptor, capability declaration, probe/catalog/factory binding | app startup + `runtimes.Registry` |
| CLI selection and per-runtime model loaders | `internal/app` |
| Catalog schedule, timeout, and completeness downgrade on error | app-owned `catalogSyncer` per selected replaceable runtime |
| Claude native scan, partial-safe pruning, per-file refresh, and debounce | `internal/claude.Catalog` + `Watcher` |
| Claude CLI/auth availability (independent of cached projection readability) | bounded cached `internal/claude.Probe` |
| OpenCode health, authenticated HTTP, global SSE, bounded restart/recovery | supervised `internal/opencode` service |
| Worker reuse, single-flight creation, crash eviction, cancellation/shutdown, 10-minute reap | `workers.Manager` |
| Pi append-only transcript and `session_info` metadata | Pi/session pipeline; unchanged |
| Codex native thread | Codex under `~/.codex` |
| Claude native transcript | configured `<claude-home>/projects/*/*.jsonl`, strictly read-only |
| OpenCode native session/message state | supervised OpenCode server/API |
| Replaceable projection filesystem mechanics | `projections.Store` under `~/.pi/agent/sessions` |
| Codex item translation and sparse captured tool-turn retention | Codex adapter |
| Codex archive/delete/unarchive and native rename/fork semantics | separate `CodexService`, not the common registry |
| Live session/API/SSE behavior | `server.Server` |
| Static export rendering | `internal/ui` export path; no runtime registry or worker dependency |

Production dispatch is:

```text
CLI → app Pi/Codex/Claude/OpenCode registrations → parse selection → selected runtimes.Registry
                                      ├─ server.New(RuntimeRegistry)
                                      │    └─ /api/runtimes + projection policy
                                      └─ workers.Manager factory
                                           └─ ParseFile → enabled? → Registry.NewWorker
                                                ├─ Pi workers.Factory
                                                ├─ Codex workers.Factory
                                                ├─ Claude: installed-CLI stream-json factory
                                                └─ OpenCode: lightweight worker over shared HTTP/SSE
```

Tests substitute registrations, probes, catalogs, and factories directly; server tests may also use the legacy `Deps` fields through the compatibility builder. This keeps tests process-free while proving order, validation, availability, completeness, dispatch, API metadata, and projection-mode behavior.

### Compatibility boundary

Wave 1 preserves the public Pi/Codex surface while moving internals to the registry:

- CLI `pi`, `codex`, `claude`, `opencode`, and exact legacy alias `both` work; comma-separated registered IDs are additive. `both` remains exactly Pi+Codex. Selection is case-normalized, deduplicated, and emitted in registration order. Unknown or malformed IDs fail startup.
- `server.Deps.RuntimeRegistry` is the canonical path. Legacy `EnabledRuntimes` and `RuntimeAvailable` remain source-compatible for existing tests/embedders and are converted to a Pi/Codex-only compatibility registry. Legacy defaulting still prefers Pi; a supplied registry defaults to its first registration. An explicit default outside the registry is rejected.
- `/api/runtimes` retains `defaultRuntime`, `id`, `available`, optional `reason`, and the existing capabilities object. It adds `label`, `command`, optional `version`, `projectionMode`, and the complete capability set. Entries retain selected registry order; frontend parsing keeps the new metadata optional and falls back to translated/runtime IDs for labels.
- Missing persisted runtime metadata still means Pi. Persisted Pi/Codex/Claude/OpenCode sessions remain viewable when their runtime is disabled; runtime-dependent actions use availability to fail clearly. Unknown persisted runtimes take the conservative replaceable/full-reconcile path.
- `ChatWorker` retains one runtime-specific native abort operation. `workers.Manager` additionally reserves accepted sends before worker creation and exposes a non-creating `AbortExisting` lookup so Stop can cancel the startup window or survive a replaceable-projection race.

### Runtime operation boundary

Runtime-dependent HTTP handlers authorize operations from the selected registry descriptor, never from request-body capability data or frontend state. A declared-but-unsupported operation returns `409` with the stable form `<label> runtime does not support <operation>`; a supported operation whose runtime probe is unavailable returns `503` with the current availability reason. Session-scoped endpoints resolve the persisted session first, so a caller cannot use a conflicting runtime query to select a different model or mutation path.

Create, fork, clone, rename, delete, chat/steer, cancel, persistent queue operations, model listing/switching, effort/reasoning selection, slash commands, file/image attachments, and auto-title all cross this boundary. OpenCode lifecycle dispatch uses its native create/update/fork/delete endpoints; unsupported native archive, steer, queue, attachment, effort, and interaction paths fail closed before dispatch. Labels and runtime-neutral local Archive are pican-owned metadata outside runtime dispatch.

`/api/session` additively returns the trusted `runtimeLabel`, complete `capabilities`, `projectionMode`, and a server-built `resumeCommand`. Resume commands are emitted only for known runtime argument contracts, including `<opencode-command> --session <native-id>`, and every shell argument is quoted by the server. The live frontend uses these fields to remove or disable unsupported actions. Static export still renders only persisted data and does not receive or consult the registry.

### `workers.Manager`

Manages runtime-specific subprocesses per session. Its factory reads validated session metadata and dispatches through `runtimes.Registry`; the manager owns reuse, single-flight creation, error eviction, accepted-send reservations, per-send cancellation, and the shared 10-minute idle reap policy. `AbortExisting` cancels pending sends first and then interrupts a cached worker if present. It never calls the factory.

```go
type Manager struct {
    mu         sync.Mutex
    workers    map[string]ChatWorker  // sessionID → worker
    creating   map[string]*createCall // single-flight: coalesce concurrent creates per session
    factory    Factory                // (sessionID, sessionPath) → ChatWorker
    idleTTL    time.Duration          // default 10m
    reaperStop chan struct{}
    reaperDone chan struct{}
}
```

`Manager.Snapshot()` returns one `WorkerSnapshot` per live worker (session ID,
state, model, plus PID/uptime/idle for workers implementing the optional
`inspector` interface). The metrics dashboard consumes it — see
`docs/dev/metrics-dashboard.md`.

### Runtime workers

`rpc.piRPCWorker` owns one `pi --mode rpc` subprocess and communicates via Pi's JSONL RPC. `codex.Worker` owns one `codex app-server --stdio` process. `claude.Worker` owns one installed `claude` bidirectional stream-json process. OpenCode uses one supervised authenticated loopback child and global SSE stream; each active session receives a lightweight `ChatWorker` that shares that service and validates canonical cwd/native identity. The manager retains single-flight creation, pending-send cancellation, crash eviction, and idle reaping. Runtime capabilities still gate unsupported queueing, steering, settings, and commands independently.

The Codex worker consumes ordered app-server notifications, emits preview/status callbacks, and atomically refreshes the projection. It never treats projected JSONL as authoritative conversation state. See [codex-runtime.md](./codex-runtime.md).

### `projections.Store`

`projections.Store` is scoped to one sessions directory and runtime ID. Its authoritative identity key is `(physical sessions root, runtime, native ID)`, so replacement, local metadata mutation, and cwd-driven duplicate migration serialize even when the projection's filepath changes. It validates runtime/native identity against both the filename and session header before discovery, mutation, duplicate deletion, or removal. A corrupt target fails closed rather than being overwritten.

`Store.Replace` canonicalizes cwd, gathers the target plus validated duplicates, reads and deduplicates pican-owned `session_info`, `label`, `model_change`, and `thinking_level_change` entries, invokes the runtime adapter's projection builder under the identity lock, validates the replacement header, atomically commits the JSONL with file and directory fsync, and only then removes revalidated duplicates. Identical bytes are a no-op so file watchers do not emit false reloads. Codex delegates these mechanics to the store while retaining its native metadata extraction, item translation, turn mapping, and sparse captured tool-turn merge inside `internal/codex`.

Claude uses the same projection store but keeps native parsing, translation, and stream-json lifecycle inside `internal/claude`. A complete catalog scan may remove validated Claude projections absent from native membership, except a `claudeFresh` creation intent awaiting its first prompt. Malformed lines, incomplete tails, concurrent appends, per-file failures, and per-file watcher refreshes make the pass partial and prohibit pruning. Unknown valid records retain opaque `claudeRaw`; deterministic entry IDs derive from native session/record/block identity. Live stdout is transient: result handling retries read-only native refresh until the matching `claudeMessageId` is projected, then retires the preview and publishes reload without persisting stdout content.

OpenCode also uses the shared store. Its adapter translates API session/message/part data while preserving raw native payloads where useful. One complete authenticated list/read reconciliation may prune absent validated OpenCode projections; partial lists, reads, cwd mismatches, child failure, and recovery never prune. Shared SSE events trigger affected-session reads and projection replacement rather than becoming a second persisted transcript.

The Pi worker shape is:

```go
type piRPCWorker struct {
    mu                   sync.Mutex
    writeMu              sync.Mutex
    sessionPath          string
    startedAt            time.Time // process start; feeds metrics uptime
    cmd                  *exec.Cmd
    stdin                io.WriteCloser
    status               workers.WorkerStatus
    seq                  atomic.Uint64
    pending              map[string]chan response  // in-flight RPC calls
    currentModel         string
    currentProvider      string
    currentThinkingLevel string
    stderrBuf            *strings.Builder
    commands             []workers.SlashCommand // cached get_commands result
    commandsCached       bool
    lastActive           atomic.Int64 // unix nanos; user-initiated actions
    lastStreamActivity   atomic.Int64 // unix nanos; stream events keep worker visually running
    streamSink           StreamEventSink
    streamPreview        *streamPreviewAccumulator
}
```

## HTTP Handler Map

| Route | Method | Handler | Description |
|-------|--------|---------|-------------|
| `/` | GET | `handleIndex` | Render SPA shell for the sessions route |
| `/session` | GET | `handleSession` | Render SPA shell for the session route |
| `/settings` | GET | `handleSettingsPage` | Render SPA shell for the settings route |
| `/login` | GET | `handleAppShell` | Render SPA shell for the login route |
| `/api/session` | GET | `handleApiSession` | JSON session data, including additive `projectionMode` reconciliation metadata |
| `/api/sessions` | GET | `handleApiSessions` | JSON session summaries; explicit `home`, `all`, `archived`, and exact-project scopes |
| `/api/chat` | POST | `handleChat` | Send chat message (multipart) |
| `/api/chat/cancel` | POST | `handleCancelChat` | Abort running chat worker |
| `/api/set-model` | POST | `handleSetModel` | Change model for session |
| `/api/set-thinking-level` | POST | `handleSetThinkingLevel` | Change thinking level |
| `/api/models` | GET | `handleAvailableModels` | List models for `runtime` or session `id` |
| `/api/runtimes` | GET | `handleRuntimes` | Ordered configured runtime descriptors, capabilities, and current availability |
| `/api/worker-status` | GET | `handleWorkerStatus` | Get worker state for session |
| `/api/commands` | GET | `handleCommands` | List slash commands exposed by the session worker |
| `/metrics` | GET | `handleMetricsPage` | Worker metrics dashboard (self-contained HTML) |
| `/api/metrics` | GET | `handleMetrics` | JSON snapshot: process, SSE stream/heartbeat/error observability, and per-worker CPU/RSS (gopsutil); see `docs/dev/metrics-dashboard.md` |
| `/api/debug/pprof/` | GET | `pprof.Index` (+ cmdline/profile/symbol/trace) | Go runtime profiler, auth-gated (`/api`-stripped before Index) |
| `/events` | GET | `handleEvents` | SSE stream |
| `/api/new-session` | POST | `handleNewSession` | Create new session file |
| `/api/fork-session` | POST | `handleApiForkSession` | Fork a session into a new file |
| `/api/clone-session` | POST | `handleApiCloneSession` | Clone a session into a new file |
| `/api/rename-session` | POST | `handleRenameSession` | Append `session_info` rename metadata |
| `/api/regenerate-title` | POST | `handleRegenerateTitle` | Force an on-demand auto-title regenerate (menu action); statement fires the model off the HTTP path |
| `/api/label-session` | POST | `handleLabelSessionEntry` | Append a label to a session entry |
| `/api/recent-locations` | GET | `handleRecentLocations` | List known project paths |
| `/api/files` | GET | `handleApiFiles` | Bounded file listing for @mention autocomplete |
| `/api/git/info` | GET | `handleGitInfo` | Branch / dirty / PR-URL info for a project |
| `/api/git/rename-branch` | POST | `handleGitRenameBranch` | Rename the current git branch |
| `/api/git/diff` | GET | `handleGitDiff` | Uncommitted working-tree diff (tracked + untracked) for the session cwd |
| `/api/settings` | GET/POST | `handleGetSettings` / `handleSaveSettings` | Server-backed user settings (SQLite) |
| `/api/projects` | GET/POST | `handleApiProjects` / `handleUpdateProject` | List discovered/tracked projects and track/untrack exact persisted paths; legacy visibility actions remain compatible |
| `/api/pins` | GET/POST | `handleListPins` / `handleSetPin` | Ordered session pins (SQLite); pinning also restores a locally archived session |
| `/api/archives` | POST | `handleSetArchive` | Runtime-neutral local archive/restore; archive unpins and rejects running/waiting sessions |
| `/api/peers` | GET/POST | `handleApiPeers` / `handleUpdatePeer` | Registered peer hosts (SQLite); GET never returns tokens, POST upserts (`action:"remove"` deletes) |
| `/api/peers/sessions` | GET | `handlePeersSessions` | Fan out to every peer's `/api/sessions` over Tailscale (3s/peer timeout); see `docs/sequence-flows/peers.md` |
| `/custom-themes.css` | GET | `handleCustomThemes` | User custom theme CSS |
| `/api/push/vapid` | GET | `handleVapid` | VAPID public key (when push enabled) |
| `/api/push/subscribe` | POST | `handleSubscribe` | Register a web-push subscription |
| `/api/push/unsubscribe` | POST | `handleUnsubscribe` | Remove a web-push subscription |
| `/api/workflows` | GET | `handleApiWorkflows` | Read-only workflow run summaries from `<agentDir>/workflows` |
| `/api/workflows/run` | GET | `handleApiWorkflowRun` | Validated workflow run detail (`?runId=wf_…`) |
| `/api/version` | GET | `handleVersion` | Current/latest version (when updater set) |
| `/api/check-update` | POST | `handleCheckUpdate` | Force a version check |
| `/api/update` | POST | `handleUpdate` | Install the latest pican |
| `/api/restart` | POST | `handleRestart` | Restart the service onto the new binary |

PWA / static asset routes (registered outside `Server.Register`):

| Route | Source |
|-------|--------|
| `/manifest.webmanifest`, `/sw.js`, `/icon.svg`, `/icon-maskable.svg`, `/pi-logo.svg`, `/cat.webm`, `/theme.css`, `/index.css`, `/menu.css`, `/palette.css` | `internal/ui/pwa.go` (embedded assets) |
| `/static/assets/app-*.js`, `/static/assets/...` | Embedded Vite SPA bundle and chunks (`internal/app/app.go` + `internal/frontend`) |

## Auth Flow

```
Request ──▶ auth.Wrap(handler)
                │
                ▼
        token set in env?
                │
        ┌───────┴───────┐
        ▼               ▼
      yes              no
        │               │
        ▼               ▼
   extract token    pass through
   (query → Authorization: Bearer → X-Pican-Token → cookie)
        │
        ▼
   constant-time compare
        │
   ┌────┴────┐
   ▼         ▼
 match    mismatch
   │         │
   ▼         ▼
 handler   401 Unauthorized
```

## SSE Broadcasting

The server maintains a slice of `sseClient` structs. Each client subscribes to a `sessID`:

- `__all__` — index and workflows pages subscribe here; receives `new-session`, `status-snapshot`, `status-delta`, and named `workflows-updated` events
- Specific session ID — session page subscribes here; receives `reload` when the file changes and `chat-preview` during streaming

Every accepted stream first receives the compatibility comment `:ok`. A `__all__`
stream then receives its `status-snapshot`; a session stream may receive an
initial error `worker-status`. The server subsequently emits a named
`heartbeat` event about every 15 seconds on either topic:

```text
event: heartbeat
data: {"timestamp":"2026-05-08T09:00:00Z","freshness":"transport-only"}
```

The timestamp is the UTC server tick represented by that heartbeat.
`freshness:"transport-only"` means only that the SSE path was live when the
frame was flushed. It is not conversation or status authority and never
replaces a canonical API refetch.

Broadcasting retains a buffered mailbox of 16 tokens per client. If the client
is slow, keyless events are dropped rather than blocking. Keyed reload,
new-session, workflow/task, worker-status, and chat-preview events retain their
existing coalescing/replacement behavior. Each stream adds one 15-second ticker,
not a goroutine or growing queue; request cancellation, a closed mailbox, or any
write/flush error removes the client and stops the ticker.

`/api/metrics` reports current `sse_clients`, `sse_global_streams`, and
`sse_session_streams`, plus process-lifetime `sse_heartbeats` (successfully
flushed heartbeat frames), `sse_write_errors`, and `sse_flush_errors`. The
counters are bounded atomics rather than per-client history.

## Running-Status Computation

Three signals are OR'd together to determine if a session is "running":

1. **session-status file** (`~/.pi/agent/session-status/<id>`): written by terminal Pi; ignored for replaceable Codex/Claude/OpenCode projections
2. **In-process runtime worker**: `chatSender.Status(id).State == running` (all chat-capable runtimes)
3. **Recent projection/transcript activity**: modtime within the short activity window

Status changes are broadcast as SSE `status-delta` events to `__all__` subscribers. A 1-second sweeper periodically revalidates all known running sessions to clean up stale states.
