# t3code → pican: Home Page Desktop Web UX Scout

**Scope:** Read-only study. Reference: `t3code` web app (`apps/web`, React 19 + Tailwind 4 + shadcn-style `ui/` kit). Target: `pican` home page (`web/src/routes/SessionsPage.svelte` + `components/index/*` + `internal/ui/embedded/styles/index.css`).

**t3code reference files cited below (all under `apps/web/src/`):**
- `components/ui/empty.tsx` — composed empty-state primitive
- `components/pullRequest/PullRequestListEmptyState.tsx` — per-reason empty states with inline SVG media
- `components/pullRequest/PullRequestGhosts.tsx` — list-shaped loading skeletons
- `components/ui/skeleton.tsx` — shimmer skeleton for inline placeholders
- `routes/_chat.index.tsx` — index-route hero / draft drop-in behavior
- `components/Sidebar.tsx` — thread rows: status model, attention/recede logic, hover-reveal actions, settled-tail paging, in-list search
- `components/pullRequest/PullRequestRow.tsx` — 3-column list row, `content-visibility`, memo
- `components/pullRequest/PullRequestListFilters.tsx` — search input + single filter menu with active-dot
- `routes/_chat.pull-requests.tsx` — page header, ghost-on-first-load, stale-data banner, refresh
- `hooks/useLiveRefresh.ts` — visibility-aware refresh policy
- `components/sidebar/SidebarChrome.tsx` — sidebar header/footer chrome
- `index.css` — design tokens (`--control-radius`, `--sidebar-content-inset`, `--workspace-topbar-height`)

---

## (a) What t3code does well on home/dashboard UX that pican lacks

### 1. Empty states are composed, differentiated, and actionable — pican's are plain text
t3code has a reusable empty-state vocabulary (`ui/empty.tsx`: `Empty / EmptyHeader / EmptyTitle / EmptyDescription / EmptyContent / EmptyMedia`) and surfaces that use it to distinguish **why** a list is empty. `PullRequestListEmptyState.tsx` covers four distinct reasons — *no projects*, *searching (ghost rows)*, *nothing matches "query"* (names the query, offers *Clear search* + *Check again*), *nothing under these filters* / *no pull requests* (offers *Load more* / *Check again*) — each with an action that actually fits the reason. The `EmptyMedia` icon tile has a subtle layered-shadow treatment so the empty page reads as "the same surface with nothing on it", not a broken one.

pican's equivalents are two lines of muted text (`SessionsList.svelte` → `.plain-state-line` / `.plain-state-hint`, `index.css:603-620`) with a CTA only on the *no tracked projects* state. *No sessions yet* says "no sessions yet" and offers nothing; *no archived sessions* and *no project sessions* have no action; the loading state is the same visual language as the empty state (a text line), so "loading" and "empty" are momentarily indistinguishable.

### 2. Loading is skeletons shaped like the content, not a text line
`PullRequestGhosts.tsx` renders bars in the **geometry of the actual rows** (glyph circle + title bar + meta bar + right-aligned time/diffstat), with a deterministic width cycle (`TITLE_WIDTHS`/`META_WIDTHS`) so the ghost looks identical on every render, and a **single container-level opacity pulse** (`animate-ghost-pulse`) instead of per-bar shimmer — one composited animation, and `muted-foreground/15` bars read on both themes. `ui/skeleton.tsx` provides the standard shimmer for inline spots.

pican's home loading state is `<div class="empty-state plain-state">Loading sessions…` (`SessionsList.svelte`) — text, no structure, and no visual continuity with the feed it is replacing.

### 3. The list row carries a status/attention hierarchy
In `Sidebar.tsx` every thread row resolves a `topStatus` (Working / Monitoring / Approval / Input / Failed / Done / Woke) with a **consistent hue system**, and in-flight or read-but-boring rows **recede**: `shouldRecede` drops idle/working rows to dimmed text + reduced opacity, reserving visual prominence for rows that need a human (waiting on input, unread "Done", failed). The comment is explicit about the design intent: *"inbox-zero: working threads aren't your problem yet — only the colored status label stands out."* Status color is shared across web/mobile surfaces so a thread reads the same everywhere.

