# pican: pinned session tabs

Rebased planning snapshot: `multi-runtime-opencode-claude` at `0a6e79b` on
2026-07-24. Preserve all existing runtime, performance/cache, focused-home, and
archive work. `plans/prototypes/` is unrelated user work: do not edit, move,
stage, or commit it.

## 0. Outcome

Add an opt-in quick-switch surface for pinned sessions so the user can hop
between active sessions in one gesture on desktop and mobile.

Primary usage is mobile. Thumb reach and one-tap switching win over desktop
convention wherever they conflict. The seven placement/anatomy verdicts remain
the product direction; the implementation details below are rebased onto the
current focused Projects home, pican-local Archive, four runtimes, and current
Svelte session shell.

## 1. Locked design decisions

| Round | Question | Verdict |
|---|---|---|
| R1 | Where do tabs live? | **Strip** under the header on desktop (>900px); **dock** at the bottom on mobile (≤900px) |
| R2 | Tab anatomy | **Browser-style** tabs on the desktop strip; **Live** status-forward tiles on mobile |
| R3 | Mobile overflow with many pins | **Squeeze**: active chip stays readable, other visible pins collapse to fixed icon chips, and overflow remains in the existing pinned-session sheet; never scroll |
| R4 | Mobile dock ↔ composer join | **Tight**: bare chips row directly below the composer shell, same stack, 6px gap, no separate panel |
| R5 | Mobile home page | **List only**: no chips on home; the focused home's existing Pinned section remains the surface there |
| R6 | Desktop home page | **Session only**: no strip on home; strip exists only on the session page |
| R7 | Current session not pinned | **Guest tab**: temporary dashed/italic active tab with an explicit Pin action; evaporates on leave |

Consequences:

- Tabs are session-page chrome only. Do not change the Projects, All Sessions,
  Archived, project-detail, desktop rail, or mobile thumb-bar home UI.
- There is always an active tab/chip on the session page: either the current
  pinned session or a guest representation of the current unpinned session.
- No tab surface scrolls horizontally. Both viewports cap visible pins and keep
  the complete ordered set in the existing `PinnedSessionSwitcher`.
- The feature is opt-in and defaults off because it adds 36px of desktop chrome
  and one 40px mobile row.
- Pin/unpin actions use the existing `Pin`/`PinOff` icon vocabulary. Do not use
  `×` for unpinning or `○` for pinning; those imply close/selection rather than
  the curation action that actually occurs.

## 2. Integration contract

### 2.1 Current product boundaries

- The default `view=home` response is the bounded source for the tab model. It
  includes every unarchived pin plus Now and at most six sessions per tracked
  project. Do not query or render the thousands-session All view to resolve
  pins.
- Pin and Archive are mutually exclusive pican-local curation states. Pinning
  an archived session atomically restores it; archiving a pinned session
  atomically unpins it.
- Pi, Codex, Claude, and OpenCode all use the same tab components. Render marks
  through `runtimeDisplay()` so icon-backed runtimes and the OpenCode initial
  fallback stay consistent with the rest of the UI.
- Static export/share remains unchanged and must not import the store, global
  status stream, settings, or tab/chip components.

### 2.2 Shared session-page model

Create one session-page-owned model instance, not an app-global curation store
or module singleton. `SessionShell` owns it and passes it explicitly to
`PinnedSessionSwitcher`, `PinnedTabsStrip`, and `PinnedChips`.

The model:

- fetches only `GET /api/sessions?view=home`;
- normalizes the response, filters `pinned === true`, and sorts by `pinOrder`;
- stores the running ID/status snapshot separately from session summaries;
- loads eagerly and opens one `__all__` status connection only while the tabs
  feature is enabled;
- when the feature is off, loads lazily when `PinnedSessionSwitcher` opens and
  does not keep a global status connection alive;
- applies `status-snapshot` and `status-delta` to running state immediately;
- refetches the bounded home summaries after a relevant `reload:<id>`, using
  the existing five-second known-ID throttle rather than refetching per token;
