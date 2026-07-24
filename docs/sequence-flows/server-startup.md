# Sequence Flow: Server Startup

This document traces the execution from starting pican to the first HTTP request. Pi remains the default runtime; Codex, Claude, and OpenCode are optional registered runtime phases.

## Sequence Diagram

```
┌──────┐   ┌────────┐   ┌──────────┐   ┌──────────┐   ┌─────────┐   ┌────────┐
│  OS  │   │  main  │   │  network │   │  server  │   │ workers │   │  auth  │
└──┬───┘   └───┬────┘   └────┬─────┘   └────┬─────┘   └────┬────┘   └───┬────┘
   │           │             │              │              │            │
   │  exec     │             │              │              │            │
   │──────────▶│             │              │              │            │
   │           │             │              │              │            │
   │           │─── flag.Parse() ──────────▶│              │            │
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

### 1. CLI Flag Parsing

```go
port := flag.String("p", "31415", "port to listen on")
hostOverride := flag.String("host", "", "host/IP to bind; defaults to 127.0.0.1")
open := flag.Bool("o", false, "auto-open browser")
insecure := flag.Bool("insecure", false, "allow non-loopback bind without PICAN_TOKEN")
runtimeFlag := flag.String("runtime", "pi", "agent runtimes: pi, codex, claude, opencode, both, or a comma-separated list")
codexCommandFlag := flag.String("codex-command", "", "path to the Codex executable")
claudeCommandFlag := flag.String("claude-command", "", "path to the Claude executable")
claudeHomeFlag := flag.String("claude-home", "", "Claude config home containing projects/")
openCodeCommandFlag := flag.String("opencode-command", "", "path to the OpenCode executable")
```

`-runtime` accepts registered comma-separated IDs; `both` remains exactly `pi,codex`. OpenCode command precedence is `-opencode-command`, `PICAN_OPENCODE_COMMAND`, `~/.opencode/bin/opencode` when installed there, then `opencode` from `PATH`. Other runtime overrides retain their documented precedence. Command values are executable paths, never shell fragments.

### 2. Agent & Sessions Directory

```go
agentDir := agentdir.Path() // PI_CODING_AGENT_DIR, else ~/.pi/agent
sessionsDir := filepath.Join(agentDir, "sessions")
```

Any selection containing Pi requires the sessions directory to exist. Replaceable-only selections create it because it contains rebuildable projections.

### 3. Codex Catalog Initialization

When Codex is enabled, startup synchronously runs `codex.Sync` with a 15-second timeout. A short-lived `codex app-server --stdio` client initializes, lists every page of visible non-archived threads, reads each thread with turns, and atomically materializes `codex-<thread-id>.jsonl` projections. Per-thread failures leave older projections intact.

Codex-only mode exits if this initial sync fails. `both` mode logs degradation and continues with Pi; Codex is reported unavailable while cached projections remain readable/exportable. Sync retries every minute using `thread/list`; only new, changed, or missing projections trigger `thread/read` and materialization. Availability follows the latest completed attempt.

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

On success, server creation starts:

1. session file watching (fsnotify plus polling fallback);
2. workflow and task watchers;
3. Pi `session-status` watching;
4. the one-second running-status sweeper;
5. the schedule runner;
6. the persistent chat-queue drainer.

### 9. Route Registration

All routes are wrapped with `auth.Wrap`:

```go
mux.HandleFunc("/", s.auth.Wrap(s.handleIndex))
mux.HandleFunc("/session", s.auth.Wrap(s.handleSession))
mux.HandleFunc("/api/chat", s.auth.Wrap(s.handleChat))
mux.HandleFunc("/api/runtimes", s.auth.Wrap(s.handleRuntimes))
mux.HandleFunc("/api/models", s.auth.Wrap(s.handleAvailableModels))
// … etc
```

`/api/models?runtime=<runtime>` scopes explicit discovery; `/api/models?id=<session-id>` resolves the session runtime. Global callers such as settings and schedules continue using the merged `/api/models` response.

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
httpServer.ListenAndServe()
```

Blocks until interrupted. On `SIGINT`/`SIGTERM`, the server performs a graceful HTTP shutdown, closes native watchers/event streams, cancels catalog sync, closes runtime workers and supervised child process trees, stops server background work, closes SQLite, and removes the state file.
