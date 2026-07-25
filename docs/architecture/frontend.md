# Frontend Architecture

pican uses a single Vite-built Svelte SPA embedded into the Go binary, plus a separate self-contained static export path.

## Vite App Frontend

Built with **Vite + Svelte 5 + TypeScript**, embedded into the Go binary. Effect 4 owns typed browser I/O and failure handling at the frontend boundary; components stay thin and consume adapters or the Svelte runtime bridge instead of running Effects directly.

### Build Pipeline

```txt
web/src/main.ts
web/src/App.svelte
web/src/routes/*.svelte
web/src/{components,routes,index,session,settings,shared}/**/*.{svelte,ts}
        │
        └──▶ vite build ──▶ web/dist/ ──▶ //go:embed
                              │
                              ▼
                         .vite/manifest.json
```

At startup, `internal/frontend/assets.go` + `web/assets_embed.go` reads `.vite/manifest.json`, validates the `src/main.ts` SPA entrypoint, and registers its hashed asset route under `/static/...`. Other hashed chunks are served from the embedded `web/dist/assets/` filesystem.

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

## Effect and TypeScript Boundary

All frontend modules under `web/src/` are TypeScript. `web/src/lib/` is the Effect foundation:

- `schema.ts` defines the runtime schemas and inferred TypeScript models for API payloads.
- `errors.ts` defines the tagged failure taxonomy: `NetworkError`, `HttpError`, `DecodeError`, `AbortError`, `TimeoutError`, `StorageError`, `SseError`, and `WorkerDownError`.
- `http.ts` performs schema-decoded JSON requests with typed HTTP, network, abort, timeout, and decode failures.
- `storage.ts` wraps browser storage reads, writes, and parsing as typed Effects.
- `sse.ts` exposes the shared status stream and schema-decodes structured SSE events.
- `runtime.ts` owns the managed runtime plus `runPromise`, `runFork`, `runSync`, and `effectResource`. This is the Svelte bridge: components call these adapters and never call `Effect.run*` directly.

Feature modules expose Effect-backed APIs while retaining promise-shaped adapter functions where imperative Svelte or legacy call sites need them. When writing new Effect code, consult the pinned `effect-smol` source matching `web/package.json`; the project uses an Effect 4 beta and does not assume Effect 3 APIs.

## Sessions Index (`/`)

`SessionsPage.svelte` owns the page shell and orchestrates Svelte components for the ticker-row session list, desktop right rail, mobile thumb bar, command palette, home menu, new-session modal, and tracked-project modal. Its URL-backed scopes are Projects (the default focused home), All Sessions, Archived, and one exact project detail. Schedules and Subagents remain separate global routes; Workflows and Tasks are session-scoped actions in `CommandMenu.svelte`. `web/src/index/` contains pure data/API helpers (`sessions.ts`) for normalization, Now/pinned/date/project grouping, view-scoped requests, and project curation.

Data comes from APIs such as `/api/sessions`, `/api/runtimes`, `/api/new-session`, `/api/projects`, `/api/archives`, `/api/recent-locations`, and `/events?id=__all__`. The default `view=home` response is already bounded on the server: every Now/pinned session plus at most six remaining sessions per explicitly tracked project. The client keeps that first-render order stable across soft activity refreshes, prepends genuinely new sessions, and keeps pins in SQLite `pinOrder` even while they run or wait; unpinned status transitions can still move a row into or out of Now. All Sessions and exact-project views keep normal pagination; typed palette search deliberately uses `view=all`. Session summaries include the latest unresolved tool activity; an unresolved `ask_user_question` carries its first question and answer labels so the home rail can reply through the existing `/api/chat` path. Runtime plus native ID participate in search. The new-session modal selects among configured, currently available runtimes and sends the choice to `/api/new-session`; successful web creation tracks the persisted project path. Running-session status and curation changes are pushed through the shared SSE helpers.

Local Archive/Restore actions are live-app navigation controls, not runtime capabilities. They appear consistently for Pi, Codex, Claude, and OpenCode, while the separate Codex-native archive endpoint remains outside this UI contract. The server rejects archive for running/waiting sessions, and the client refreshes the current scope after the global `curation-updated` event. Static export does not read or render tracked, pinned, or archived navigation state.

## Session Viewer (`/session?id=…`)