- refetches immediately on `curation-updated` and on reconnect; and
- updates optimistically for pin/unpin, then rolls back and toasts on failure.

This replaces the currently broken `/api/pins` +
`/api/sessions?limit=1&view=all` join in `PinnedSessionSwitcher`. Do not extend
the backend or add an IDs query for this slice.

## 3. Visual spec

Use existing tokens from `internal/ui/embedded/styles/theme.css`; add no hex
values. Match the current session header, popover, composer, focus ring, and
reduced-motion vocabulary.

### 3.1 Desktop strip (>900px, session page only)

Mount a fixed sibling directly after `.session-header-bar`, positioned at
`top: 52px`.

Bar:

- `height: 36px; padding: 0 10px; display: flex; align-items: flex-end; gap: 1px`
- `background: var(--chrome-bg); border-bottom: 1px solid var(--dim)`
- no scrollbar and no silently clipped interactive item

Tab:

- `height: 31px; padding: 0 8px 0 10px; flex: 0 1 190px; min-width: 48px; gap: 6px`
- `border-radius: 8px 8px 0 0`, `font-size: 11.5px`, color `var(--muted)`
- runtime mark from `runtimeDisplay()` at 15px
- status dot at 6px: accent/pulsing while running, attention while waiting,
  transparent while idle
- ellipsized title
- `PinOff` action hidden until hover or keyboard focus, with an accessible
  "Unpin session" label; it unpins and never closes, cancels, archives, or
  deletes the session
- hover background:
  `color-mix(in srgb, var(--surface-2) 70%, transparent)`
- active tab:
  `color: var(--text); background: var(--body-bg); border: 1px solid var(--dim); border-bottom: 0`,
  plus a 1px body-background strip covering the bar border
- after the session tabs, a `+` button invokes the existing
  `#new-session-header-btn` behavior and obeys the current runtime's `create`
  capability

Guest tab:

- same geometry with `font-style: italic` and a dashed active border
- trailing `Pin` action with an accessible "Pin session" label
- pinning converts the guest in place to a normal pinned tab
- always appears after the visible ordered pins and before `+`

Capacity:

- render at most eight session tabs, counting the guest if present;
- the current pinned session must remain visible even if it falls outside the
  first eight pins; replace the last visible inactive pin, then retain server
  pin order among the visible set; and
- the centered header title continues to open the complete pinned-session
  switcher for overflow. Do not add a second overflow menu.

### 3.2 Mobile chips (≤900px, session page only)

Mount `PinnedChips` in `ChatComposer.svelte`:

- normal chat branch: directly after `.pi-chat-shell` and before
  `TextAttachmentModal`/`GitFooter`;
- view-only branch: inside `.pi-chat-composer--view-only`, after its resume
  action; and
- never use `order: 2`: the current composer is `display: block`, so that rule
  has no effect.

The row shares the existing `var(--body-bg)` composer surface. It has no
separate container, border, blur, or background:
`display: flex; align-items: center; gap: 5px; min-width: 0; margin-top: 6px`.
Because it remains inside the composer's bottom stack, the existing visual
viewport and composer-height handling moves it with the iOS keyboard.

Idle chip:

- fixed `40 × 40px`, `border-radius: 9px`
- token-based dim border and surface background
- centered runtime mark at 17px
- status dot at 6px in the top-right corner
- waiting changes the border to the attention color so it remains recognizable
  without text

Active chip:

- `flex: 1 1 auto; min-width: 136px; height: 40px; padding: 0 11px`
- current surface/border tokens, runtime mark, inline status dot, and a
  two-line ellipsized title/activity block
- running caption uses the latest known `currentActivity`, waiting says
  "awaiting your answer", and idle uses `idle · <age>` when a summary is
  available
- an unpinned current session absent from `view=home` falls back to the
  `SessionShell` title/runtime/waiting/worker state and the caption `idle`; do
  not add a backend field just to synthesize an age
