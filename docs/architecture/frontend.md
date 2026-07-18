# Frontend Architecture

pi-web uses a single Vite-built Svelte SPA embedded into the Go binary, plus a separate self-contained static export path.

## Vite App Frontend

Built with **Vite + Svelte + JavaScript modules**, embedded into the Go binary.

### Build Pipeline

```txt
web/src/main.js
web/src/App.svelte
web/src/routes/*.svelte
web/src/{components,routes,index,session,settings,shared}/**/*.{svelte,js}
        │
        └──▶ vite build ──▶ web/dist/ ──▶ //go:embed
                              │
                              ▼
                         .vite/manifest.json
```

At startup, `internal/frontend/assets.go` + `web/assets_embed.go` reads `.vite/manifest.json`, validates the `src/main.js` SPA entrypoint, and registers its hashed asset route under `/static/...`. Other hashed chunks are served from the embedded `web/dist/assets/` filesystem.

## SPA Shell and Routes

The live app is hosted by `internal/ui/embedded/app.html`, rendered by `internal/ui/spa_page.go`. The shell preserves the PWA contract: viewport/no-zoom metadata, theme boot, Window Controls Overlay boot, font variables, custom themes, and service-worker registration.

Browser routes served by the SPA shell:

- `/` → `web/src/routes/SessionsPage.svelte`
- `/session?id=…` → `web/src/routes/SessionPage.svelte`
- `/settings` → `web/src/routes/SettingsPage.svelte`
- `/schedules` → `web/src/routes/SchedulesPage.svelte`
- `/workflows?runId=…&session=…` → `web/src/routes/WorkflowsPage.svelte`
- `/tasks?project=…&session=…` → `web/src/routes/TasksPage.svelte`
- `/subagents` → `web/src/routes/SubagentsPage.svelte`
- `/login` → `web/src/routes/LoginPage.svelte`

API, SSE, PWA, sound, and static asset routes remain server-handled and are not intercepted by the SPA fallback.

## Sessions Index (`/`)

`SessionsPage.svelte` owns the page shell and orchestrates Svelte components for the sessions list, session cards, command palette, home menu, new-session modal, and project management modal. Timeline, Projects, Schedules, and Subagents are the global index views; Workflows and Tasks are session-scoped actions in `CommandMenu.svelte`. `web/src/index/` now contains pure data/API helpers (`sessions.js`) for normalization, grouping, filtering, and API calls.

Data comes from existing APIs such as `/api/sessions`, `/api/new-session`, `/api/projects`, `/api/recent-locations`, and `/events?id=__all__`. Running-session status is pushed through the shared SSE helpers and reflected reactively in the cards/counts.

## Session Viewer (`/session?id=…`)

`SessionPage.svelte` owns the route, fetches session JSON from `/api/session?id=…`, and **orchestrates the whole viewer as Svelte components**. It creates the reactive `SessionDataModel` once, provides it via context, and installs the live session runtime context (`model`, navigator, `navigateTo`, `reconcileEntries`, content runtime) before child components mount. Live components read that explicit runtime context instead of `window.__pi*` aliases. `SessionPage`'s `onMount` runs `startSessionPageRuntime()` (bootstrap, `setupSessionUi`, content-runtime wiring, header handlers, initial nav) and `setupSessionGlobals()` (page-global glue). There is **no `session.js` orchestrator** — see `docs/dev/templates-vs-web.md` § Current Migration State.

The message pane is rendered by Svelte components (no string-building renderer): `SessionContent` → `SessionEntry` → `ToolCall` → `ToolOutput`/`AskQuestion` or the extension-specific `TaskToolCard`/`SubagentToolCard`/`WorkflowToolCard`, with `{@html}` used only for markdown + pre-rendered ANSI tool output. The conversation-branch tree (`SessionTree`/`SessionTreeNodes`/`TreeNode`) is an on-demand overlay, not a persistent panel: `SessionTree` wraps its search/filter/tree content in `FullScreenSheet` (centered dialog on desktop, bottom sheet on mobile — the same pattern as `DiffModal`), toggled via `sessionModals.tree` (`openTree`/`closeTree`/`toggleTree` in `session-modals.svelte.js`) from ⌘B, the header `#tree-toggle` button, and the `CommandMenu` "tree" action; its open state mirrors to `?tree=open` for deep-linking, and selecting a node navigates then closes the overlay on every viewport. Other session UI components: `SessionInfoHeader`, `SessionHeader`, `RightSidebar` (+ `ArtifactPanel`), `ChatComposer` (+ `GitFooter`), `LiveReload`, `CommandMenu`, `ImageModal`, the modals (`ShortcutsModal`/`ModelUsageModal`/`ForkModal`/`LabelModal`/`ShareDialog`), and `BtwPopup`.

