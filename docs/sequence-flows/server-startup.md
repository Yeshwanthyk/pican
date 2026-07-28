# Sequence Flow: Server Startup

This document traces the execution from starting pican to the first HTTP request. The default standalone selection discovers installed Pi, Codex, Claude, and OpenCode commands; explicit runtime selection remains available. An embedding host instead calls `app.Run(ctx, config)` directly.

## Sequence Diagram

```
┌──────┐   ┌────────┐   ┌──────────┐   ┌──────────┐   ┌─────────┐   ┌────────┐
│  OS  │   │  main  │   │  network │   │  server  │   │ workers │   │  auth  │
└──┬───┘   └───┬────┘   └────┬─────┘   └────┬─────┘   └────┬────┘   └───┬────┘
   │           │             │              │              │            │
   │  exec     │             │              │              │            │
   │──────────▶│             │              │              │            │
   │           │             │              │              │            │
   │           │─── app.ParseCLI() ─────────▶│              │            │
   │           │─── app.Run(ctx, config) ───▶│              │            │
   │           │             │              │              │            │
   │           │─── os.Stat(sessionsDir) ──▶│              │            │
   │           │             │              │              │            │
   │           │─── chooseBindHost() ──────▶│              │            │
   │           │             │              │              │            │
   │           │◀─────────── host ──────────│              │            │
   │           │             │              │              │            │
   │           │─── os.Getenv(PICAN_TOKEN) │              │            │
   │           │             │              │              │            │
   │           │─── auth.New(token) ────────────────────────────────────▶│
   │           │             │              │              │            │
   │           │◀─────────── Middleware ────│              │            │
   │           │             │              │              │            │
   │           │─── server.New(deps) ──────▶│              │            │
   │           │             │              │              │            │
   │           │             │              ├─── go watchFiles() ───────▶│
   │           │             │              │              │            │
   │           │             │              ├─── go startSessionStatusWatcher()│
   │           │             │              │              │            │
   │           │             │              ├─── go runStatusSweeper() ─▶│
   │           │             │              │              │            │
   │           │◀────────── Server ─────────│              │            │
   │           │             │              │              │            │
   │           │─── srv.Register(mux) ─────▶│              │            │
   │           │             │              │              │            │
   │           │─── loadIndexScript() ─────▶│              │            │
   │           │             │              │              │            │
   │           │                                                          │
   │           │             │              │              │            │
   │           │─── mux.HandleFunc(/static/assets/…) ───────────────────▶│
   │           │             │              │              │            │
   │           │─── writeStateFile() ────────▶│              │            │
   │           │             │              │              │            │
   │           │─── warmModelsCache() ─────▶│              │            │
   │           │             │              │              │            │
   │           │─── openBrowser(url) ──────▶│              │            │
   │           │   (if -o flag)             │              │            │
   │           │             │              │              │            │
   │           │─── http.ListenAndServe() ─▶│              │            │
   │           │             │              │              │            │
   │           │◀──────────── Blocks ───────│              │            │
```

## Step-by-Step

### 1. Reusable process boundary and CLI parsing

`app.Config` owns the listen address, base path, workspace root, state root, authentication policy, exact child environment, selected runtime, current version, and optional browser-safe host-navigation URL. `app.Run` owns and cleans up all resources created below. It returns when the supplied context is canceled or serving fails; it never installs process-global signal handling and never calls `os.Exit`. `cmd/pican` parses flags/environment, creates a signal-aware context, calls `Run`, and translates the returned error into a process exit.

```go
port := flag.String("p", "31415", "port to listen on")
hostOverride := flag.String("host", "", "host/IP to bind; defaults to 127.0.0.1")
open := flag.Bool("o", false, "auto-open browser")
insecure := flag.Bool("insecure", false, "allow non-loopback bind without PICAN_TOKEN")
runtimeFlag := flag.String("runtime", "auto", "agent runtimes: auto, pi, codex, claude, opencode, both, or a comma-separated list")
codexCommandFlag := flag.String("codex-command", "", "path to the Codex executable")
claudeCommandFlag := flag.String("claude-command", "", "path to the Claude executable")
claudeHomeFlag := flag.String("claude-home", "", "Claude config home containing projects/")
openCodeCommandFlag := flag.String("opencode-command", "", "path to the OpenCode executable")
```