- width transition is 160ms ease-out and is disabled with reduced motion

Guest chip uses active geometry, dashed/italic treatment, and an explicit
trailing `Pin` action with a 40px touch target. Do not use long-press as the
only action.

Capacity:

- preserve the active/guest chip's 136px minimum before adding idle chips;
- a small component-local `ResizeObserver` computes
  `floor((rowWidth - activeMinimum) / 45)` and clamps the ordered idle pins;
- the current session is always present; and
- overflow stays reachable through the header's existing bottom sheet. Do not
  add horizontal scrolling or a second mobile menu.

### 3.3 States and edge cases

- Zero pins: show only the guest tab/chip and desktop `+`.
- Feature off: render no new strip/chips and preserve every existing layout
  offset. The header's current pinned-session switcher still works.
- Missing/orphaned pin: omit it because `view=home` returns only resolvable
  summaries.
- Archive mutation: `curation-updated` removes the now-unpinned session from all
  tab surfaces. Archiving the current session keeps the existing navigation to
  `/`.
- Pinning an archived current session: update the session page's local
  `archived` state to false through the existing `onArchiveChange` path so the
  Command Menu immediately changes from Restore to Archive.
- View-only session: tabs/chips remain usable; runtime chat capability does not
  gate navigation or pinning.
- Static export: never render or import this live-only chrome.

## 4. Behavior

- Click/tap a tab or chip:
  `navigate('/session?id=' + encodeURIComponent(id))`. `App.svelte` already
  remounts `SessionPage` when the ID changes.
- Prefetch every destination with `prefetchSession(id)` on the exact existing
  `SessionCard` events: `pointerenter`, `mousedown`, and `touchstart`.
- Active detection uses the current `sessionId`.
- Ordering uses ascending server `pinOrder`; guest is last.
- Status dots update immediately from snapshot/delta. Captions, waiting state,
  and activity timestamps update from throttled bounded-summary refetches
  because the SSE status payload does not contain those fields.
- Do not add pinned-tab keyboard shortcuts in this slice. `⌘1…8` and
  `⌘⇧[`/`]` are browser-owned on normal web surfaces. Existing `⌘K`, the header
  switcher, and one-click tabs already cover desktop navigation without a
  browser/PWA-only shortcut layer.

## 5. Implementation

### 5.1 Setting and hydration

- Key: `pican:v1:session-tabs`, value `"true"`/`"false"`, default `"false"`.
- Add it to `SERVER_SETTING_KEYS` in `web/src/shared/settings-store.ts` and
  `settingDefaults` in `internal/server/settings.go`.
- Add the toggle to
  `web/src/components/settings/SessionDisplayDefaultsSettings.svelte`, using
  `t()` strings: label "Pinned session tabs"; help text "Show pinned sessions
  inside a session for quick switching."
- `SessionPage` owns the reactive enabled value, reads local storage for first
  paint, and passes it to `SessionShell`.
- Reuse the settings hydration already started by
  `startSessionPageRuntime()`: add one optional completion callback so
  `SessionPage` rereads the key when server hydration finishes. Do not issue a
  second `/api/settings` request or introduce a global settings store.

### 5.2 Model and existing switcher

- Add `web/src/session/pinned-tabs-model.svelte.ts` as a factory-created Svelte
  5 model with explicit `start()`, `load()`, mutation, and `dispose()` methods.
- Construct/dispose it with `SessionShell`; never retain it across a
  session-page remount.
- Refactor `PinnedSessionSwitcher.svelte` to consume the same instance. Keep
  its anchored desktop popover, mobile bottom sheet, search action, and current
  pin/unpin action visually unchanged.
- Replace its false `limit=1` test fixture with a truthful `view=home` payload.

### 5.3 Desktop strip and offsets

- Add `web/src/components/session/PinnedTabsStrip.svelte` after
  `SessionHeader` in `SessionShell`.
