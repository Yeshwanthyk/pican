# System Overview

## What pican Does

pican is a local HTTP server that lets you browse and continue Pi, Codex, Claude Code, and OpenCode sessions in a web browser. All four use one session list, viewer, live-update path, and export surface while retaining native runtime authority.

## Tech Stack

| Layer | Technology |
|-------|------------|
| Backend | Go 1.25+ |
| Frontend (live app) | Svelte 5 SPA (`web/src/main.ts` → `App.svelte`), built by Vite; the session viewer is fully component-driven over a reactive `SessionDataModel`. Go serves a single embedded shell (`internal/ui/embedded/app.html`) + injects bootstrap data |
| Static export | Go `html/template` (`internal/ui/embedded/share-session.html`) + inlined `export.js`/CSS, built from the same `web/src/session/` modules (self-contained Gist) |
| Styling | Custom CSS (multi-theme: dark/light/nord/dracula/custom) |
| Live Updates | Server-Sent Events (SSE) |
| Agent runtime | Startup-owned ordered registry; JSONL RPC via `pi --mode rpc`; JSON-RPC via `codex app-server --stdio`; bidirectional stream-json via the installed `claude` CLI; supervised authenticated HTTP/SSE via `opencode serve` |
| Session Storage | Registry-declared append-only Pi transcripts plus runtime-neutral replaceable projections under the configured state root; Codex, Claude, and OpenCode retain native authority |
| Local DB | SQLite under the configured state root for per-project scratchpads, tracked-project metadata, session pins/local archive, server-backed user settings, btw scratch-chat registry, and hosted create idempotency |
| Auth | Standalone token cookie/query/header, or mutually exclusive hosted proxy-only header authentication |

## Component Diagram

