# Backend Architecture

## Package Layout

```
pican/
├── cmd/pican/
│   └── main.go                 # Tiny CLI entry point; passes build version to app.Main
├── web/
│   └── assets_embed.go         # Embeds Vite build output from web/dist
├── internal/
│   ├── agentdir/
│   │   └── agentdir.go         # Resolve ~/.pi/agent dir + the paths pican stores under it
│   ├── app/
│   │   ├── app.go              # CLI flags, dependency wiring, HTTP mux setup
│   │   ├── network.go          # Bind host / loopback helpers
│   │   ├── tailscale.go        # Tailscale Serve detection/configuration
│   │   ├── models_cache.go     # Process-wide coalesced cache for Pi model list
│   │   ├── runtime.go          # Runtime mode, Codex service/catalog sync, model aggregation
│   │   ├── browser.go          # Open the default browser at startup
│   │   ├── sounds.go           # Seed default notification sounds into the agent dir
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
│   │   └── auth.go             # Token-based HTTP middleware
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
│   ├── codex/
│   │   ├── client.go           # Concurrent JSONL JSON-RPC app-server client
│   │   ├── rpc.go              # Thread/turn/model protocol calls
│   │   ├── catalog.go          # Thread catalog sync and short-lived operations
│   │   ├── projection.go       # Atomic Codex → session projection materialization
│   │   ├── worker.go           # Resumed per-session app-server worker
│   │   └── types.go            # Stable protocol subset and model mapping
│   ├── runtimes/
│   │   ├── registry.go         # Ordered descriptors, availability, catalogs, worker dispatch
│   │   └── builtins.go         # Pi/Codex registrations and explicit capabilities
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
│   │   ├── git.go              # /api/git/info, /api/git/rename-branch handlers
│   │   ├── diff.go             # /api/git/diff handler
│   │   ├── files.go            # /api/files handler + per-cwd file-walk cache
│   │   ├── settings.go         # Server-backed user settings (/api/settings) + SPA shell helpers
│   │   ├── btw.go              # btw scratch-chat registry: get/new + legacy migration (SQLite)
│   │   ├── auto_title.go       # Auto-title sessions via OneShotPrompt; guards against clobbering user names
│   │   ├── auto_title_heuristic.go # Heuristic fallback title from first user message
│   │   ├── metrics.go          # /metrics + /api/metrics + pprof registration (gopsutil sampler)
│   │   ├── scratchpad.go       # Per-project scratchpad get/save (SQLite)
│   │   ├── projects.go         # Project visibility prefs: list/toggle/register + index filtering (SQLite)
│   │   ├── sound.go            # /api/sounds + /sounds/ asset serving
│   │   ├── push.go             # PushManager: VAPID, subscribe/unsubscribe, NotifyDone, NotifyScheduleDone
│   │   ├── scheduler.go        # Cron tick loop + fireSchedule runner (creates a session, sends instructions)
│   │   ├── schedules_api.go    # /api/schedules + /api/schedule(/run|/runs) handlers
│   │   ├── workflows_api.go    # Read-only workflow list/detail handlers
│   │   ├── subagents_api.go    # Merge child sessions with parent spawn/result records
│   │   ├── workflows_watcher.go # fsnotify + polling workflow run updates
│   │   ├── update.go           # /api/version, check-update, update, restart handlers
│   │   ├── events.go           # SSE endpoint (/events)
│   │   ├── sse_format.go       # SSE event framing helper
│   │   ├── share.go            # Share handler adapter
│   │   ├── watcher.go          # fsnotify + polling file watcher
│   │   ├── status.go           # Running-status computation logic
│   │   ├── status_sweeper.go   # Periodic status revalidation
│   │   └── status_watcher.go   # fsnotify on session-status/ dir
│   ├── sessions/
│   │   ├── session.go          # Session/SessionSummary structs, ParseFile, LoadAll, CreateSessionFile, RenameSession, fork/clone
│   │   ├── title.go            # ReadTitleInputs: extract auto-title source text from a session
│   │   ├── cache.go            # Modtime-aware session cache
│   │   └── lookup.go           # Resolve session by ID
│   ├── schedules/
│   │   └── schedule.go         # Schedule/Run structs, SQLite store, cron next-fire (robfig/cron)
│   ├── share/
│   │   └── share.go            # GitHub Gist creation logic
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
    shareRunner   shareCmdRunner  // overridable in tests
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
`ChatSender`, the selected startup-owned `RuntimeRegistry`, and the separate
`CodexService` lifecycle adapter. Legacy runtime fields remain accepted for
source compatibility. When
`Updater` is nil the version/update routes are not registered; when
`RunInstall`/`RunRestart` are nil the corresponding endpoints respond `503`.

On `New`, the server opens (and migrates) a SQLite database at
`~/.pi/agent/pican.sqlite` with five tables: `scratchpads` (per project path),
`settings` (server-backed user settings key/value), `project_prefs` (which
projects are enabled), `app_settings` (the project-filter master switch, default
off), and `btw_sessions` (the btw scratch-chat registry). See
`projects.go`, `settings.go`, and `btw.go`. The pool is capped to a single
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

The app registers only Pi and Codex in deterministic startup order, then selects an enabled subset from the CLI. OpenCode and Claude are not registered in Wave 1. IDs are open validated strings (`[a-z][a-z0-9-]*`, without trailing or repeated hyphens), so the registry is extensible without making unregistered runtimes usable.

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
| Catalog schedule, timeout, completeness downgrade on error, current Codex availability | app-owned `catalogSyncer` |
| Worker reuse, single-flight creation, crash eviction, cancellation/shutdown, 10-minute reap | `workers.Manager` |
| Pi append-only transcript and `session_info` metadata | Pi/session pipeline; unchanged |
| Codex native thread | Codex under `~/.codex` |
| Codex replaceable projection | Codex adapter under `~/.pi/agent/sessions` |
| Codex archive/delete/unarchive and native rename/fork semantics | separate `CodexService`, not the common registry |
| Live session/API/SSE behavior | `server.Server` |
| Static export/share rendering | `internal/ui` export path; no runtime registry or worker dependency |

Production dispatch is:

```text
CLI → app registrations → parse selection → selected runtimes.Registry
                                      ├─ server.New(RuntimeRegistry)
                                      │    └─ /api/runtimes + projection policy
                                      └─ workers.Manager factory
                                           └─ ParseFile → enabled? → Registry.NewWorker
                                                ├─ Pi workers.Factory
                                                └─ Codex workers.Factory