- Toggle a session-page body class while enabled and clean it up on unmount.
- Define one desktop-only custom property:
  `--session-header-offset: 52px`, overridden to `88px` when enabled.
- Apply that property to every current desktop header-dependent seam:
  `#app` margin/height and the expanded right sidebar top/height. Do not patch
  one consumer while leaving another at 52px.
- Keep all mobile header/safe-area math explicitly at the existing 52px; chips
  live at the bottom, not under the mobile header.
- Give the strip its own WCO/PWA `app-region: no-drag` rule; the current rule
  covers header descendants only.

### 5.4 Mobile chips

- Add `web/src/components/session/PinnedChips.svelte` at both resolved
  `ChatComposer` mount points from §3.2.
- Pass the shared model and current-session fallback presentation explicitly.
- Let the current composer height observer include the added row; do not add a
  second keyboard/visual-viewport controller.
- Hide chips above 900px with the existing breakpoint.

### 5.5 CSS, strings, and documentation

- Put styles in `internal/ui/embedded/styles/session.css` using the existing
  global CSS convention.
- Add every user-facing label/caption through
  `web/src/shared/english.ts`/`t()`.
- Disable dot pulse and width transitions under
  `prefers-reduced-motion: reduce`.
- After implementation, update `docs/architecture/frontend.md` to replace its
  stale `/api/pins` + `/api/sessions` join description with the session-owned,
  bounded `view=home` model and its curation/status refresh behavior.

### 5.6 Backend

No new endpoint, table, runtime capability, projection field, or native
lifecycle action. The only backend change is the settings allowlist/default
entry. Existing `/api/sessions?view=home`, `/api/pins` mutation,
`curation-updated`, status SSE, and archive transaction are sufficient.

## 6. Waves and gates

**Wave 1 — truthful model + setting.** Add the setting/hydration callback,
extract the session-owned model, and refactor `PinnedSessionSwitcher` from the
broken `limit=1` join to `view=home`.

Gate:

- a multi-pin fixture returns every pin in `pinOrder`;
- archived/orphaned sessions do not appear;
- existing switcher UI and search behavior remain unchanged;
- feature-off opening is lazy and creates no persistent global SSE connection;
- enabled/disabled values survive cold server hydration; and
- focused frontend tests pass.

**Wave 2 — desktop strip.** Add `PinnedTabsStrip`, guest state, Pin/PinOff
actions, prefetch, capability-gated `+`, eight-tab cap, and unified 88px offset.

Gate:

- setting off causes zero layout change;
- current session remains visible with more than eight pins;
- transcript and expanded right sidebar share the same offset;
- keyboard focus exposes the unpin action and labels it precisely; and
- WCO drag regions remain usable.

**Wave 3 — mobile chips.** Add the Tight composer join in both composer
branches, active fallback presentation, minimum-width capacity calculation, and
guest Pin action.

Gate:

- 390px and 320px widths have no horizontal overflow;
- active/guest text retains its minimum width;
- overflow pins remain in the existing bottom sheet;
- view-only sessions still render and switch pins;
- keyboard open keeps the chips attached to the composer; and
- waiting attention state is visible without text.

**Wave 4 — live behavior and product integration.** Finish snapshot/delta
updates, throttled relevant reloads, curation/reconnect refresh, archive
coordination, optimistic rollback, accessibility, reduced motion, docs, and
E2E coverage.

Gate:

- pinning an archived direct session restores it and updates Command Menu state;
- archiving a pin removes it everywhere and current-session archive still
  navigates home;
- Pi, Codex, Claude, and OpenCode marks render through `runtimeDisplay()`;
- prefetch fires on hover/mouse/touch before navigation;
- switching between warm sessions feels immediate;
- static export has no tab/chip/store/status imports; and
- E2E smoke covers enable → pin two → switch → guest pin → archive/restore.

Commit implementation in logical wave-sized blocks. Do not touch
`plans/prototypes/` during implementation or verification.
