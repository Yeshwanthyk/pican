# Sequence Flow: Server Startup

This document traces the execution from starting pican to the first HTTP request. Pi remains the default runtime; Codex and Claude are optional registered runtime phases.

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
runtimeFlag := flag.String("runtime", "pi", "agent runtimes: pi, codex, claude, both, or a comma-separated list")
codexCommandFlag := flag.String("codex-command", "", "path to the Codex executable")
claudeCommandFlag := flag.String("claude-command", "", "path to the Claude executable")
claudeHomeFlag := flag.String("claude-home", "", "Claude config home containing projects/")
```

`-runtime` accepts registered comma-separated IDs; `both` remains exactly `pi,codex`. `-codex-command`, then `PICAN_CODEX_COMMAND`, selects the Codex executable. Claude command precedence is `-claude-command`, `PICAN_CLAUDE_COMMAND`, then `claude`; home precedence is `-claude-home`, `PICAN_CLAUDE_HOME`, `CLAUDE_CONFIG_DIR`, then `~/.claude`. Command values are executable paths, never shell fragments.

### 2. Agent & Sessions Directory

```go
agentDir := agentdir.Path() // PI_CODING_AGENT_DIR, else ~/.pi/agent
sessionsDir := filepath.Join(agentDir, "sessions")
```

Any selection containing Pi requires the sessions directory to exist. Codex-only, Claude-only, or combined replaceable-only selections create it because it contains rebuildable projections.

### 3. Codex Catalog Initialization

When Codex is enabled, startup synchronously runs `codex.Sync` with a 15-second timeout. A short-lived `codex app-server --stdio` client initializes, lists every page of visible non-archived threads, reads each thread with turns, and atomically materializes `codex-<thread-id>.jsonl` projections. Per-thread failures leave older projections intact.

Codex-only mode exits if this initial sync fails. `both` mode logs degradation and continues with Pi; Codex is reported unavailable while cached projections remain readable/exportable. Sync retries every minute, and availability follows the latest completed attempt.

### 4. Claude Catalog Initialization

When Claude is enabled, startup first runs a bounded installed-CLI version/auth probe. The default `~/.claude` home leaves `CLAUDE_CONFIG_DIR` unset to preserve Claude Code's native subscription profile; non-default homes set it explicitly. Startup then synchronously scans `<claude-home>/projects/*/*.jsonl`. The parser consumes only complete lines from stable read-only snapshots. Valid prefixes still materialize when a file has malformed records, an incomplete tail, or a concurrent append, but the catalog result is partial and cannot prune any existing projection.

Startup then starts a 100 ms debounced native filesystem watcher plus one-minute full reconciliation. File create/write refreshes one projection without pruning; remove/rename requests a complete scan. A missing executable or logged-out home marks Claude operations unavailable while already materialized sessions remain viewable/exportable. The same registration supplies the installed-CLI stream-json worker factory for browser chat.

### 5. Host Selection

Priority:
1. `--host` flag (explicit override)
2. `127.0.0.1` (default)

If no `--host` override is supplied and Tailscale is running, startup also runs:

```bash
tailscale serve --bg --https=<port> http://127.0.0.1:<port>
```

This gives the user a Tailscale HTTPS endpoint without making pican bind to a Tailscale interface or manage TLS certificates itself.

### 6. Auth Enforcement

```go
if token == "" && !isLoopbackHost(bindHost) && !*insecure {
    fmt.Fprintf(os.Stderr, "refusing to bind %s without PICAN_TOKEN set…\n")
    os.Exit(1)
}
```

Non-loopback binds **require** `PICAN_TOKEN` to prevent unauthorized access over the network.

### 7. Server Construction

```go
srv, err := server.New(server.Deps{
    AgentDir:      agentDir,
    SessionsDir:   sessionsDir,
    Auth:          authMiddleware,
    ChatSender: manager, // registry factory selects Pi, Codex, or Claude
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

The worker factory parses the session header. Pi sessions start `pi --mode rpc`; Codex sessions validate projection metadata, start one `codex app-server --stdio` process, resume the native thread, and refresh the projection. Claude validates projection/native UUID state and starts one installed `claude` bidirectional stream-json process with mutually exclusive fresh `--session-id` or existing `--resume`. The manager reuses one worker per active session, evicts failed workers, and reaps workers after 10 minutes idle.

On success, server creation starts:

1. session file watching (fsnotify plus polling fallback);
2. workflow and task watchers;
3. Pi `session-status` watching;
4. the one-second running-status sweeper;
5. the schedule runner;
6. the persistent chat-queue drainer.

### 8. Route Registration

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

### 9. Static Asset Loading

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

### 10. State File

```go
writeStateFile(agentDir, bindHost, port, tailscaleServe, tailscaleURL)
// → ~/.pi/agent/pican/pican-state.json
```

Contains PID, port, host, Tailscale Serve flag/URL, and start time. Cleaned up on shutdown. On first run, migrates from the old `~/.pi/agent/pican-state.json` location.

### 11. Model Cache Warming

```go
if runtimeMode.enables("pi") {
    warmModelsCache()
}
```

Pi model discovery retains its process-wide cache. Codex model discovery uses app-server `model/list`. Claude exposes the installed CLI aliases `sonnet`, `opus`, and `haiku`; in-session model switching remains disabled.

### 12. Listen

```go
httpServer := &http.Server{
    Addr:              addr,
    Handler:           mux,
    ReadHeaderTimeout: 10 * time.Second,
    IdleTimeout:       120 * time.Second,
}
httpServer.ListenAndServe()
```

Blocks until interrupted. On `SIGINT`/`SIGTERM`, the server performs a graceful HTTP shutdown (five-second timeout), closes the Claude watcher, cancels and joins catalog sync, closes all runtime workers and child process trees, stops server background work, closes SQLite, and removes the state file.