pican's `ActivityRow.svelte` gives every row equal weight: running/waiting get accent hues, but idle rows render at full strength too, so a 30-row feed is uniformly loud and "what needs you" does not pop. There is also no cross-surface color contract — `workspace-stat-waiting` uses `--attention`, `activity-row-status--waiting` mixes `--attention` with text — small, but the t3code discipline of *one hue per state, everywhere* is absent.

### 4. Hover-reveal actions crossfade with the row instead of reserving a gutter
In t3code's sidebar rows, the status/time slot **yields to action buttons on hover** (`group-hover:opacity-100`, `pointer-events` gating, `focus-visible` fallback), so the row's reading content owns the full width at rest. Every icon action is wrapped in a `Tooltip`. The pinned glyph stays visible as a passive marker even when pinning is not interactive.

pican's `ActivityRow.svelte` hard-reserves `padding: 8px 92px 8px 2px` on every row (`index.css` `.activity-row-link`) and renders two 44px invisible buttons (pin, archive) pinned to the right edge always (`opacity: 0`, revealed on row hover). The result: ~92px of title/status space is wasted on every row even when the user never hovers, and the buttons have no tooltips (only `title`/`aria-label`).

### 5. List chrome: search + one filter control, with state feedback
The PR list page header is a two-control strip — `PullRequestSearchInput` (icon in an `InputGroup`, busy spinner while a search is in flight) and a single filter `MenuTrigger` that shows a **dot when any filter is off-default** (`PullRequestListFilters.tsx`). Filters live in the URL (shareable/back-button-safe). Rows can be filtered **in place** by title search in the sidebar (`searchSidebarThreadsByTitle` in `Sidebar.logic.ts`).

pican's home search is a ⌘K command palette (`openSessionPalette`); there is no visible search field in the feed and no in-feed filtering. The scope toggle (Projects/All/Archived) is a small text segmented control in the header. Notably, `ActivityRow.svelte` **already computes `sessionSearchText(session)` and stamps it as `data-search={search}` on every row** — the data for in-feed search exists today and is unused.

