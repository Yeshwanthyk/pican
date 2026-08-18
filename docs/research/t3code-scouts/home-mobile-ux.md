# Home mobile UX — t3code scouting report for pican

**Date:** 2025-08 · **Scope:** read-only research. Reference app: t3code native mobile (`/Users/yesh/Documents/personal/reference/t3code/apps/mobile`). Target: pican's responsive web home/phone experience (`web/src/routes/SessionsPage.svelte`, `web/src/components/index/*`, `internal/ui/embedded/styles/{index,session}.css`).

**Verdict up front:** pican's mobile base is in good shape — 44px touch-target contract, safe-area/keyboard handling via `--viewport-height` + `env(keyboard-inset-height)`, a thumb-zone bottom bar, and a working 44px action menu on each row. The three real gaps versus t3code are (1) the "Waiting on you" rail and Machines section are `display:none` on phones, (2) the phone home feed is a scaled-down desktop feed rather than a phone-native grouped list, and (3) there is no persistent search field in the mobile header (search is buried behind the palette). Fixes 1–3 are all doable in the existing CSS/Svelte without a new shell.

---

## (a) t3code's mobile UX model and what translates to responsive web

### Navigation model: stack + sheets, no tabs, no drawer

- `src/Stack.tsx`: a **root native stack** — `Home` is the only top-level screen. Thread detail pushes; everything else (Settings, New task, Git, Files, Connections) opens as a **sheet** (`formSheet`, iOS detents 0.55–0.92 with a grabber; full-card on Android).
- **Adaptive shell, not a device sniff:** `src/lib/layout.ts` picks the shell from available space: `SPLIT_LAYOUT_MIN_WIDTH = 720` **and** `SPLIT_LAYOUT_MIN_HEIGHT = 600`. Phones (including landscape) stay in the compact shell; iPad/foldable windows get the persistent sidebar. Sidebar width = clamp(32% width, 280…380).
- **One primary action per surface.** "New task" is the single compose affordance: an iOS header-toolbar button or an Android FAB (`AndroidHomeFab.tsx`, 56pt `size-14`, bottom-right, list bottom-padding 88px so the last row clears it).

