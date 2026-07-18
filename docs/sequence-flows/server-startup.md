# Sequence Flow: Server Startup

This document traces the execution from starting pi-web to the first HTTP request. Pi remains the default runtime; Codex initialization is an optional startup phase.

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
   │           │─── os.Getenv(PI_WEB_TOKEN) │              │            │
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
insecure := flag.Bool("insecure", false, "allow non-loopback bind without PI_WEB_TOKEN")
runtimeFlag := flag.String("runtime", "pi", "agent runtime: pi, codex, or both")
codexCommandFlag := flag.String("codex-command", "", "path to the Codex executable")
```

`-runtime` accepts `pi`, `codex`, or `both`. `-codex-command`, then `PI_WEB_CODEX_COMMAND`, selects one executable path; it is not a shell command. The fallback is `codex` from `PATH`, and pi-web appends `app-server --stdio`.

### 2. Agent & Sessions Directory

```go
agentDir := agentdir.Path() // PI_CODING_AGENT_DIR, else ~/.pi/agent
sessionsDir := filepath.Join(agentDir, "sessions")
```

Pi and `both` modes require the sessions directory to exist. Codex-only mode creates it because pi-web stores rebuildable Codex projections there.

### 3. Codex Catalog Initialization

When Codex is enabled, startup synchronously runs `codex.Sync` with a 15-second timeout. A short-lived `codex app-server --stdio` client initializes, lists every page of visible non-archived threads, reads each thread with turns, and atomically materializes `codex-<thread-id>.jsonl` projections. Per-thread failures leave older projections intact.

Codex-only mode exits if this initial sync fails. `both` mode logs degradation and continues with Pi; Codex is reported unavailable while cached projections remain readable/exportable. Sync retries every minute, and availability follows the latest completed attempt.

### 4. Host Selection

Priority:
1. `--host` flag (explicit override)
2. `127.0.0.1` (default)

If no `--host` override is supplied and Tailscale is running, startup also runs:

```bash
tailscale serve --bg --https=<port> http://127.0.0.1:<port>
```

This gives the user a Tailscale HTTPS endpoint without making pi-web bind to a Tailscale interface or manage TLS certificates itself.

### 5. Auth Enforcement

```go
if token == "" && !isLoopbackHost(bindHost) && !*insecure {
    fmt.Fprintf(os.Stderr, "refusing to bind %s without PI_WEB_TOKEN set…\n")
    os.Exit(1)
}
```

Non-loopback binds **require** `PI_WEB_TOKEN` to prevent unauthorized access over the network.

### 6. Server Construction

```go
srv, err := server.New(server.Deps{
    AgentDir:      agentDir,
    SessionsDir:   sessionsDir,
    Auth:          authMiddleware,
    ChatSender: manager, // factory selects Pi or Codex from the parsed session
    Cache:               sessions.NewCache(),
    RenderAppShell:      ui.RenderAppShell,
    RenderExportSession: ui.RenderExportSessionPage,
    Models: func(ctx context.Context) (json.RawMessage, error) {
        return runtimeModels(ctx, runtimeMode, codexArgv, sessionsDir, server.ModelQuery{})
    },
    ModelsFor: func(ctx context.Context, query server.ModelQuery) (json.RawMessage, error) {
        return runtimeModels(ctx, runtimeMode, codexArgv, sessionsDir, query)
    },
    DefaultRuntime: func() string {
        if runtimeMode == runtimeCodex { return "codex" }
        return "pi"
    }(),
    EnabledRuntimes:  runtimeMode.enabledRuntimes(),
    RuntimeAvailable: func(runtime string) (bool, string) { … },
    Codex:             codexService{sessionsDir: sessionsDir, command: codexArgv},
})
if err != nil { os.Exit(1) } // agent-dir / SQLite schema init failed
```

`server.New` returns an error and aborts startup if the agent directory or
SQLite schema (`initDB`) can't be initialized, rather than running with a
half-initialized database that fails opaquely on first use.

The worker factory parses the session header. Pi sessions start `pi --mode rpc`; Codex sessions validate projection metadata, start one `codex app-server --stdio` process, resume the native thread, and refresh the projection. The manager reuses one worker per active session, evicts failed workers, and reaps workers after 10 minutes idle.

On success, server creation starts:

1. session file watching (fsnotify plus polling fallback);
2. workflow and task watchers;
3. Pi `session-status` watching;
4. the one-second running-status sweeper;
5. the schedule runner;
6. the persistent chat-queue drainer.

### 7. Route Registration

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

### 8. Static Asset Loading

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

### 9. State File

```go
writeStateFile(agentDir, bindHost, port, tailscaleServe, tailscaleURL)
// → ~/.pi/agent/pi-web/pi-web-state.json
```

Contains PID, port, host, Tailscale Serve flag/URL, and start time. Cleaned up on shutdown. On first run, migrates from the old `~/.pi/agent/pi-web-state.json` location.

### 10. Model Cache Warming

```go
if runtimeMode.enables("pi") {
    warmModelsCache()
}
```

Pi model discovery retains its process-wide cache. Codex model discovery uses app-server `model/list` and is selected by runtime or session scope.

### 11. Listen

```go
httpServer := &http.Server{
    Addr:              addr,
    Handler:           mux,
    ReadHeaderTimeout: 10 * time.Second,
    IdleTimeout:       120 * time.Second,
}
httpServer.ListenAndServe()
```

Blocks until interrupted. On `SIGINT`/`SIGTERM`, the server performs a graceful HTTP shutdown (five-second timeout), cancels and joins catalog sync, closes Pi/Codex workers, stops server background work, closes SQLite, and removes the state file.