### 6. Refresh policy is explicit about visibility and cost
`useLiveRefresh.ts` codifies one policy: refresh on arrival, on window focus, and periodically while visible — gated by a minimum interval, stopped when the window is idle/hidden, and never doubled on first mount (the view's own first read is on its way). The PR page also shows a **stale-data banner** when the latest read failed: *"The latest request failed. Showing the last pull requests loaded."* + Retry (`_chat.pull-requests.tsx`).

pican's `SessionsPage.svelte` has a strong SSE-driven refresh (500 ms debounced `scheduleReload`, `shouldRefetchOnReload` throttle) but: no refresh on `visibilitychange`/`focus` (a tab resumed after a laptop lid-close shows stale data until the next SSE broadcast), and a failed soft refresh keeps the old list **silently** — no "showing last loaded list" affordance.

### 7. One surface model for rows; one token set for geometry
t3code rows share one surface contract — plain row at rest, `bg-accent/60`-style hover, focus ring, status as content — and geometry comes from semantic tokens (`--sidebar-content-inset`, `--sidebar-row-content-inset`, `--control-radius` in `index.css`). Long lists use `[content-visibility:auto]` + `[contain-intrinsic-block-size]` (both `PullRequestRow.tsx` and sidebar rows) so a long list costs what the viewport shows.

pican's home CSS has **three overlapping vocabularies stacked in one 2200-line file**: legacy timeline (`date-separator`, `timeline-section`, `session-card`), the "Wave 4.1" ticker (`session-ticker-row`, `home-layout` grid), and "V6 material" chrome. `MachinesSection.svelte` still uses the legacy `.timeline-section`/`.date-separator` classes inside the otherwise-V6 `HomeRail` — visibly a different vocabulary two blocks apart. Rows re-render everything (no `content-visibility`), though page size is bounded at 100 (`PAGE_SIZE` in `SessionsPage.svelte`).

### 8. History is paged inside the list
The sidebar settled-tail renders 10 rows initially and expands +25 behind the shelf ("Show more") rather than dumping full history at full weight (`SETTLED_TAIL_INITIAL_COUNT = 10`, `SETTLED_TAIL_PAGE_COUNT = 25` in `Sidebar.tsx`). pican already does the analog for **pinned** (`PIN_PREVIEW_LIMIT = 8` + "Show all"), but the date-bucket timeline in `?view=all` renders every bucket fully and relies on the API `Load more` page at 100.

---

## (b) Concrete pican improvements (file → change)

Priorities P1 (quick, high value) → P3 (larger effort). All CSS changes go in `internal/ui/embedded/styles/index.css` unless noted.

### P1-1. Ghost-row loading skeleton
**Files:** `web/src/components/index/SessionsList.svelte`, `index.css`
**Change:** Replace the `plain-state` "Loading sessions…" block with ghost rows in the **activity-row geometry**: 24px icon circle, one title bar (~13.5px), one meta bar (~10.5px), right-aligned time bar; deterministic width cycle; one container `opacity` pulse animation (port `PullRequestGhosts.tsx`'s `animate-ghost-pulse` + `GhostBar`; bars colored `color-mix(in srgb, var(--muted) 18%, transparent)` instead of a white shimmer so it reads on both themes). Keep the existing `index-layout-ready` fade. No logic change — pure markup + CSS.

### P1-2. Collapse the right rail when it has nothing to say
**Files:** `web/src/routes/SessionsPage.svelte`, `index.css`
**Change:** `<HomeRail>` currently renders an empty `<aside class="home-rail">` whenever `waitingSessions.length === 0 && peerHosts.length === 0` (the aside and both sections are unconditional in `SessionsPage.svelte`/`HomeRail.svelte`). On a 1440px desktop this wastes the second grid column (`grid-template-columns: minmax(0, 760px) minmax(260px, 1fr)`; `index.css` `.home-layout`) — a ~300px dead gutter for the most common case. Fix: render `<HomeRail>` only when it has content, and give `.home-layout` a rail-less variant (single `minmax(0, 760px)` column, centered) toggled by a class on the main. This mirrors t3code's `SidebarInset` behavior — the content surface always owns the full remaining width.

### P1-3. Idle rows recede; waiting/running pop
**Files:** `web/src/components/index/ActivityRow.svelte`, `index.css`
**Change:** Port the `shouldRecede` idea at the CSS level. Add `class:session-ticker-row--idle={!running && !waiting && !session.pinned}` and a recede style: title at reduced weight/opacity, meta dimmed, `opacity-70`-ish on the row at rest, restoring to full on `:hover`/`:focus-within`. Waiting keeps `--attention`, running keeps `--accent`. The feed then reads as "what needs you first" (t3code: *"only the colored status label stands out"*). Pure CSS + one class binding; no data changes.

### P1-4. Hover-reveal actions instead of the 92px gutter
**Files:** `web/src/components/index/ActivityRow.svelte`, `index.css`
**Change:** Remove the reserved `padding: 8px 92px 8px 2px` on `.activity-row-link`; render pin/archive as absolutely-positioned overlays that fade in on row `:hover`/`:focus-within` (crossfade with the timestamp slot like t3code's `group-hover/sidebar-status-slot` pattern — hide the time, show the buttons). Keep the pinned glyph as a passive always-visible marker (`activity-row-marker` already exists). Recover ~92px of title/status width per row at rest. Keep `title` attributes (pican has no tooltip primitive; do not add one for this).

### P1-5. Search the feed in place (data already exists)
**Files:** `web/src/components/index/SessionsList.svelte`, `web/src/index/sessions.ts`, `web/src/shared/english.ts`, `index.css`
**Change:** `ActivityRow` already computes `sessionSearchText(session)` and stamps `data-search` on every row — the search index is already rendered to the DOM. Add a compact search input above the feed (port `PullRequestSearchInput`'s `InputGroup` look: icon + input + busy spinner, ~32px tall) that filters rows by the existing `data-search` text client-side; show a differentiated "Nothing matches — Clear search" empty state (see P2-1). Keep ⌘K palette as-is; this is scoped search, not a replacement. Needs ~20 lines of filter logic in `SessionsList.svelte` plus a couple of `index.*` strings.

### P2-6. Composed, differentiated empty states
**Files:** `web/src/components/index/SessionsList.svelte`, `web/src/shared/english.ts`, `index.css` (optionally a small `EmptyState.svelte`)
**Change:** Port the `ui/empty.tsx` composition (centered column: media tile → title → description → action row) and make each home empty state reason-specific with a fitting action, mirroring `PullRequestListEmptyState.tsx`:
- *No sessions yet* → title "Start your first session" + CTA **New session** (needs `onNewSession` threaded from `SessionsPage.svelte` — it already has `openNewSessionModal`).
- *No tracked projects* → existing CTA **Add project** moves into the composed layout.
- *No archived sessions* → hint only (no action fits; leave it actionless like t3code's state-separated cases).
- *Search: nothing matches "q"* → **Clear search** (new, pairs with P1-5).
Give the empty state a quiet inline media (the `EmptyMedia` layered-tile trick is cheap: two rotated `scale-84` copies behind the icon, `opacity`-based, no new assets).

### P2-7. Visibility-aware refresh + stale-data banner
**Files:** `web/src/routes/SessionsPage.svelte`, `web/src/shared/english.ts`, `index.css`
**Change:** (a) Add `visibilitychange` + `focus` listeners that call `refreshSessions({ preserveWindow: true })` guarded by the existing `shouldRefetchOnReload`/throttle helpers (pican already has the throttle machinery in `sessions.ts:149` — extend, don't replace the SSE path; t3code's `useLiveRefresh` is the policy reference). (b) When a refresh fails but `sessions.length > 0`, show a slim banner under the header: "Couldn't refresh — showing the last loaded list" + Retry (port the PR page's stale banner: amber surface, small outline Retry button). Currently a failed soft refresh is silent (`refreshSessions` only clears `loading`).

### P2-8. One vocabulary for the home column
**Files:** `web/src/components/index/MachinesSection.svelte`, `index.css`
**Change:** `MachinesSection` uses legacy classes `.timeline-section`, `.date-separator`, `.date-separator-label`, `.date-separator-count` while `HomeRail`'s Waiting block uses `.rail-section`/`.rail-heading`. Convert MachinesSection to `rail-section`/`rail-heading` (+ a small `rail-heading-count`), deleting the legacy class usages from the home path. Purely cosmetic consistency; makes the rail render as one column with one heading style (11px uppercase, `index.css` `.rail-heading`).

### P2-9. In-feed grouping counts and "show more" for timeline buckets
**Files:** `web/src/components/index/SessionsList.svelte`, `web/src/index/sessions.ts`
**Change:** Port t3code's settled-tail paging to the `?view=all` date buckets: render the first N per bucket (e.g. 10, mirroring `SETTLED_TAIL_INITIAL_COUNT`) with a bucket-level "Show all {count}" expander (the `ActivityGroup` component already supports `count` + `actionLabel` + `onAction` — reuse it; today `count` is only shown, and buckets render fully). Keeps long history scannable without burying recent work.

### P3-10. Header declutter: scope tabs into the page body
**Files:** `web/src/components/index/IndexHeader.svelte`, `SessionsList.svelte` (or a new strip), `index.css`
**Change:** t3code's titlebar carries only brand + environment pill; page-level concerns live in the content header. pican's header packs seven elements (logo+title, stats, scope toggle, Add project, Search, New session, menu). Move the scope toggle (Projects/All/Archived) into the page as a tab row above the feed (the PR page's `INVOLVEMENT_TABS`/`STATE_TABS` pattern — glyph + label, active state, URL-driven), leaving the header: brand, stats, search, new-session, menu. This is the biggest structural change; only worth it if the header continues to feel crowded after P1-4/P2-8.

### P3-11. `content-visibility` for long lists
**Files:** `web/src/components/index/ActivityRow.svelte` (or `.activity-row` CSS), `index.css`
**Change:** Add `content-visibility: auto; contain-intrinsic-block-size: 60px` to `.activity-row` for the `?view=all` timeline, exactly as `PullRequestRow.tsx` does (`[content-visibility:auto] [contain-intrinsic-block-size:54px]`). Pure CSS, but verify `data-sessions-content` test selectors and scroll behavior — the bounded home feed (≤100) may not need it; apply only if long timelines are measurably janky.

---

## (c) Quick wins vs larger efforts

**Quick wins (≤ ~1–2 h, mostly CSS + tiny markup):**
1. P1-1 Ghost-row loading skeletons (markup + one CSS animation).
2. P1-2 Collapse the empty right rail (one conditional in `SessionsPage.svelte` + a grid variant).
3. P1-3 Idle rows recede (one derived class + CSS).
4. P1-4 Hover-reveal actions, remove the 92px gutter (CSS).
5. P1-5 In-feed search reusing `sessionSearchText`/`data-search` (small filter fn + strings).
6. P2-8 Machines rail vocabulary unification (class swap).

**Larger efforts (P2–P3):**
- P2-6 Composed empty states (new component + strings + media treatment).
- P2-7 Visibility refresh + stale banner (new listeners + banner UI + strings).
- P2-9 Per-bucket "show more" paging (grouping logic in `sessions.ts`).
- P3-10 Header restructure / scope tabs in body.
- P3-11 `content-visibility` (if needed after measuring).

---

## (d) Things to explicitly NOT copy

1. **Auto-drop into a draft thread on index load.** `_chat.index.tsx` navigates the user straight into a new draft for the most recent project ("the first screen is a prompt instead of a dead end"). pican's home is a multi-project management hub with an intentional feed of existing sessions; auto-creating/navigating on load would destroy the at-a-glance purpose, create sessions without user intent, and fight the pinned/projects organization. Do not port `IndexDraftLanding`.
2. **Settle / snooze / auto-settle lifecycle** (`effectiveSettled`, `canSnooze`, wake timers, `SnoozePopoverButton`, dnd-kit pinned reorder). Deep server capability tied to t3code's thread model and capabilities manifest; pican's pin/archive covers the manageable subset. Drag-to-reorder pinned cards especially — a heavy dependency for a rare action.
3. **The `ui/` component library / Tailwind migration.** Do not port shadcn-style primitives (button variants, tooltip, menu, popover, sheet) or Tailwind v4 into pican. pican's hand-rolled CSS with semantic variables (`--surface`, `--dim`, `--muted`, `--accent`, `--attention`, `--pi-material-*`) is cohesive, theme-aware, and deliberately tuned for mobile perf ("V6 — restrained material", opaque surfaces, no backdrop blur in the feed). Copy **patterns** (composition, ghost geometry, attention model), not the stack.
4. **Frosted-glass chrome.** t3code uses glass tooltips/popovers; pican deliberately moved to opaque material with `backdrop-filter: none` on the feed for scroll performance. Keep pican's material policy.
5. **Master-detail right panel** (PR detail split-view, `rightPanelStore`, preview panel). pican opens sessions in a separate route; introducing a persistent right panel is a different information-architecture decision, not a home-page polish item.
6. **⌘1..⌘9 thread jump hints / `JumpHintBadge` overlay** — keyboard-scaffolding for an always-open sidebar list; pican's navigation model is ⌘K + click-through.
7. **The global keybinding engine / `resolveShortcutCommand` context system** — the ⌘K palette (`web/src/shared/keyboard-nav.js`) already covers pican's needs.

---

## Suggested order of execution

1. P1-1 skeletons + P1-2 rail collapse + P1-3 idle recede (one afternoon; the feed stops looking "empty or busy" and starts looking alive).
2. P1-4 hover actions + P1-5 in-feed search (recovers layout space and makes the existing `data-search` work pay off).
3. P2-6 empty states + P2-7 refresh/stale banner (trust-building; the two states that currently feel dead-end).
4. P2-8 vocabulary + P2-9 bucket paging (consistency + long-list scanability).
5. P3-10/P3-11 only if the header still feels crowded or long timelines measure janky.