`SessionPage.svelte` owns the route, fetches session JSON from `/api/session?id=…`, and **orchestrates the whole viewer as Svelte components**. It propagates normalized runtime identity, native session ID, capabilities, projection mode, and the server-built resume command from the response/header. Runtime is retained when creating a sibling session. Terminal resume uses `pi --session`, `codex resume`, `claude --resume`, or `opencode --session` according to that trusted response; the browser does not assemble runtime argv. It creates the reactive `SessionDataModel` once, provides it via context, and installs the live session runtime context (`model`, navigator, `navigateTo`, `reconcileEntries`, content runtime) before child components mount. Live components read that explicit runtime context instead of `window.__pi*` aliases. `SessionPage`'s `onMount` runs `startSessionPageRuntime()` (bootstrap, `setupSessionUi`, content-runtime wiring, header handlers, initial nav) and `setupSessionGlobals()` (page-global glue). There is **no `session.js` orchestrator** — see `docs/dev/templates-vs-web.md` § Current Migration State.

The message pane is rendered by Svelte components (no string-building renderer): `SessionContent` → `SessionEntry` → `ToolCall` → `ToolOutput`/`AskQuestion` or the extension-specific `TaskToolCard`/`SubagentToolCard`/`WorkflowToolCard`, with `{@html}` used only for markdown + pre-rendered ANSI tool output. The conversation-branch tree (`SessionTree`/`SessionTreeNodes`/`TreeNode`) is an on-demand overlay, not a persistent panel: `SessionTree` wraps its search/filter/tree content in `FullScreenSheet` (centered dialog on desktop, bottom sheet on mobile — the same pattern as `DiffModal`), toggled via `sessionModals.tree` (`openTree`/`closeTree`/`toggleTree` in `session-modals.svelte.js`) from ⌘B, the header `#tree-toggle` button, and the `CommandMenu` "tree" action; its open state mirrors to `?tree=open` for deep-linking, and selecting a node navigates then closes the overlay on every viewport. Other session UI components: `SessionInfoHeader`, `SessionHeader`, `RightSidebar` (+ `ArtifactPanel`), `ChatComposer` (+ `GitFooter`), `LiveReload`, `CommandMenu`, `ImageModal`, the modals (`ShortcutsModal`/`ModelUsageModal`/`ForkModal`/`LabelModal`/`ShareDialog`), and `BtwPopup`.

The transcript keeps execution detail available without making it the primary reading surface. `groupToolRuns()` collects each contiguous turn's thinking and tool calls into one Activity fold, including single-tool turns. Completed and historical folds start closed; only pending activity in the live viewer opens automatically. The existing Thinking, Tools, and Tool-output controls map to the thinking rows, tool rows, and nested tool disclosures inside the fold. Pending interactive prompts remain directly available.

Assistant edit tools use the shared, side-effect-free `words-diff.ts` parser and render a compact unified diff in `ToolCall.svelte`. Diffs with at most eight added/deleted lines open inline; larger patches start as a summary chip and expand edge-to-edge on mobile or as a rounded desktop surface. Opening the full working-tree diff is wired by the live session content runtime, so static export rendering does not import modal or live application behavior. Copying the displayed patch remains local to the component.

The old runners/renderers have been replaced by Svelte components plus focused helpers: `web/src/session/` holds the reactive model, pure helpers, live-only helpers, and a few shared utilities:

- `data/` — payload decoding + the reactive `SessionDataModel` (`session-data.svelte.ts`, the single source of truth: entries/lookups/tree/active-path/view-state, `reconcile()`)
- `tree/`, `render/`, `navigation/` — **pure** tree/format/markdown/navigation helpers consumed by the Svelte components (and the export). The message renderer is now `<SessionEntry>`/`<ToolCall>`; `render/` keeps `session-format`, `markdown`, `entry-format`, `session-entry-actions` (download/share/copy)
- `session-globals.ts`, `session-content-runtime.ts`, `lazy-highlight.ts` — the relocated live glue (see above)
- `chat/` — **pure/shared helpers**: `chat-api` + `git-api` (fetch wrappers), `chat-selectors` (pure model/thinking helpers), `done-notifier` (shared notification/sound/push util, also used by the settings page). Model discovery is session-scoped (`/api/models?id=<sessionId>`) so providers from different runtimes cannot mix. Live composer DOM helpers live under `web/src/components/session/chat/`, wired together by `chat-composer-runtime.js` (`runChatComposer`, mounted by `<ChatComposer>`).
- `live/` — live-only helpers used by `<LiveReload>`: `live-connection.ts` (SSE connection/reconnect lifecycle), `live-events.ts` (SSE/reload primitives), `live-scroll.ts` (low-level scroll primitives), `live-follow.ts` (`createFollowScrollController` — follow-mode decision state + follow button), `live-stats.ts` (header stats), and `chat-preview.ts` (streaming-preview helper, also used by `<BtwPopup>`)
- `ui/` — search/toggle/session-ui-runner helpers used by `setupSessionUi` and `RightSidebar`, plus `sidebar.ts`'s mobile-breakpoint helpers (`isMobileLayout`) and the docked-sidebar drawer toggle (`setSidebarOpen`) still used by the static export (see below)
- `artifacts/` — pure registries/filters + the fetch API wrappers; the panel itself is `ArtifactPanel.svelte`