```
┌──────────────────────────────────────────────────────────────────────────┐
│                                 Browser                                   │
│                                                                           │
│   ┌──────────────────────────────────────┐  ┌─────────────────────────┐  │
│   │        Svelte 5 SPA (#spa-root)       │  │   EventSource Client    │  │
│   │  main.ts → App.svelte (path router)   │  │      /events?id=…       │  │
│   │                                       │  │                         │  │
│   │  / → SessionsPage (Svelte index)      │  │  • reload (session)     │  │
│   │  /session → SessionPage (Svelte       │  │  • new-session (index)  │  │
│   │     components + reactive model)      │  │  • status-delta         │  │
│   │  /settings → SettingsPage (Svelte)    │  │  • status-snapshot      │  │
│   │  /workflows → WorkflowsPage (Svelte)  │  │  • workflows-updated    │  │
│   │  /tasks → TasksPage (Svelte)           │  │                         │  │
│   │  /subagents → SubagentsPage (Svelte)   │  │                         │  │
│   │  /login → LoginPage                   │  │  • btw…                 │  │
│   │  shared: CommandPalette, Version UI   │  │                         │  │
│   └──────────────────────────────────────┘  └─────────────────────────┘  │
└──────────────────────────────────────────────────────────────────────────┘
                                    │
                                    │ HTTP
                                    ▼
┌──────────────────────────────────────────────────────────────────────────┐
│                              HTTP Router                                  │
│                                                                           │
│   GET  /              →  handleIndex      (SPA shell)                    │
│   GET  /session       →  handleSession    (SPA shell)                    │
│   GET  /settings      →  handleSettingsPage (SPA shell)                  │
│   GET  /api/session   →  handleApiSession  (JSON)                        │
│   GET  /api/sessions  →  handleApiSessions (JSON list)                   │
│   GET/POST /api/projects → tracked/discovered project metadata           │
│   POST /api/archives  →  local session archive/restore                   │
│   POST /api/chat      →  handleChat        (multipart or JSON)           │
│   POST /api/chat/cancel → handleCancelChat                               │
│   POST /api/set-model →  handleSetModel                                  │
│   POST /api/set-thinking-level → handleSetThinkingLevel                  │
│   POST /api/new-session / fork-session / clone-session                   │
│   POST /api/rename-session → handleRenameSession                         │
│   POST /api/label-session → handleLabelSessionEntry                      │
│   GET  /api/models    →  handleAvailableModels                           │
│   GET  /api/commands  →  handleCommands       (slash-command palette)    │
│   GET  /api/worker-status → handleWorkerStatus                           │
│   GET  /api/btw / POST /api/btw/new → btw scratch-chats (SQLite, SSE)    │
│   GET  /api/files     →  handleApiFiles       (@mention autocomplete)    │
│   GET  /api/git/info  / POST /api/git/rename-branch                      │
│   GET  /api/git/diff → working-tree diff for the diff modal              │
│   GET/POST /api/scratchpad → scratchpad (SQLite)                         │
│   GET/POST /api/settings → user settings (SQLite, write-through cache)   │
│   GET/POST /api/projects → project visibility prefs (SQLite)             │
│   GET  /api/workflows{,/run} → external workflow run snapshots            │
│   GET  /api/tasks{,/output} → external task stores and output              │
│   GET  /api/subagents → merged child sessions and parent records           │
│   GET  /api/sounds  /  GET /sounds/…   (notification sounds)             │
│   POST /share         →  handleShare         (GitHub Gist)               │
│   GET  /events        →  handleEvents        (SSE)                       │
│   GET  /api/recent-locations → handleRecentLocations                     │
│   GET  /custom-themes.css → handleCustomThemes                           │
│   /api/push/{vapid,subscribe,unsubscribe}  (web-push, optional)         │
│   /api/{version,check-update,update,restart} (self-update, optional)    │
│   GET  /metrics / /api/metrics → worker metrics dashboard (gopsutil)    │
│   PWA: /manifest.webmanifest, /sw.js, /icon.svg, /cat.webm, …           │
│   GET  /static/…      →  embedded Vite assets                            │
│                                                                           │
│   Inner mux mounted through one base path and auth policy                 │
└──────────────────────────────────────────────────────────────────────────┘
                                    │
         ┌──────────────────────────┼──────────────────────────┐
         │                          │                          │
         ▼                          ▼                          ▼
   ┌──────────┐            ┌──────────────┐           ┌──────────────┐
   │ Sessions │            │    Chat      │           │   File       │
   │  Cache   │            │   Workers    │           │  Watchers    │
   │          │            │              │           │              │
   │ LoadAll  │            │ Manager      │           │ fsnotify     │
   │ ParseFile│            │  ├─ worker   │           │  ├─ debounce │
   │ Resolve  │            │  ├─ reap     │           │  └─ fallback │
   │ Create   │            │  └─ status   │           │ polling      │
   └──────────┘            └──────────────┘           └──────────────┘
                                    │
                                    ▼
   ┌──────────────────────────────────────────────────────────────────┐
   │                    External Processes                             │
   │                                                                   │
   │   pi --mode rpc              (per-active-Pi-session worker)        │
   │   codex app-server --stdio   (per-active-Codex-session worker)     │
   │   claude stream-json          (per-active-Claude-session worker)   │
   │   claude --version/auth status (bounded availability probe)        │
   │   opencode serve              (one supervised loopback HTTP/SSE child)│
   │   gh gist create             (share session as private gist)       │
   │                                                                   │
   └──────────────────────────────────────────────────────────────────┘
```

## Runtime Registry

App startup owns an ordered `runtimes.Registry`. It registers Pi, Codex, Claude, then OpenCode and derives a selected registry from `-runtime`. Runtime IDs are validated lowercase open strings, so adding a future runtime does not extend an enum, but only startup registrations are accepted.