The transcript keeps execution detail available without making it the primary reading surface. `groupToolRuns()` collapses contiguous runs of two or more completed or non-interactive tool calls into a status-aware summary; pending interactive prompts remain visible, pending runs retain a running indicator, and failed runs open automatically. Thinking and assistant prose share the sanitized Markdown pipeline, with quieter presentation styling applied to thinking.

The old runners/renderers have been replaced by Svelte components plus focused helpers: `web/src/session/` holds the reactive model, pure helpers, live-only helpers, and a few shared utilities:

- `data/` — payload decoding + the reactive `SessionDataModel` (`session-data.svelte.js`, the single source of truth: entries/lookups/tree/active-path/view-state, `reconcile()`)
- `tree/`, `render/`, `navigation/` — **pure** tree/format/markdown/navigation helpers consumed by the Svelte components (and the export). The message renderer is now `<SessionEntry>`/`<ToolCall>`; `render/` keeps `session-format`, `markdown`, `entry-format`, `session-entry-actions` (download/share/copy)
- `session-globals.js`, `session-content-runtime.js`, `lazy-highlight.js` — the relocated live glue (see above)
- `chat/` — **pure/shared helpers**: `chat-api` + `git-api` (fetch wrappers), `chat-selectors` (pure model/thinking helpers), `done-notifier` (shared notification/sound/push util, also used by the settings page). Live composer DOM helpers live under `web/src/components/session/chat/`, wired together by `chat-composer-runtime.js` (`runChatComposer`, mounted by `<ChatComposer>`).
- `live/` — live-only helpers used by `<LiveReload>`: `live-connection.js` (SSE connection/reconnect lifecycle), `live-events.js` (SSE/reload primitives), `live-scroll.js` (low-level scroll primitives), `live-follow.js` (`createFollowScrollController` — follow-mode decision state + follow button), `live-stats.js` (header stats), and `chat-preview.js` (streaming-preview helper, also used by `<BtwPopup>`)
- `ui/` — search/toggle/session-ui-runner helpers used by `setupSessionUi` and `RightSidebar`, plus `sidebar.js`'s mobile-breakpoint helpers (`isMobileLayout`) and the docked-sidebar drawer toggle (`setSidebarOpen`) still used by the static export (see below)
- `artifacts/` — pure registries/filters + the fetch API wrappers; the panel itself is `ArtifactPanel.svelte`

The index + settings Phase 4 migration is complete: those routes are Svelte-orchestrated too, with only pure/API helpers left outside components.

## Static / Share Export

Export/share remains separate and self-contained. `web/src/export/export-entry.js` builds `internal/ui/embedded/export/export.js`, which is inlined by `internal/ui/export.go` with vendored `marked` and `highlight.js` assets.

Export rules:

- no Go server dependency
- no live SSE/chat imports
- no `/static/assets/...` dependency
- reusable rendering helpers may be shared with the live app when they are side-effect-free

The export's session tree stays a docked `<aside id="sidebar">` (in `internal/ui/embedded/share-session.html`), not the live app's `FullScreenSheet` overlay — it has no resize handle or desktop collapse (those affordances were dropped along with the live docked sidebar), just a mobile hamburger/overlay/close drawer via `sidebar.js`'s `isMobileLayout`/`setSidebarOpen`, wired in `session-ui-runner.js`.

## Live Reload

The session route listens to `/events?id=<sessionId>` via `web/src/session/live/` helpers for:

- `reload` / canonical session updates
- `chat-preview` streaming preview updates

The index route listens to `/events?id=__all__` for `new-session`, `status-snapshot`, and `status-delta`.

The workflows route uses the same `__all__` connection for named `workflows-updated` events, then refetches `/api/workflows` and the selected `/api/workflows/run` detail after a short debounce.

The subagents route also uses the `__all__` connection. It refetches `/api/subagents` after `new-session`, `status-snapshot`, and `status-delta` events so newly created child sessions and running-state transitions appear without a new event type.

## Shared Frontend Modules