The index + settings Phase 4 migration is complete: those routes are Svelte-orchestrated too, with only pure/API helpers left outside components.

The optional pinned-session tabs setting adds a compact strip below the desktop
header and status-aware chips below the mobile composer, including a temporary
guest tab for the current unpinned session. Both projections consume one
`SessionShell`-owned `PinnedTabsModel`, whose bounded
`GET /api/sessions?view=home` snapshot contains every unarchived pin in stable
SQLite pin order. While enabled, tabs/chips are the only pinned-session
navigation: the header renders static runtime, title, and shortened working
directory context, and the legacy `PinnedSessionSwitcher.svelte` is not
mounted. Mobile keeps Tree out of both the fixed header and action sheet;
desktop retains it for branch navigation. When tabs are disabled, the centered
header title keeps the lazy anchored popover/mobile bottom sheet and opens no
persistent global stream. Pin mutations update optimistically, reconcile from
the native pican curation state, and roll back on failure. The command palette
remains the broader session-search path.

## Static / Share Export

Export/share remains separate and self-contained. `web/src/export/export-entry.ts` builds `internal/ui/embedded/export/export.js`, which is inlined by `internal/ui/export.go` with vendored `marked` and `highlight.js` assets. Export-only static adapters keep the bundle off live SSE/chat/network modules and the application Effect runtime bridge.

Export rules:

- no Go server dependency
- no live SSE/chat imports
- no `/static/assets/...` dependency
- reusable rendering helpers may be shared with the live app when they are side-effect-free

Plain live states such as worker-down and the view-only composer are supplied only by the SPA. Static exports do not import the worker-status stream, composer, or live header state.

The export's session tree stays a docked `<aside id="sidebar">` (in `internal/ui/embedded/share-session.html`), not the live app's `FullScreenSheet` overlay — it has no resize handle or desktop collapse (those affordances were dropped along with the live docked sidebar), just a mobile hamburger/overlay/close drawer via `sidebar.js`'s `isMobileLayout`/`setSidebarOpen`, wired in `session-ui-runner.js`.

## Live Reload

The session route listens to `/events?id=<sessionId>` via `web/src/session/live/` helpers for:

- `reload` / canonical transcript or projection updates
- `chat-preview` streaming preview updates
- `worker-status` process state updates, including the worker process exit code when it crashes

Worker crash status is read-only UI state. The server preserves the process exit code in `WorkerStatus`, sends it through `/api/worker-status` and the session-scoped SSE stream, and the live `SessionDataModel` projects it into the transcript, header, streaming caret, and composer. This path does not restart or otherwise change worker lifecycle behavior: session files remain append-only, the manager still owns one worker per session, crashed workers are evicted by the existing manager path, and idle workers are reaped after 10 minutes.

Codex, Claude, and OpenCode worker callbacks use the same live contract: native events update status/preview, projection replacement emits reload, and the browser reconciles from `/api/session`. Capability metadata keeps OpenCode's model picker and cancel action available while attachments, steering, queues, effort/reasoning, commands, subagents, approvals, and questions remain absent.

The index route listens to `/events?id=__all__` for `new-session`, `status-snapshot`, and `status-delta`.

The workflows route uses the same `__all__` connection for named `workflows-updated` events, then refetches `/api/workflows` and the selected `/api/workflows/run` detail after a short debounce.

The subagents route also uses the `__all__` connection. It refetches `/api/subagents` after `new-session`, `status-snapshot`, and `status-delta` events so newly created child sessions and running-state transitions appear without a new event type.

## Shared Frontend Modules

- `web/src/shared/api.ts` — JSON fetch helpers
- `web/src/shared/status-events.ts` — shared status SSE lifecycle
- `web/src/shared/storage.ts` — localStorage helpers
- `web/src/shared/escape.ts` — HTML escaping
- `web/src/shared/theme.ts` — authoritative live theme registry, switching, and browser-chrome synchronization for built-in, community, and custom themes
- `web/src/shared/version.ts` — pure version formatting/changelog/fetch helpers; `VersionController.svelte` owns the update modal/status UI
- `web/src/shared/keyboard-nav.ts` — vim-style j/k/gg/G navigation
- `web/src/components/shared/CommandPalette.svelte` — shared ⌘K session search palette

## Automated Frontend Boundaries