Each registration binds a serializable descriptor (`id`, label, command/version, projection mode, explicit capabilities) to an availability probe, optional catalog adapter, and optional `workers.Factory`. Registration validation enforces the important ownership invariants: a chat-capable runtime has a worker factory, and a replaceable-projection runtime has a catalog. Native lifecycle APIs that do not form a truthful common contract remain runtime-specific; Codex archive/delete/unarchive and native rename/fork still use the separate Codex service.

The selected registry is the server's runtime source of truth. `/api/runtimes` returns selected registrations in startup order with current availability. Runtime-dependent handlers resolve the persisted session runtime, check its trusted descriptor capability, then check current availability before dispatch. Unsupported operations return `409`; supported operations on an unavailable runtime return `503`. Native mutation paths fail closed unless their runtime adapter declares and implements the operation. OpenCode declares create/resume, rename, fork/clone, delete, chat/cancel, and model listing/switching; native archive, steering, queues, effort/reasoning, attachments, commands, subagent UI, approvals, and questions remain disabled. Runtime-neutral local Archive is pican-owned curation outside the runtime registry.

The worker manager still owns one-worker-per-session lifecycle and delegates only construction: it parses the trusted session runtime, rejects disabled runtimes, then calls `Registry.NewWorker`. Projection mode controls backend status-file and pagination behavior and is included additively in both `/api/session` and the embedded session bootstrap alongside runtime label, complete capabilities, and the server-built terminal resume command. The live frontend uses capabilities to gate mutation and composer controls, and projection mode for delta eligibility and same-ID replacement: `append-only-native` may use `afterCount` and preserve known entry objects, while `replaceable-projection` forces a full snapshot and replaces known objects whose stable IDs now carry newer content or status. Unknown modes take the conservative replaceable path. This does not alter the static export path, which renders only the persisted session snapshot and has no registry, worker, API, or SSE behavior.

`internal/projections.Store` owns the shared filesystem contract required by replaceable runtimes: safe `<runtime>-<native-id>.jsonl` derivation, canonical cwd handling, keyed locking by sessions directory/runtime/native ID, identity-validated discovery and removal, local pican metadata preservation and mutation, duplicate migration, and fsync-backed atomic JSONL replacement. The identity lock deliberately does not use the current filepath because canonical-cwd migration can move one native session between project directories. Runtime adapters remain responsible for translating native schemas: Codex keeps item translation and sparse captured tool-turn merging in `internal/codex`; Claude keeps stable-snapshot JSONL parsing, opaque unknown records, and message/tool translation in `internal/claude`.

## Network Binding

```
┌─────────────────┐     ┌─────────────────┐     ┌─────────────────┐
│   --host flag   │──────────────────────▶│  127.0.0.1      │
│   (override)    │                       │  (default)      │
└─────────────────┘                       └─────────────────┘
         │
         ▼
   Non-loopback →  PICAN_TOKEN required  (or --insecure)
   Loopback     →  Auth optional

When no --host override is supplied and Tailscale is running, pican also
configures Tailscale Serve:

    tailscale serve --bg --https=<port> http://127.0.0.1:<port>

Tailscale owns HTTPS/certificates and exposes the app at the node's MagicDNS
name, while pican itself continues listening only on localhost.
```

## Reusable Hosted Process Contract

`app.Config` and `app.Run(ctx, config) error` are the reusable hosting boundary. `Run` owns the listener, server, database, watchers, catalog loops, and workers it creates; cancellation shuts them down and returns. It does not install signal handlers or call `os.Exit`. `cmd/pican` is only the CLI/environment/version/signal adapter.

Standalone defaults retain the local `~/.pi/agent` shape. Hosted mode is intentionally Codex-only and requires one canonical absolute `WorkspaceRoot`, one absolute `StateRoot` contained by that workspace, one normalized `BasePath` such as `/s/abc123`, proxy-only authentication, and an exact child environment supplied by the host.