- `web/src/shared/api.js` — JSON fetch helpers
- `web/src/shared/status-events.js` — shared status SSE lifecycle
- `web/src/shared/storage.js` — localStorage helpers
- `web/src/shared/escape.js` — HTML escaping
- `web/src/shared/theme.js` — authoritative live theme registry, switching, and browser-chrome synchronization for built-in, community, and custom themes
- `web/src/shared/version.js` — pure version formatting/changelog/fetch helpers; `VersionController.svelte` owns the update modal/status UI
- `web/src/shared/keyboard-nav.js` — vim-style j/k/gg/G navigation
- `web/src/components/shared/CommandPalette.svelte` — shared ⌘K session search palette

## Automated Frontend Boundaries

`make check` enforces the frontend rules that can be expressed mechanically:

- ESLint allows `lucide` imports only in `web/src/shared/icons.js`, rejects inline SVG in Svelte components, and rejects Unicode back/chevron glyphs used as span icons. `ContextUsage.svelte` has the sole inline-SVG exception because its ring is data visualization rather than an icon.
- `web/src/export/export-boundary.test.js` walks the export dependency graph and rejects live chat, SSE, and live-only session modules.
- `web/src/shared/locales/locales-contract.test.js` makes `en.js` authoritative by rejecting non-English keys that do not exist in English and non-string locale values.
- Knip, Prettier, the frontend build, Vitest, Go tests, installer tests, and `go vet` run through the same `make check` gate.

## Static Assets

| Asset | Source | Served From |
|-------|--------|-------------|
| Vite SPA bundle | `web/dist/assets/app-*.js` | `/static/assets/app-*.js` |
| Vite lazy chunks | `web/dist/assets/*.js` | `/static/assets/*.js` |
| Static export JS | `internal/ui/embedded/export/export.js` + vendors | inline in exported HTML |
| Theme CSS | `internal/ui/embedded/styles/theme.css` | `/theme.css` (PWA route); inlined in SPA shell (boot script + FOUC prevention need it before any other asset loads) |
| Index CSS | `internal/ui/embedded/styles/index.css` | `/index.css` (PWA route); also bundled into `/styles/app.css` for the SPA shell |
| Session CSS | `internal/ui/embedded/styles/session.css` | bundled into `/styles/app.css`, linked (not inlined) in SPA shell |
| Menu CSS | `internal/ui/embedded/styles/menu.css` | `/menu.css` and bundled into `/styles/app.css` |
| Palette CSS | `internal/ui/embedded/styles/palette.css` | `/palette.css` and bundled into `/styles/app.css` |
| Workflows CSS | `internal/ui/embedded/styles/workflows.css` | bundled into `/styles/app.css` |
| Tasks CSS | `internal/ui/embedded/styles/tasks.css` | bundled into `/styles/app.css` |
| Subagents CSS | `internal/ui/embedded/styles/subagents.css` | bundled into `/styles/app.css` |
| Custom themes | `~/.pi/agent/pi-web/custom-themes.css` (optional) | `/custom-themes.css` |
| PWA manifest | `internal/ui/embedded/assets/manifest.webmanifest` | `/manifest.webmanifest` |
| Service worker | `internal/ui/embedded/assets/sw.js` | `/sw.js` |
| Icons | `internal/ui/embedded/assets/icon.svg` etc. | `/icon.svg`, `/icon-maskable.svg`, `/pi-logo.svg` |
| Sound assets | `internal/ui/embedded/assets/cat.webm` | `/cat.webm` |
| User sound assets | `~/.pi/agent/pi-web/assets/*.mp3` | `/sounds/*.mp3` |
| SPA bundled stylesheets | `internal/ui/app_styles.go` (index/session/menu/palette/workflows/tasks/subagents CSS joined) | `/styles/app.css?v=<hash>`, content-hash cache-busted, `Cache-Control: public, max-age=31536000, immutable`, served gzip when accepted |

## Theme System

The live SPA shell uses `theme.css`, `index.css`, `settings.css`, `schedules.css`, `workflows.css`, `tasks.css`, `subagents.css`, `session.css`, `menu.css`, and `palette.css` from `internal/ui/embedded/styles/`. The shell still injects the server-backed theme and font variables before the app starts so first paint matches the installed PWA theme without a flash.

`internal/ui/embedded/styles/theme.css` is the sole owner of named-theme palette variables. Route styles consume those variables but must not redeclare `[data-theme]` palettes. The inline first-paint boot code and the live JavaScript switcher both resolve `--body-bg` / `--chrome-bg` from the active CSS theme, so adding a named theme does not require another hardcoded color map. `web/src/shared/theme.js` owns the ordered browser theme registry; the Go boot registry must stay aligned because static exports use it without loading the SPA bundle.
