# System Overview

## What pican Does

pican is a local HTTP server that lets you browse and interact with Pi sessions and Codex threads in a web browser. It presents both runtimes through one session list, viewer, live-update path, and export surface.

## Tech Stack

| Layer | Technology |
|-------|------------|
| Backend | Go 1.25+ |
| Frontend (live app) | Svelte 5 SPA (`web/src/main.js` → `App.svelte`), built by Vite; the session viewer is fully component-driven over a reactive `SessionDataModel`. Go serves a single embedded shell (`internal/ui/embedded/app.html`) + injects bootstrap data |
| Static export | Go `html/template` (`internal/ui/embedded/share-session.html`) + inlined `export.js`/CSS, built from the same `web/src/session/` modules (self-contained Gist) |
| Styling | Custom CSS (multi-theme: dark/light/nord/dracula/custom) |
| Live Updates | Server-Sent Events (SSE) |
| Agent runtime | JSONL RPC via `pi --mode rpc`; JSON-RPC via `codex app-server --stdio` |
| Session Storage | Native Pi JSONL transcripts plus rebuildable Codex projections under `~/.pi/agent/sessions`; Codex remains authoritative in `~/.codex` |
| Local DB | SQLite (`~/.pi/agent/pican.sqlite`) for per-project scratchpads, project visibility prefs, server-backed user settings, and the btw scratch-chat registry |
| Auth | Token cookie/query/header (optional on localhost) |

## Component Diagram

```
┌──────────────────────────────────────────────────────────────────────────┐
│                                 Browser                                   │
│                                                                           │
│   ┌──────────────────────────────────────┐  ┌─────────────────────────┐  │
│   │        Svelte 5 SPA (#spa-root)       │  │   EventSource Client    │  │
│   │  main.js → App.svelte (path router)   │  │      /events?id=…       │  │
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
   │   gh gist create             (share session as private gist)       │
   │                                                                   │
   └──────────────────────────────────────────────────────────────────┘
```

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

1. Parse CLI flags, including `-runtime=pi|codex|both` (default `pi`) and `-codex-command`.
2. Resolve `~/.pi/agent/sessions`: Codex-only mode creates it; Pi/both mode requires it.
3. In Codex-enabled modes, run the initial catalog sync. Codex-only startup fails closed; both mode logs failure and continues with Pi. Start the one-minute periodic sync.
4. Determine bind host and enforce auth for explicit non-loopback binds.
5. Build `server.Deps` with runtime-aware model discovery, Codex service, and the shared worker manager.
6. Create `Server` → starts file/status watchers, sweepers, scheduler, and queue drainer.
7. Register routes and embedded Vite assets.
8. Optionally configure Tailscale Serve HTTPS for localhost.
9. Write `~/.pi/agent/pican/pican-state.json` (with flock), optionally open a browser, and warm the Pi model cache when enabled.
10. Start `http.Server`; on `SIGINT`/`SIGTERM`, stop catalog sync, workers, server goroutines, and HTTP gracefully.