The default `auto` selection resolves each configured command with `exec.LookPath` and enables installed runtimes in Pi, Codex, Claude, OpenCode registry order. `-runtime` accepts registered comma-separated IDs as an explicit override; `both` remains exactly `pi,codex`. OpenCode command precedence is `-opencode-command`, `PICAN_OPENCODE_COMMAND`, `~/.opencode/bin/opencode` when installed there, then `opencode` from `PATH`. Other runtime overrides retain their documented precedence. Command values are executable paths, never shell fragments.

Hosted mode is selected with `PICAN_MODE=hosted`. `PICAN_BASE_PATH`, `PICAN_WORKSPACE_ROOT`, `PICAN_STATE_ROOT`, `PICAN_AUTH_MODE=proxy`, `PICAN_PROXY_HEADER`, and optional `PICAN_HOST_NAVIGATION_URL` supply non-secret hosting configuration; `PICAN_PROXY_TOKEN` is environment-only and has no CLI flag. The navigation URL must be an absolute HTTP(S) URL without userinfo or a root-relative path. Hosted validation requires Codex-only runtime selection, an absolute workspace, a state root contained by that workspace, and proxy-only authentication.

### 2. State, workspace, and sessions directories

```go
agentDir := agentdir.Path() // PI_CODING_AGENT_DIR, else ~/.pi/agent
sessionsDir := filepath.Join(agentDir, "sessions")
```

Any selection containing Pi requires the sessions directory to exist. Replaceable-only selections create it because it contains rebuildable projections.

Hosted mode canonicalizes `WorkspaceRoot` through symlinks and creates `StateRoot` only through the containment resolver. Pican's sessions, SQLite, state file, sounds, projections, and other mutable data live below `StateRoot`; Codex's separately supplied home remains below the workspace. All hosted filesystem/git/project paths and Codex working directories must resolve to the workspace root or a descendant.

### 3. Codex Catalog Initialization

When Codex is enabled, startup first runs a bounded executable/version/auth probe. This health signal is independent from catalog freshness, so a large native catalog cannot disable otherwise-working create, resume, model, or chat operations.

Startup gives initial `codex.Sync` reconciliation 15 seconds. If it doesn't finish, pican serves cached projections and immediately continues the same reconciliation in the background with a ten-minute bound. Later retries run every minute using `thread/list`; only new, changed, or missing projections trigger `thread/read` and materialization. Per-thread or list failures leave older projections intact and never authorize pruning.

### 4. Claude Catalog Initialization

When Claude is enabled, startup first runs a bounded installed-CLI version/auth probe. The default `~/.claude` home leaves `CLAUDE_CONFIG_DIR` unset to preserve Claude Code's native subscription profile; non-default homes set it explicitly. Startup then synchronously scans `<claude-home>/projects/*/*.jsonl`. The parser consumes only complete lines from stable read-only snapshots. Valid prefixes still materialize when a file has malformed records, an incomplete tail, or a concurrent append, but the catalog result is partial and cannot prune any existing projection.

Startup then starts a 100 ms debounced native filesystem watcher plus ten-minute recovery reconciliation. File create/write refreshes one projection without pruning; remove/rename requests a complete scan. Recovery scans gate unchanged transcripts by `(mtime,size)`. A missing executable or logged-out home marks Claude operations unavailable while already materialized sessions remain viewable/exportable. The same registration supplies the installed-CLI stream-json worker factory for browser chat.

### 5. OpenCode service initialization

When OpenCode is enabled, pican starts one supervised `opencode serve` child
with direct argv, `--hostname 127.0.0.1`, an ephemeral port, and generated
Basic Auth. It verifies authenticated health/version, connects one global SSE
stream, and runs native list/read reconciliation with canonical directory
validation.

The child is not exposed on pican's listener. A failed health check, partial
catalog, or stream failure leaves cached projections readable and affects only
OpenCode. Bounded restart creates a new port/credential and requires event
reconnection plus complete reconciliation before availability returns.