The server registers a root-based inner mux once, then the base-path handler strips the configured mount before dispatch. Requests outside the mount return `404`. Live HTML, hashed assets, styles, API requests, SSE, navigation, icons, manifest, and service-worker URLs all derive from the same base-path value. Static export/share remains a separate self-contained render and does not inherit live mount or network behavior.

Proxy-only mode accepts exactly one instance of the configured header and compares its value in constant time. It accepts no query token, login form, Bearer token, `X-Pican-Token`, Pican cookie, or browser fallback. The proxy token is read from `PICAN_PROXY_TOKEN`; there is deliberately no CLI token flag. It is not copied into the Codex environment, state, projections, responses, or logs. Scotty must keep Pican off the public network, authenticate the browser, strip browser credentials, and inject the private header only on its internal hop.

Every hosted create, browse, file, git, task, project, and child-working-directory boundary resolves through one canonical symlink-aware workspace resolver. The root and descendants are accepted; raw `..`, siblings, scoped filesystem symlinks, task store/output symlinks, and external Git gitdirs are rejected before reads or creation. Catalog reconciliation validates each authoritative Codex thread cwd before projection, and direct API/bootstrap/share reads repeat the same check. Native unarchive validates archived metadata before mutation. The Codex child and hosted Git helpers receive only the configured allowlisted environment, including opaque `CODEX_*`, `OPENAI_*`, `GH_*`, and `GITHUB_*` sentinels. Pican never resolves those sentinel values. Pican auth variables and unrelated host/provider secrets are stripped.

Hosted mode does not publish GitHub gists, run remote update checks, install or restart Pican, or invoke the ambient Pi auto-title model path. Share preview remains a local static render, and auto-title falls back to the local heuristic. Scotty owns external egress and runtime replacement.

## Session Directory Layout

```
~/.pi/agent/
├── sessions/
│   ├── --project-name--/
│   │   ├── 2026-01-15T10-30-00.000Z_a1b2c3d4.jsonl  ← Pi transcript
│   │   ├── codex-019abc….jsonl                        ← Codex projection
│   │   ├── claude-<uuid>.jsonl                        ← Claude projection
│   │   ├── opencode-<native-id>.jsonl                 ← OpenCode projection
│   │   └── …
│   └── --another--project--/
│       └── …
├── session-status/
│   ├── 2026-01-15T10-30-00.000Z_a1b2c3d4.jsonl   ← terminal writes here
│   └── …
├── pican.sqlite           ← scratchpads + project visibility prefs + user settings + btw registry
└── pican/
    ├── pican-state.json   ← server state file
    ├── custom-themes.css   ← optional user custom theme
    ├── vapid.json          ← web-push VAPID keys (when push enabled)
    └── push-subs.json      ← web-push subscriptions (when push enabled)
```

In hosted mode the equivalent layout is rooted at the configured state directory, for example `/workspace/<id>/.pican/{sessions,pican.sqlite,pican/...}`. Codex keeps its separate authoritative home at `/workspace/<id>/.codex`; Pican neither parses nor copies Codex credentials.

## Tracked Projects and Session Curation

The default index is a bounded tracked-project view, not the full native
catalog. An enabled `project_prefs` row with `source='registered'` means the
user explicitly tracks that persisted absolute project path. Automatically
discovered rows and the legacy project-filter setting remain readable for
compatibility, but they do not select projects for the focused home.

`GET /api/sessions` exposes explicit live-app scopes:

- `view=home` returns Now, ordered pins, and at most six recent unarchived
  sessions per tracked project;
- `view=all` returns the paginated unarchived native catalog;
- `view=archived` returns the paginated locally archived catalog;
- `project=<path>` returns the complete paginated view for one exact persisted
  project path.

Now includes running and waiting sessions even when their project is untracked.
Pins also bypass project tracking. Typed command-palette search uses
`view=all`, so untracked terminal-created sessions remain discoverable.