**Translates to web:** pican already has the equivalent — a floating thumb bar (search/new/menu) instead of a FAB, and modal sheets for New Session / Projects / Command Palette. Keep the thumb bar (it's *better* than a lone FAB for a web app: three thumb-zone actions). The one transferable idea is the **height-aware breakpoint**: pican's breakpoints are pure `max-width`, so a phone in landscape or a small foldable window still gets phone chrome. Consider adding a `max-height` floor before upgrading the chrome (e.g. show the desktop header only when ≥ 901px **and** ≥ ~600px tall).

### Home = a grouped row list, not a grid

- `HomeScreen.tsx` + `features/threads/thread-list-items.tsx` (`thread-list-v2-items.tsx`): one flat virtualized list.
  - **Group headers** per project: collapse toggle + count + quick "+" new-thread button (44pt hit target, `hitSlop` up to 24px vertical — siblings, not nested, for a11y).
  - **Thread rows** (`ThreadListRow`, compact variant): 1-line bold title, colored **status pill** (Running/Waiting), relative time in **tabular-nums**, right chevron, subtitle `env · branch · PR`, hairline separators. Estimated row height 72px; padding 10/10.
  - **Pending/queued rows** with a "Queued" pill (work not yet on the server is still visible and deletable) and **shelf headers** ("Settled (n)", "Snoozed") that collapse; **"Show more / Show less"** rows paginate long sections.
- **Empty states** (`EmptyState.tsx` + `deriveEmptyState()` in `HomeScreen.tsx`): six distinct states (loading envs / no envs / env unavailable / connecting / no projects / no threads), centered, `max-w-[430px]`, each with a **primary action CTA** when one exists ("Add environment"). In-list "No results" state for search.

**Translates to web:** pican's home feed is *already* the grouped-row model (Pinned → Projects → per-project groups → timeline). The deltas to borrow: (i) a **quick "+" per project group** ("new session in this project"), (ii) **persisted group collapse**, (iii) hairline-only rows at 72px with a bolder title on phones, (iv) empty states that always carry an actionable CTA, (v) surfacing queued/waiting work as first-class rows (see §b-1).

### Header: brand + connection status + filter pill + search field

- `HomeHeader.tsx`: Android header = brand lockup, 44pt **filter pill** (`line.3.horizontal.decrease.circle`, filled icon when customized), 44pt settings pill, and a **full-width search field** (`min-h-12` ≈ 48pt, rounded-2xl, magnifier + clear button).
- `WorkspaceConnectionTitle.tsx`: the **brand slot doubles as the connection-status surface** — on reconnect the lockup fades to a status label *in place* (zero layout shift), debounced 800ms so sub-second blips never flash.
- `home-list-filter-menu.ts`: filter/sort lives in **one menu** — Environment / Project / Sort projects / Sort threads — with checkmark state.

**Translates to web:** the two transferable ideas are (i) a **persistent search field** in the mobile header (pican currently hides search behind the palette — see §b-4) and (ii) the **status-in-place, debounced** pattern for pican's SSE reconnect states (see §b-7).

### Gestures: swipe actions + long-press menu, one at a time

- `thread-swipe-actions.tsx`: rows swipe left to reveal **two 58px actions** (Archive blue `#007aff`, Delete red `#ff2d55`) with 36pt icon circles; a full swipe past a threshold **arms and commits** the action with a haptic. Only one swipeable is open at a time; swipes are **gated while the list scrolls** (`useSwipeableScrollGate`); long-press opens a native context menu (Archive / Regenerate title / Delete).

**Translates to web:** swipe-reveal is implementable with pointer events but the full-swipe-commit + haptics + scroll-gating is real work with modest payoff in a web app that already has a per-row ⋯ menu (`ActivityRow.svelte`). Cheapest faithful gesture: long-press is already there; **swipe is a stretch goal** (§b-9).

### Touch targets, dark/light, thumb-zone

- Every control is ≥44pt (`ControlPill` `h-11 w-11`, search `min-h-12`, FAB 56pt, rows full-height tappable, small targets get `hitSlop`). Home horizontal inset 20px (`layoutMetrics.ts`).
- Theme is pure CSS-variable tokens (`--color-*`) resolved per-appearance + `dark:` class variants — exactly pican's model, so nothing to copy.

---

## (b) Concrete pican mobile improvements, mapped to files

Priorities: **P0 = quick wins** (small, isolated, high payoff), **P1 = moderate**, **P2 = larger efforts**.

### P0-1 · "Waiting on you" and Machines are unreachable on phones — promote them into the feed

**The problem:** `.home-rail { display: none; }` at ≤900px (`index.css:1893`) removes the only surface for `HomeRail.svelte`'s two sections: **waiting sessions** (with inline answer-option buttons) and **Machines** (`MachinesSection.svelte`). A phone user cannot see — let alone answer — a session that is waiting on them without opening each session. t3code treats pending work as **first-class rows in the home list** (`PendingTaskListRow` with a "Pending" pill, answerable inline).

**Suggested change:**
- `SessionsPage.svelte`: render the waiting block *inside* the feed, above the Pinned group, when `waitingSessions.length > 0` — e.g. `<section class="mobile-waiting">` reusing the rail's markup, shown only at ≤900px (`index.css`), while the desktop rail keeps its copy.
- Give each waiting row the same anatomy as a feed row (title link + question + answer option buttons), all ≥44pt (the answer buttons already are: `.rail-answer-options button` is in the 44px contract).
- Machines: add a collapsible "Machines" section to the mobile feed below Projects (reuse `MachinesSection.svelte`; its `.machine-toggle` is already a 44px target per the contract at `index.css:2070+`), or at minimum add a Machines entry to `HomeMenu.svelte`'s menu.

**Files:** `web/src/components/index/HomeRail.svelte`, `SessionsPage.svelte`, `MachinesSection.svelte`, `internal/ui/embedded/styles/index.css` (the ≤900px block at ~1872).

### P0-2 · Phone rows are too short for the content they carry

**The problem:** at ≤900px `.activity-row-link { min-height: 60px; }` (base rule `index.css:1696`, mobile override `:1897`) with a 13.5px title (`:1898`) and two-line meta. t3code's compact rows are ~72px (`ESTIMATED_THREAD_ROW_HEIGHT = 72`) with a 17px bold title. On phones, pican's rows are dense enough that the status text + project + runtime + relative time in `.activity-row-meta` wraps and collides with the 44px ⋯ button.

**Suggested change (CSS-only):** in the ≤900px block raise `min-height` to 68px, `padding-block` to 10px, and title to 15px/600; let `.activity-row-meta` truncate at one line with `overflow: hidden; text-overflow: ellipsis` (the second meta line exists to show project/runtime — on phones the primary status + relative time are the only two that matter).

**Files:** `internal/ui/embedded/styles/index.css` (≤900px block).

### P0-3 · Empty states need an action CTA on mobile

**The problem:** `SessionsList.svelte` empty states are text-only for `all`/`archived`/project scopes (`.plain-state`). t3code's `deriveEmptyState()` gives every empty state a primary action when one exists, and pican already does this for the no-tracked-projects state (`<button class="btn-primary empty-add-project">Add project`).

**Suggested change:** for the `all` view "No sessions yet" state, add a primary **"New session"** button wired to `onNewSession` (prop already flows from `SessionsPage.svelte`), mirroring the existing `empty-add-project` pattern; for `archived`, keep it informational (no plausible CTA).

**Files:** `web/src/components/index/SessionsList.svelte`, `internal/ui/embedded/styles/index.css` (`.empty-state`/`.plain-state`).

### P0-4 · Search should be reachable in one thumb tap *and* discoverable

**The problem:** pican's search is ⌘K palette only, launched from the thumb-bar "Search sessions" button (`SessionsPage.svelte`). That button is good; but the *header* at ≤900px (`index.css:1872+`) hides `.header-actions` entirely, so the home header on a phone is just logo + stats — t3code's equivalent header carries brand + filter + **persistent search field**.

**Suggested change (cheap version):** make the thumb-bar search button read like a field (it already does: flex-1, left-aligned "Search sessions") and hide its ⌘K `kbd` on touch devices (`@media (hover: none)` — the `kbd` is currently hidden only at ≤700px for `.nav-search-btn`). Also add a search *field* to the mobile header at ≤900px (replacing the stats row) only if the palette launch feels indirect; the thumb bar is likely enough.

**Files:** `SessionsPage.svelte` (thumb bar), `internal/ui/embedded/styles/index.css` (`@media (max-width: 700px)` block at 1117), `IndexHeader.svelte`.

### P0-5 · Dead CSS: `.new-session-btn-mobile` is defined but never used

**The problem:** `index.css:257` and `:1147` style a floating `.new-session-btn-mobile` FAB that no markup uses (grep across `web/src` and `internal/ui` finds zero usages). It duplicates the thumb bar's role.

**Suggested change:** either delete it or wire it as a **true FAB** for the `all`/`archived`/project views where the thumb bar's "+" is equally relevant — but don't ship both. Deleting is the smallest correct change.

**Files:** `internal/ui/embedded/styles/index.css:257,1147`.

### P1-1 · Scope switching (Projects / All / Archived) should be a visible control on phones

**The problem:** the `.scope-toggle` nav lives in `.header-actions`, hidden at ≤900px (`index.css:1877`); on a phone the only path to All/Archived is the ⋯ menu (`HomeMenu.svelte`). t3code keeps list filters in the header (filter pill → menu). Three destinations is exactly a segmented control's sweet spot.

**Suggested change:** render a compact 3-segment `.scope-toggle` (44px tall segments) in the mobile header below the logo row at ≤900px, reusing existing markup from `IndexHeader.svelte`; hide it again on the project view. This removes a menu hop for the second-most-common navigation.

**Files:** `web/src/components/index/IndexHeader.svelte`, `internal/ui/embedded/styles/index.css` (≤900px block).

### P1-2 · Present New Session as a bottom sheet on phones

**The problem:** `NewSessionModal.svelte` is a centered dialog on all sizes. t3code presents new-task as a bottom-anchored sheet (formSheet); pican's own session page already has the bottom-sheet idiom (`pi-sheet-mobile`, `session.css:5654`: full-width, `align-items: flex-end`, `translateY` slide). Centered dialogs on a phone push the input into the upper thumb zone and feel modal-heavy for a two-field form.

**Suggested change:** at ≤700px apply the pi-sheet-mobile treatment to the new-session modal container: `align-items: flex-end; width: 100%; border-radius: 12px 12px 0 0; transform: translateY(100%)` with the existing `modal-sheet-header` + back affordance (already styled at `index.css:1294`). CSS-only; the modal already has a header/back pattern for sub-screens.

**Files:** `web/src/components/index/NewSessionModal.svelte` (class names), `internal/ui/embedded/styles/index.css` (new ≤700px block), reuse `session.css` `pi-sheet-mobile` pattern.

### P1-3 · Per-project quick action and persisted group collapse

**The problem:** pican's project groups (`ActivityGroup.svelte`) have a "View all (n)" action but no **"new session in this project"** affordance, and group collapse state is not persisted. t3code's `ThreadListGroupHeader` has a sibling "+" button (44pt, `hitSlop` 24/12) and persists collapsed groups (`mobilePreferencesAtom` → `collapsedProjectGroups`).

**Suggested change:** add a "+" button to the `variant="project"` group header on the home feed, wired to `openNewSessionModal` with `newSessionPath = group.project` (the modal already accepts an initial path — `SessionsPage.svelte` sets `newSessionPath = project`). Persist collapsed groups in `localStorage` keyed by project path; `ActivityGroup` already accepts `onAction` for its header action slot.

**Files:** `web/src/components/index/ActivityGroup.svelte`, `SessionsList.svelte`, `SessionsPage.svelte` (initial-path wiring), `internal/ui/embedded/styles/index.css` (header action sizing).

### P1-4 · Waiting sessions need inline answering on the phone

Tied to P0-1 but bigger: t3code answers pending work in-place (opens composer prefilled). pican's desktop rail answers with option buttons (`HomeRail.svelte` `answer()` → `onAnswer` → `sendChat`). When the waiting block moves into the mobile feed (P0-1), keep the **option buttons** — they are the fastest phone path (one tap, no typing). Only fall back to "Open session" when `waitingOptions` is empty (the rail already does this).

**Files:** `web/src/components/index/HomeRail.svelte` (reuse), `SessionsPage.svelte` (`answerWaitingQuestion` already takes session+answer), `ActivityRow.svelte` if waiting rows become feed rows.

### P2-1 · Swipe actions on home rows (stretch)

**Suggested change:** implement a pointer-based left-swipe reveal on `.activity-row` (max-width ~116px for two 58px actions — archive/pin, matching t3code's 58px action width), closing on scroll start and when another row opens; keep the existing ⋯ menu as the discoverable fallback. Skip full-swipe-commit and haptics (see §d). This is the only item that touches interaction code, not just CSS.

**Files:** `web/src/components/index/ActivityRow.svelte`, `internal/ui/embedded/styles/index.css`.

### P2-2 · Reconnect/offline status in the mobile header, in place

**The problem:** pican's SSE reconnect handling (`createStatusEvents` in `SessionsPage.svelte`) silently retries; the only signal is a stale list. t3code surfaces connection state in the header brand slot, debounced 800ms, with no layout shift.

**Suggested change:** when `statusEvents` reports disconnected/reconnecting, swap the header stats row for a compact "Reconnecting…" label with the same debounce idea (500–800ms) so sub-second blips don't flicker. Pure addition to `IndexHeader.svelte` + a `data-state` attribute; no list re-render.

**Files:** `web/src/routes/SessionsPage.svelte` (SSE state → prop), `web/src/components/index/IndexHeader.svelte`, `internal/ui/embedded/styles/index.css`.

### P2-3 · Phone-specific breakpoint with a height floor

**Suggested change:** wrap the existing ≤900px mobile rules' *most aggressive* variants (e.g. body-fixed session shell is already height-aware via `--viewport-height`) — the specific ask: treat "≥901px but <600px tall" (phone landscape, small foldable) as compact. Concretely, add `@media (max-width: 900px), (max-height: 599px) and (min-width: 901px)` to the header/thumb-bar blocks so landscape phones keep the thumb bar instead of the desktop header. Verify against the `min-width: 901px` blocks in `session.css` (3452, 6234, 6432) which set desktop chrome.

**Files:** `internal/ui/embedded/styles/index.css`, `internal/ui/embedded/styles/session.css`.

---

## (c) Quick wins vs larger efforts

### Quick wins (P0 — CSS/Svelte, one afternoon)
1. **Waiting-on-you + Machines reachable on phones** (P0-1) — move the rail's waiting block into the feed at ≤900px; add Machines to the menu or feed. Biggest real gap today.
2. **Taller, clearer phone rows** (P0-2) — 68px rows, 15px title, one-line meta truncation. CSS only.
3. **Empty-state CTAs on mobile** (P0-3) — "New session" button on the `all` empty state. Copy the existing `empty-add-project` pattern.
4. **Hide ⌘K hints on touch** (P0-4) — `kbd` in the thumb bar is desktop noise on phones.
5. **Delete dead `.new-session-btn-mobile`** (P0-5) — or wire it as the FAB; don't ship both.

### Moderate (P1)
6. Scope toggle visible on the phone header (P1-1).
7. New Session as a bottom sheet ≤700px (P1-2).
8. Per-project "+" + persisted group collapse (P1-3).
9. Inline waiting answers in the mobile feed (P1-4).

### Larger efforts (P2)
10. Pointer-based swipe actions on home rows (P2-1).
11. Debounced reconnect status in the header (P2-2).
12. Height-aware mobile breakpoints for landscape/foldables (P2-3).

---

## (d) What NOT to copy (native-only patterns)

- **Liquid Glass / scroll-edge header fading** (`Stack.tsx` GLASS_HEADER_OPTIONS, `StackHeader.tsx`): iOS 26 UIKit sampling the scroll view beneath a transparent bar. pican already has the right web equivalent (opaque `--pi-material-opaque` chrome + `@supports` backdrop blur) and deliberately avoids blur-on-scroll compositing. Don't chase the glass.
- **formSheet detents + grabbers** (`sheetAllowedDetents`, `sheetGrabberVisible`): draggable sheet detents are a native presentation. On web, pick one shape per size: bottom sheet (full-ish) ≤700px, centered dialog above. Half-drag gestures are not worth it.
- **Haptics** (`expo-haptics` on swipe-commit, pill press): no good web equivalent (the Vibration API is gated and unpleasant). pican's `:active { transform: scale(0.96) }` feedback is the right web idiom.
- **Full-swipe-to-commit with spring overshoot** (`THREAD_SWIPE_SPRING`, stretch-to-arm): brittle with touch-action/scroll contention in a browser, and pican already has a discoverable ⋯ menu. If swipe actions land, keep them simple reveal + tap.
- **Windowed list recycling** (LegendList `recycleItems`, `estimatedItemSize`): pican's list is bounded (100/page) with explicit load-more; reaching for virtualization or `content-visibility: auto` on every row is unnecessary. If lists ever get long, `content-visibility: auto` on rows is the web-idiomatic version.
- **Settled/snoozed shelf semantics**: t3code's "Settled (n)" shelves model thread settlement/snooze states pican doesn't have. Don't invent shelf UI for concepts that don't exist; pican's Pinned/Projects grouping already covers list organization.
- **Background outbox / push / Live Activities** (`thread-outbox.ts`, `app-state-wakeups.ts`): app-lifecycle features with no meaning for a browser tab. pican's reload-broadcast + SSE reconnect is the correct web analogue.
- **Empty-detail pane** (split-view Home shows `WorkspaceEmptyDetail`): only relevant once pican adopts a split shell; not a phone pattern.

---

## Appendix — reference map

| t3code file | Pattern | pican counterpart |
|---|---|---|
| `src/lib/layout.ts` | 720×600 adaptive breakpoint | `index.css` / `session.css` @media |
| `Stack.tsx` | stack + sheets, no tabs | `SessionsPage.svelte` + modals |
| `features/home/HomeScreen.tsx` | grouped row list, empty-state matrix | `SessionsList.svelte` |
| `features/home/HomeHeader.tsx` | brand + filter pill + search field | `IndexHeader.svelte` + thumb bar |
| `features/home/AndroidHomeFab.tsx` | 56pt FAB, 88px list bottom pad | `mobile-thumb-bar` (`index.css:1972`) |
| `features/home/thread-swipe-actions.tsx` | 58px swipe actions, one-at-a-time | `ActivityRow.svelte` ⋯ menu |
| `features/threads/thread-list-items.tsx` | group header + "+", row anatomy, show-more | `ActivityGroup.svelte`, `ActivityRow.svelte` |
| `components/EmptyState.tsx` | CTA-bearing empty states | `SessionsList.svelte` `.plain-state` |
| `features/home/WorkspaceConnectionTitle.tsx` | debounced in-place connection status | SSE status in `SessionsPage.svelte` |
| `lib/layoutMetrics.ts` | 20px horizontal inset | `max(16px, env(safe-area-inset-*))` |