### 6. Host Selection

Priority:
1. `--host` flag (explicit override)
2. `127.0.0.1` (default)

If no `--host` override is supplied and Tailscale is running, startup also runs:

```bash
tailscale serve --bg --https=<port> http://127.0.0.1:<port>
```

This gives the user a Tailscale HTTPS endpoint without making pican bind to a Tailscale interface or manage TLS certificates itself.

### 7. Auth Enforcement

```go
if token == "" && !isLoopbackHost(bindHost) && !*insecure {
    fmt.Fprintf(os.Stderr, "refusing to bind %s without PICAN_TOKEN set…\n")
    os.Exit(1)
}
```

Non-loopback binds **require** `PICAN_TOKEN` to prevent unauthorized access over the network.

Hosted mode does not use this browser token flow. The complete mounted mux, including assets, is gated by proxy-only auth. Exactly one configured private header must match in constant time; query/form/Bearer/Pican-header/cookie/browser-login alternatives are rejected. The embedding host authenticates the public browser request and injects the header only on the private proxy hop. Hosted mode does not register PWA routes.

### 8. Server Construction

```go
srv, err := server.New(server.Deps{
    AgentDir:      agentDir,
    SessionsDir:   sessionsDir,
    Auth:          authMiddleware,
    ChatSender: manager, // registry factory selects Pi, Codex, Claude, or OpenCode
    Cache:               sessions.NewCache(),
    RenderAppShell:      ui.RenderAppShell,
    RenderExportSession: ui.RenderExportSessionPage,
    Models: func(ctx context.Context) (json.RawMessage, error) {
        return runtimeModels(ctx, runtimeMode, codexArgv, sessionsDir, server.ModelQuery{})
    },
    ModelsFor: func(ctx context.Context, query server.ModelQuery) (json.RawMessage, error) {
        return runtimeModels(ctx, runtimeMode, codexArgv, sessionsDir, query)
    },
    RuntimeRegistry: selectedRegistry,
    DefaultRuntime:  enabledRuntimes.defaultRuntime(),
    ClaudeHome:      claudeHome,
    Claude:           claudeService{sessionsDir: sessionsDir}, // when enabled
    Codex:            codexService{sessionsDir: sessionsDir, command: codexArgv}, // when enabled
})
if err != nil { os.Exit(1) } // agent-dir / SQLite schema init failed
```

`server.New` returns an error and aborts startup if the agent directory or
SQLite schema (`initDB`) can't be initialized, rather than running with a
half-initialized database that fails opaquely on first use.

The worker factory parses the session header. Pi, Codex, and Claude retain their native per-session worker shapes. OpenCode creates a lightweight session worker over the supervised shared HTTP/SSE service. The manager reuses one worker per active session, evicts failed workers, and reaps workers after 10 minutes idle.

On success, server creation follows an explicit mode matrix:

| Lifecycle | Hosted | Standalone |
|-----------|--------|------------|
| SQLite + durable session-create store | Start with pins/archive/create-only schema | Start with full schema |
| Session file watcher | Start | Start |
| Session status watcher + one-second sweeper | Start | Start |
| Workflow watcher + task watcher | Do not construct | Start |
| Schedule store + runner | Do not construct | Start |
| Projects/Peers/Scratchpad/BTW persistence + handlers | Do not construct/register | Construct/register |
| Push manager | Do not construct | Construct when available |
| Subagent scan surface | Do not construct/register | Register; initialize lazily |
| Persistent chat queue + autonomous drainer | Do not construct | Start |
| Updater hooks + metrics state | Do not retain/initialize | Retain/initialize |
| Sounds routes | Do not register | Register |

Hosted startup also requires exactly one registered runtime (Codex), a Codex
lifecycle service, and Codex as the default. Claude/OpenCode lifecycle services
are not retained, and hosted session resolution rejects any non-Codex
projection before a retained handler can act on it.

### 9. Route Registration and Mounting

Standalone registers the complete historical route surface. Hosted registers
only the backend routes in this matrix; every other standalone endpoint is
unregistered and returns `404`:

| Route group | Hosted | Standalone |
|-------------|--------|------------|
| Session detail/list, create, local archive, rename, pins | Register | Register |
| Native Codex archive/unarchive | Register | Register |
| Chat/cancel, model list/set, effort, files, Git diff | Register | Register |
| SSE, worker status, approvals/questions | Register | Register |
| UI/settings/share/runtime/commands/queue/fork/clone/label/delete | 404 | Register |
| Projects/locations/peers/fs browse/Git info/branch rename | 404 | Register |
| Schedules/workflows/tasks/subagents/scratchpad/BTW | 404 | Register |
| Push/sounds/metrics+pprof/updater | 404 | Register when available |

Registered routes retain their existing `auth.Wrap` behavior:

```go
mux.HandleFunc("/", s.auth.Wrap(s.handleIndex))
mux.HandleFunc("/session", s.auth.Wrap(s.handleSession))
mux.HandleFunc("/api/chat", s.auth.Wrap(s.handleChat))
mux.HandleFunc("/api/runtimes", s.auth.Wrap(s.handleRuntimes))
mux.HandleFunc("/api/models", s.auth.Wrap(s.handleAvailableModels))
// … etc
```

Hosted Thread creation normalizes an omitted path to the canonical configured
`WorkspaceRoot` and an omitted runtime to Codex. Only that exact canonical root
and Codex are accepted. A child, missing child, parent, sibling, traversal,
symlink escape, non-Codex runtime, or `sourceSessionId` is rejected before an
idempotency claim or Codex native mutation. `StartSession` therefore always
receives the canonical root, and hosted creation never auto-registers a
Project.

`/api/models?runtime=<runtime>` scopes explicit discovery; `/api/models?id=<session-id>` resolves the session runtime. Global callers such as settings and schedules continue using the merged `/api/models` response.

Handlers remain registered against root-relative paths on one inner mux. A single base-path handler mounts that mux and strips the prefix before dispatch; requests outside the mount return `404`. The same normalized path is supplied to the live shell, frontend URL helpers, and Vite asset loader, plus standalone-only PWA metadata.

Before Vite runs, the live shell emits a schema-validated application context containing only `mode` and optional `hostNavigationUrl`. The frontend decodes it before mount and safely defaults to standalone. Hosted shells omit manifest/install metadata and service-worker boot; standalone shells and PWA behavior are unchanged.

### 10. Static Asset Loading

```go
if scripts, err := frontend.LoadScripts(web.DistFS(), frontend.AppEntry); err == nil {
    for _, script := range scripts {
        ui.SetAppScriptPath(script.Path)
        mux.HandleFunc(script.Path, frontend.ServeJS(script.JS, true))
    }
    mux.HandleFunc("/static/assets/", frontend.ServeStaticAssets(web.DistFS()))
}
```

Reads Vite manifest to discover the hashed filename of the SPA bundle.

### 11. State File

```go
writeStateFile(agentDir, bindHost, port, tailscaleServe, tailscaleURL)
// → ~/.pi/agent/pican/pican-state.json
```

Contains PID, port, host, Tailscale Serve flag/URL, and start time. Cleaned up on shutdown. On first run, migrates from the old `~/.pi/agent/pican-state.json` location.

### 12. Model Cache Warming

```go
if runtimeMode.enables("pi") {
    warmModelsCache()
}
```

Pi model discovery retains its process-wide cache. Codex model discovery uses app-server `model/list`. Claude exposes installed CLI aliases; in-session model switching remains disabled. OpenCode model discovery uses the shared service's provider/model API and supports in-session switching.

### 13. Listen

```go
httpServer := &http.Server{
    Addr:              addr,
    Handler:           mux,
    ReadHeaderTimeout: 10 * time.Second,
    IdleTimeout:       120 * time.Second,
}
app.Run(ctx, config)
```

The CLI blocks until its signal-aware context is canceled. An embedding host can cancel its own context. In either case `Run` performs a graceful HTTP shutdown, closes native watchers/event streams, cancels catalog sync, closes runtime workers and supervised child process trees, stops server background work, closes SQLite, and removes the state file.