```

Tests substitute registrations, probes, catalogs, and factories directly; server tests may also use the legacy `Deps` fields through the compatibility builder. This keeps tests process-free while proving order, validation, availability, completeness, dispatch, API metadata, and projection-mode behavior.

### Compatibility boundary

Wave 1 preserves the public Pi/Codex surface while moving internals to the registry:

- CLI `pi`, `codex`, and exact legacy alias `both` still work; comma-separated registered IDs are additive. Selection is case-normalized, deduplicated, and emitted in registration order. Unknown or malformed IDs fail startup, so OpenCode/Claude remain unavailable.
- `server.Deps.RuntimeRegistry` is the canonical path. Legacy `EnabledRuntimes` and `RuntimeAvailable` remain source-compatible for existing tests/embedders and are converted to a Pi/Codex-only compatibility registry. Legacy defaulting still prefers Pi; a supplied registry defaults to its first registration. An explicit default outside the registry is rejected.
- `/api/runtimes` retains `defaultRuntime`, `id`, `available`, optional `reason`, and the existing capabilities object. It adds `label`, `command`, optional `version`, `projectionMode`, and the complete capability set. Entries retain selected registry order; frontend parsing keeps the new metadata optional and falls back to translated/runtime IDs for labels.
- Missing persisted runtime metadata still means Pi. Persisted Pi/Codex sessions remain viewable when their runtime is disabled; runtime-dependent actions use availability to fail clearly. Unknown persisted runtimes take the conservative replaceable/full-reconcile path.
- `ChatWorker` and `workers.Manager` lifecycle contracts are unchanged. Registry dispatch replaces only the hard-coded Pi/Codex factory branch.

### `workers.Manager`

Manages runtime-specific subprocesses per session. Its factory reads validated session metadata and dispatches through `runtimes.Registry`; the manager owns reuse, single-flight creation, error eviction, and the shared 10-minute idle reap policy.

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

`rpc.piRPCWorker` owns one `pi --mode rpc` subprocess and communicates via Pi's JSONL RPC. `codex.Worker` owns one `codex app-server --stdio` process, resumes the projection's native thread ID, and communicates with Codex JSON-RPC. Both implement `workers.ChatWorker`, so chat, queueing, cancellation, model/effort changes, status, metrics, and lifecycle management share the server surface.

The Codex worker consumes ordered app-server notifications, emits preview/status callbacks, and atomically refreshes the projection. It never treats projected JSONL as authoritative conversation state. See [codex-runtime.md](./codex-runtime.md).

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
| `/api/session` | GET | `handleApiSession` | JSON session data |
| `/api/sessions` | GET | `handleApiSessions` | JSON list of session summaries |
| `/api/chat` | POST | `handleChat` | Send chat message (multipart) |
| `/api/chat/cancel` | POST | `handleCancelChat` | Abort running chat worker |
| `/api/set-model` | POST | `handleSetModel` | Change model for session |
| `/api/set-thinking-level` | POST | `handleSetThinkingLevel` | Change thinking level |
| `/api/models` | GET | `handleAvailableModels` | List models for `runtime` or session `id` |
| `/api/runtimes` | GET | `handleRuntimes` | Ordered configured runtime descriptors, capabilities, and current availability |
| `/api/worker-status` | GET | `handleWorkerStatus` | Get worker state for session |
| `/api/commands` | GET | `handleCommands` | List slash commands exposed by the session worker |
| `/metrics` | GET | `handleMetricsPage` | Worker metrics dashboard (self-contained HTML) |
| `/api/metrics` | GET | `handleMetrics` | JSON snapshot: process + per-worker CPU/RSS (gopsutil); see `docs/dev/metrics-dashboard.md` |
| `/api/debug/pprof/` | GET | `pprof.Index` (+ cmdline/profile/symbol/trace) | Go runtime profiler, auth-gated (`/api`-stripped before Index) |
| `/share` | POST | `handleShare` | Create private GitHub Gist |
| `/events` | GET | `handleEvents` | SSE stream |
| `/api/new-session` | POST | `handleNewSession` | Create new session file |
| `/api/fork-session` | POST | `handleApiForkSession` | Fork a session into a new file |
| `/api/clone-session` | POST | `handleApiCloneSession` | Clone a session into a new file |
| `/api/rename-session` | POST | `handleRenameSession` | Append `session_info` rename metadata |
| `/api/label-session` | POST | `handleLabelSessionEntry` | Append a label to a session entry |
| `/api/recent-locations` | GET | `handleRecentLocations` | List known project paths |
| `/api/files` | GET | `handleApiFiles` | Bounded file listing for @mention autocomplete |
| `/api/git/info` | GET | `handleGitInfo` | Branch / dirty / PR-URL info for a project |
| `/api/git/rename-branch` | POST | `handleGitRenameBranch` | Rename the current git branch |
| `/api/git/diff` | GET | `handleGitDiff` | Uncommitted working-tree diff (tracked + untracked) for the session cwd |
| `/api/scratchpad` | GET/POST | `handleGetScratchpad` / `handleSaveScratchpad` | Per-project scratchpad (SQLite) |
| `/api/settings` | GET/POST | `handleGetSettings` / `handleSaveSettings` | Server-backed user settings (SQLite) |
| `/api/btw` | GET | `handleGetBtw` | Resolve the btw scratch-chat session for a parent (SQLite) |
| `/api/btw/new` | POST | `handleNewBtw` | Create a new btw scratch-chat session (SQLite) |
| `/api/projects` | GET/POST | `handleApiProjects` / `handleUpdateProject` | List projects + filter state; enable/disable/register/remove, bulk enable-all/disable-all, enable-filter/disable-filter (SQLite) |
| `/api/pins` | GET/POST | `handleListPins` / `handleSetPin` | Pinned session ids (SQLite); GET reaps pins for deleted sessions, POST upserts/deletes a pin |
| `/api/peers` | GET/POST | `handleApiPeers` / `handleUpdatePeer` | Registered peer hosts (SQLite); GET never returns tokens, POST upserts (`action:"remove"` deletes) |
| `/api/peers/sessions` | GET | `handlePeersSessions` | Fan out to every peer's `/api/sessions` over Tailscale (3s/peer timeout); see `docs/sequence-flows/peers.md` |
| `/api/sounds` | GET | `handleApiSounds` | List available notification sounds |
| `/sounds/` | GET | `handleSounds` | Serve a sound asset (no auth) |
| `/custom-themes.css` | GET | `handleCustomThemes` | User custom theme CSS |
| `/api/push/vapid` | GET | `handleVapid` | VAPID public key (when push enabled) |
| `/api/push/subscribe` | POST | `handleSubscribe` | Register a web-push subscription |
| `/api/push/unsubscribe` | POST | `handleUnsubscribe` | Remove a web-push subscription |
| `/api/schedules` | GET/POST | `handleApiSchedules` | List schedules (with `nextRunAt`) / create (SQLite) |
| `/api/schedule` | GET/POST/PUT/DELETE | `handleApiSchedule` | Read/update/delete one schedule (`?id=`) |
| `/api/schedule/run` | POST | `handleApiScheduleRun` | Fire a schedule now (`?id=`); returns created `sessionId` |
| `/api/schedule/runs` | GET | `handleApiScheduleRuns` | Run log for a schedule (`?id=`) |
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

Broadcasting is fire-and-forget with a buffered channel (16). If the client is slow, keyless events are dropped rather than blocking. Duplicate `reload` and `new-session` events are coalesced per-client while pending.

## Running-Status Computation

Three signals are OR'd together to determine if a session is "running":

1. **session-status file** (`~/.pi/agent/session-status/<id>`): written by terminal Pi; ignored for Codex projections
2. **In-process runtime worker**: `chatSender.Status(id).State == running`
3. **Recent projection/transcript activity**: modtime within the short activity window

Status changes are broadcast as SSE `status-delta` events to `__all__` subscribers. A 1-second sweeper periodically revalidates all known running sessions to clean up stale states.