`make check` enforces the frontend rules that can be expressed mechanically:

- Oxlint allows `lucide` imports only in `web/src/shared/icons.ts`, rejects inline SVG in Svelte components, and rejects Unicode back/chevron glyphs used as span icons. `ContextUsage.svelte` has the sole inline-SVG exception because its ring is data visualization rather than an icon.
- `web/src/export/export-boundary.test.ts` walks the export dependency graph and rejects live chat, SSE, browser networking, and the application Effect runtime bridge.
- `web/src/shared/strings.test.ts` verifies the English string lookup and parameter interpolation used by Svelte, TypeScript runtime code, and static exports.
- Oxlint, Oxfmt, Svelte formatting, TypeScript and `svelte-check`, Knip, the frontend build, Vitest, Go tests, installer tests, and `go vet` run through the same `make check` gate.

## Static Assets

| Asset                   | Source                                                                                        | Served From                                                                                                                            |
| ----------------------- | --------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------- |
| Vite SPA bundle         | `web/dist/assets/app-*.js`                                                                    | `/static/assets/app-*.js`                                                                                                              |
| Vite lazy chunks        | `web/dist/assets/*.js`                                                                        | `/static/assets/*.js`                                                                                                                  |
| Static export JS        | `internal/ui/embedded/export/export.js` + vendors                                             | inline in exported HTML                                                                                                                |
| Theme CSS               | `internal/ui/embedded/styles/theme.css`                                                       | `/theme.css` (PWA route); inlined in SPA shell (boot script + FOUC prevention need it before any other asset loads)                    |
| Index CSS               | `internal/ui/embedded/styles/index.css`                                                       | `/index.css` (PWA route); also bundled into `/styles/app.css` for the SPA shell                                                        |
| Session CSS             | `internal/ui/embedded/styles/session.css`                                                     | bundled into `/styles/app.css`, linked (not inlined) in SPA shell                                                                      |
| Menu CSS                | `internal/ui/embedded/styles/menu.css`                                                        | `/menu.css` and bundled into `/styles/app.css`                                                                                         |
| Palette CSS             | `internal/ui/embedded/styles/palette.css`                                                     | `/palette.css` and bundled into `/styles/app.css`                                                                                      |
| Workflows CSS           | `internal/ui/embedded/styles/workflows.css`                                                   | bundled into `/styles/app.css`                                                                                                         |
| Tasks CSS               | `internal/ui/embedded/styles/tasks.css`                                                       | bundled into `/styles/app.css`                                                                                                         |
| Subagents CSS           | `internal/ui/embedded/styles/subagents.css`                                                   | bundled into `/styles/app.css`                                                                                                         |
| Custom themes           | `~/.pi/agent/pican/custom-themes.css` (optional)                                              | `/custom-themes.css`                                                                                                                   |
| PWA manifest            | `internal/ui/embedded/assets/manifest.webmanifest`                                            | `/manifest.webmanifest`                                                                                                                |
| Service worker          | `internal/ui/embedded/assets/sw.js`                                                           | `/sw.js`                                                                                                                               |
| Icons                   | `internal/ui/embedded/assets/icon.svg` etc.                                                   | `/icon.svg`, `/icon-maskable.svg`, `/pi-logo.svg`                                                                                      |
| Sound assets            | `internal/ui/embedded/assets/cat.webm`                                                        | `/cat.webm`                                                                                                                            |
| User sound assets       | `~/.pi/agent/pican/assets/*.mp3`                                                              | `/sounds/*.mp3`                                                                                                                        |
| SPA bundled stylesheets | `internal/ui/app_styles.go` (index/session/menu/palette/workflows/tasks/subagents CSS joined) | `/styles/app.css?v=<hash>`, content-hash cache-busted, `Cache-Control: public, max-age=31536000, immutable`, served gzip when accepted |

## Theme System

The live SPA shell uses `theme.css`, `index.css`, `settings.css`, `schedules.css`, `workflows.css`, `tasks.css`, `subagents.css`, `session.css`, `menu.css`, and `palette.css` from `internal/ui/embedded/styles/`. The shell still injects the server-backed theme and font variables before the app starts so first paint matches the installed PWA theme without a flash.

`internal/ui/embedded/styles/theme.css` is the sole owner of named-theme palette variables. Route styles consume those variables but must not redeclare `[data-theme]` palettes. The inline first-paint boot code and the live TypeScript switcher both resolve `--body-bg` / `--chrome-bg` from the active CSS theme, so adding a named theme does not require another hardcoded color map. `web/src/shared/theme.ts` owns the ordered browser theme registry; the Go boot registry must stay aligned because static exports use it without loading the SPA bundle.