Session pins and archive state are pican-owned SQLite curation metadata.
Archiving never invokes a runtime-native archive API and never deletes or
rewrites native sessions or projections. A session cannot be both pinned and
archived: archiving removes its pin, while pinning restores it. Running or
waiting sessions cannot be archived. Direct viewing/export remains available
because archive controls navigation, not session authority.

## Startup Order

1. The CLI builds `app.Config`, installs `SIGINT`/`SIGTERM` cancellation, and calls `app.Run`. An embedding host can call `Run` directly with its own context and no process-global signal behavior.
2. `Run` validates and canonicalizes the mount, workspace, state, authentication, environment, runtime, and listener contract before opening the HTTP server. Hosted mode rejects every runtime selection except Codex.
3. Construct app-level Pi, Codex, Claude, and OpenCode registrations in that order for standalone mode. OpenCode owns one supervised loopback HTTP/SSE service shared by its catalog, model, lifecycle, and worker adapters.
4. Resolve runtime command/home flags, then parse `-runtime=auto|pi|codex|claude|opencode|both|<comma-separated registered IDs>`. `auto` is the default and enables installed commands in registry order; every other value is an explicit override. `both` remains an exact alias for `pi,codex`; selection is deduplicated and normalized back to registration order.
5. Derive a selected registry that is not mutated after startup. Malformed and valid-but-unregistered IDs fail CLI parsing before any runtime starts.
6. Resolve the configured state-root sessions directory: any selected append-only-native runtime requires it; a replaceable-projection-only selection creates it.
7. Probe selected executable-backed runtimes independently from catalog freshness, then give each initial catalog adapter a bounded startup pass. Deferred Codex reconciliation retries immediately with a longer bound, then runs a minute-level list with `UpdatedAt`-gated hydration. Claude starts a debounced watcher plus periodic recovery. OpenCode starts its authenticated loopback child, health/version checks it, connects one global event stream, then lists/reads and reconciles before availability. Partial scans never prune.
8. Determine bind host and auth policy, then build the shared worker manager. On first activity for a session it parses the session header, defaults an absent runtime to Pi, verifies selection, and dispatches construction through the selected registry.
9. Build `server.Deps` with the selected registry, runtime-aware model discovery, shared manager, narrow Claude creation service, and separate Codex lifecycle service; `server.New` validates the default runtime and starts server-owned watchers and background loops.
10. Register root-relative inner routes and embedded live-app assets, wrap the inner mux in authentication, then mount it at `BasePath`. Standalone mode may configure Tailscale Serve; hosted mode never does.
11. Write the state file, optionally open a browser, warm the Pi model cache when enabled, and serve the pre-bound listener.
12. When the caller's context is canceled, shut down HTTP, cancel catalog sync, close workers, and stop server goroutines.

```text
app.Run
 ├─ newRuntimeRegistry(Pi, Codex, Claude, OpenCode) ── registrations + model loaders
 ├─ parseRuntime(...) ────────────── selects registered IDs
 ├─ selectedRegistry() ───────────── passed to server and worker dispatch
 ├─ Catalog.Sync() / syncer.start()  runtime reconciliation
 ├─ claude.Watch() ──────────────── debounced native transcript refresh
 ├─ workers.NewManager(factory)
 │    └─ ParseFile → selected Registry.NewWorker(runtime, session, path)
 │         ├─ Pi factory    → pi --mode rpc
 │         ├─ Codex factory → validate projection → codex app-server --stdio
 │         ├─ Claude        → installed CLI stream-json (`--session-id` fresh / `--resume` existing)
 │         └─ OpenCode      → lightweight worker over shared authenticated HTTP/SSE
 ├─ projections.Store ─────────── replaceable path/lock/preserve/atomic-write contract
 └─ server.New(Deps{RuntimeRegistry, ChatSender, ModelsFor, CodexService})
      ├─ /api/runtimes → descriptors + live availability
      └─ projectionMode(runtime) → status, pagination, bootstrap, and reconciliation policy
```
