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
| Session Storage | Registry-declared append-only Pi transcripts plus runtime-neutral replaceable projections under `~/.pi/agent/sessions`; Codex, Claude, and OpenCode retain native authority |
| Local DB | SQLite (`~/.pi/agent/pican.sqlite`) for per-project scratchpads, project visibility prefs, server-backed user settings, and the btw scratch-chat registry |
| Auth | Token cookie/query/header (optional on localhost) |

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
│   All handlers wrapped with auth.Middleware (token check)                │
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

The selected registry is the server's runtime source of truth. `/api/runtimes` returns selected registrations in startup order with current availability. Runtime-dependent handlers resolve the persisted session runtime, check its trusted descriptor capability, then check current availability before dispatch. Unsupported operations return `409`; supported operations on an unavailable runtime return `503`. Native mutation paths fail closed unless their runtime adapter declares and implements the operation. OpenCode declares create/resume, rename, fork/clone, delete, chat/cancel, and model listing/switching; archive, steering, queues, effort/reasoning, attachments, commands, subagent UI, approvals, and questions remain disabled.

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

## Project Visibility

Project filtering is an **opt-in master switch**, stored in the `app_settings`
SQLite table (`project_filter_enabled`, default **off**). Per-project enable
state lives in the `project_prefs` table. Both are server-side, so they sync
across devices. See `internal/server/projects.go`.

- **Filter off (default):** every session shows; new sessions (web- or
  terminal-created) appear immediately, exactly like before the feature existed.
- **Filter on:** the index only renders sessions whose project is **enabled** —
  an allowlist. Projects discovered after the table is first seeded default to
  hidden, so one-off folders stay out of view.
- **First seed** (empty `project_prefs`): every discovered project is enabled, so
  turning the filter on doesn't blank the homepage.
- **Registering** a folder path (`action: register`) pre-approves it so sessions
  that later land there show immediately, even before any session exists.
- Filtering is applied server-side in both `handleIndex` and `handleApiSessions`
  (no client flash) and is a no-op while the master switch is off. Manage via the
  index menu → **Manage Projects** (search, select/deselect-all, register, and the
  filter switch), backed by `GET/POST /api/projects`.

## Startup Order

1. Construct app-level Pi, Codex, Claude, and OpenCode registrations in that order. OpenCode owns one supervised loopback HTTP/SSE service shared by its catalog, model, lifecycle, and worker adapters.
2. Resolve runtime command/home flags, then parse `-runtime=auto|pi|codex|claude|opencode|both|<comma-separated registered IDs>`. `auto` is the default and enables installed commands in registry order; every other value is an explicit override. `both` remains an exact alias for `pi,codex`; selection is deduplicated and normalized back to registration order.
3. Derive a selected registry that is not mutated after startup. Malformed and valid-but-unregistered IDs fail CLI parsing before any runtime starts.
4. Resolve `~/.pi/agent/sessions`: any selected append-only-native runtime requires it; a replaceable-projection-only selection creates it.
5. Probe selected executable-backed runtimes independently from catalog freshness, then give each initial catalog adapter a bounded startup pass. Deferred Codex reconciliation retries immediately with a longer bound, then runs a minute-level list with `UpdatedAt`-gated hydration. Claude starts a debounced watcher plus periodic recovery. OpenCode starts its authenticated loopback child, health/version checks it, connects one global event stream, then lists/reads and reconciles before availability. Partial scans never prune.
6. Determine bind host and auth policy, then build the shared worker manager. On first activity for a session it parses the session header, defaults an absent runtime to Pi, verifies selection, and dispatches construction through the selected registry.
7. Build `server.Deps` with the selected registry, runtime-aware model discovery, shared manager, narrow Claude creation service, and separate Codex lifecycle service; `server.New` validates the default runtime and starts server-owned watchers and background loops.
8. Register routes and embedded live-app assets, then optionally configure Tailscale Serve.
9. Write the state file, optionally open a browser, warm the Pi model cache when enabled, and start `http.Server`.
10. On `SIGINT`/`SIGTERM`, shut down HTTP, cancel catalog sync, close workers, and stop server goroutines.

```text
Main
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
