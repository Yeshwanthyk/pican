# t3code scout: session interactions & global navigation

**Scope:** t3code `apps/web` + `apps/mobile` session/task views, transcript/message interactions, streaming/status indicators, navigation chrome, keyboard, search, toasts — read against pican's session view, home page, and shared chrome. Read-only; no code changed.

**Files surveyed (t3code):**
- Web: `components/chat/MessagesTimeline.tsx` (+`.logic.ts`, `timelineScrollAnchoring.ts`), `ChatHeader.tsx`, `ChatComposer.tsx`, `ContextWindowMeter.tsx`, `ThreadSyncStatusPill.tsx`, `ThreadErrorBanner.tsx`, `components/Sidebar.tsx`, `components/CommandPalette.tsx` (+`.logic.ts`, `commandPaletteBus.ts`, `search/ProjectContentSearchDialog.tsx`), `keybindings.ts`, `components/ui/toast.logic.ts`, `browserFaviconStore.ts`/`browserFaviconLogic.ts`
- Mobile: `features/threads/` (ThreadFeed, ThreadDetailScreen, thread-feed-live-follow, thread-list-v2-items, threadListV2, ThreadNavigationSidebar), `features/keyboard/HardwareKeyboardCommandProvider.tsx`, `features/shortcuts/appShortcuts.ts`
- Packages: `contracts/src/keybindings.ts`

**Files surveyed (pican):** `routes/SessionsPage.svelte`, `routes/SessionPage.svelte`, `components/session/` (SessionShell, SessionHeader, SessionInfoHeader, SessionContent, SessionEntry, ActivityFold, LoadEarlier, LiveReload, ConnectionStatus, SessionActivityDock, ChatComposer, GitFooter, AskQuestion, RightSidebar, ArtifactPanel, CommandMenu, ShortcutsModal), `components/index/` (IndexHeader, SessionsList, SessionCard, HomeRail), `components/shared/CommandPalette.svelte`, `shared/keyboard-nav.ts`, `shared/toast.ts`, `shared/english.ts`, `session/live/live-follow.ts` + `live-scroll.ts`, `internal/ui/embedded/styles/session.css`.

**Headline finding:** pican is already ahead of where this exercise usually lands — it has a floating follow button, live "running command · elapsed" activity rows, a connection-status pill, a context-window popover, anchor-preserving LoadEarlier, and a session tree. The highest-value work is not greenfield; it is *finishing* half-built patterns (pending-count follow button, dismissible errors, palette modes, header actions) and adopting t3code's *scroll-position/read-state machinery* (minimap, jump-to-user-turn, anchored deep links).

---

## (a) t3code patterns worth adopting

Ranked by leverage for pican.

### A1. Timeline minimap (left-edge rail) — `MessagesTimeline.tsx` → `TimelineMinimap`
A thin rail at the left edge of the transcript, one tick per **user message**. Hovering shows a glass card with the user prompt + a 3-line preview of the assistant's final response; click/scroll on the rail jumps; ArrowUp/Down/Home/End navigate ticks. Ticks light up as they enter the viewport (`data-in-view`). This is the single most distinctive t3code transcript affordance and directly answers "where am I in a 2-hour session".

### A2. Foldable turn + work-log structure — `MessagesTimeline.tsx` → `TurnFoldTimelineRow`, `WorkGroupToggleTimelineRow`
Between turns, a thin `border-b` row shows a timestamp + chevron to fold the previous turn. Work logs collapse to **"+N previous tool calls / log entries"** disclosure rows. Fold state is smart: an *interrupted* turn stays expanded so the user keeps their place; the next turn folds the previous one (see the `latestTurn` effect in `MessagesTimeline.tsx`).

### A3. Scroll-position machinery as pure logic — `timelineScrollAnchoring.ts`, `MessagesTimeline.logic.ts`, `thread-feed-live-follow.ts`
Three small pure modules, each unit-tested, that own:
- **live-follow state machine** (`thread-feed-live-follow.ts`): `reset → true`, `user-scroll-begin → false`, `user-scroll-end → isAtEnd`, `scroll → isAtEnd ? true : current`. pican's `createFollowScrollController` (`session/live/live-follow.ts`) already implements this shape — t3code's is the same idea, formalized as a reducer.
- **anchored deep links** (`timelineScrollAnchoring.ts`): scroll so a target message's turn end is revealed, with `maintainVisibleContentPosition` so folding/expansion doesn't yank the viewport.
- **row stability** (`useStableRows` in `.logic.ts`): memoized row identity so streaming re-renders only the changed row.

### A4. Self-ticking inline timers — `MessagesTimeline.tsx` → `WorkingTimer`, `Sidebar.tsx` → `WorkingDuration`
"Working for 12s" and per-row "12m" labels update **their own text node** via `setInterval` instead of re-rendering the component tree each second. pican already does this in `ActivityFold` (`now = Date.now()` ticker) — the pattern to copy is *text-node mutation* so a 1s tick never re-renders a row's markdown.

### A5. Header as breadcrumb + inline rename + right-click menu — `ChatHeader.tsx`
- Project name leads the header ("knowing which project a thread lives in is priority zero"), thread title is a **button that opens the action menu** with a hover-revealed chevron.
- **Inline rename in the header**: clicking the title enters a focused input (`autoFocus`, select-on-focus, Enter commits, Escape cancels, blur commits) — no `prompt()`.
- Right-click on the header area opens the same thread menu.
- `resolveRenameCommit()` is a tiny pure function (trim → reject-empty / noop / commit).

### A6. Config-driven keybindings + jump hints — `packages/contracts/src/keybindings.ts`, `Sidebar.tsx` → `JumpHintBadge`
A command registry with `when` contexts (terminal focus, preview open, …). The flagship UX: **thread jump** — `thread.jump.1..9`, `thread.previous/next`. While ⌘ is held, a floating mono digit pill (`JumpHintBadge`) overlays each visible sidebar row (pointer-events-none, doesn't displace the status label); pressing `⌘1` jumps. The badge is *shown only while the modifier is held*, so it never clutters the resting UI. `modelPicker.jump.1..9` does the same inside the model picker. pican's closest analog is `PinnedTabsStrip` / `PinnedSessionSwitcher`.

### A7. One search overlay, three modes — `CommandPalette.logic.ts`, `ProjectContentSearchDialog.tsx`
One reducer owns `{open, mode: "command" | "files" | "content"}` so ⌘K (commands), ⌘P (file picker), and ⇧⌘F (project **content** search) can never stack, and re-triggering a mode's shortcut toggles it closed. Content search renders results **grouped by file, syntax-highlighted lines with match emphasis** (`HighlightedSearchLine`), windowed rendering (100 rows, sentinel-based growth), and case/whole-word/regex toggles. `commandPaletteBus.ts` is a 20-line CustomEvent bus so any component can open the palette without owning its state.

### A8. Status color language, consistent everywhere — `thread-list-v2-items.tsx`, `Sidebar.tsx`
A fixed hue convention: **approval = amber, input (needs you) = indigo, working = sky, failed = red**. The same colors appear in the sidebar, the mobile list, Live Activity, and widgets, so a thread reads the same everywhere. `threadListV2.ts` (`resolveThreadListV2Status`) is the single source of truth. t3code also *reserves the status slot's width* so labels swapping don't shift layout, and dims settled rows (opacity on favicon, muted title).

### A9. Rich, stacked, scoped toasts — `components/ui/toast.tsx` + `toast.logic.ts`
Toasts carry `title` + `description` + optional action, stack vertically, collapse behind-toasts to a compact chip, and can be **thread-scoped** (`shouldRenderThreadScopedToast`) so a toast about another thread is suppressed while you're reading this one.

### A10. Floating scroll-to-end affordance — `ThreadDetailScreen.tsx`
When the user has scrolled away from the end, a small pill (chevron-down) floats **above the composer**; tapping it re-pins to the end. pican has the exact mechanism already (`createFollowButton`) but it ignores the pending count it tracks.

### A11. Dismissible, session-scoped error banner — `ThreadErrorBanner.tsx`
Errors render as a dismissible alert at the *top* of the transcript (full text in a hover tooltip, 3-line clamp in place). Dismissal is remembered **per (thread, message)** in a module-level Set, so navigating away and back doesn't resurrect it, but a *different* error on the same thread still appears.

### A12. Everything else (smaller)
- Favicon reflects live state (`browserFaviconStore.ts`/`browserFaviconLogic.ts`).
- Pending approval/question cards **own the composer slot**, collapsing to a bar (`ThreadDetailScreen.tsx`, `PendingUserInputCard.tsx`, `ComposerPendingApprovalPanel.tsx`) — pican's `ExtensionUiCard` + `AskQuestion` cover this; the composer-slot takeover is the part worth borrowing.
- Hardware keyboard commands with per-screen registration + most-recent-wins (`HardwareKeyboardCommandProvider.tsx`) — the pattern for pican's per-route shortcut sets.
- Launcher/app shortcuts: static "New task" + rotate 3 recent threads, href allowlist (`appShortcuts.ts`).
- "Woke" / terminal-process / PR badges on sidebar rows; `role="status"` live regions per row.
- Empty timeline state: "Send a message to start the conversation." (pican's is fine but t3code's copy sets the expectation).

---

## (b) Concrete pican improvements (mapped to files)

Priority-ordered. Each names the t3code pattern (A#), the pican file, and the specific change.

### B1. Follow button should show the pending count + be reachable on mobile
- **Pattern:** A10 (floating scroll-to-end), A3 (live-follow reducer).
- **Files:** `web/src/session/live/live-scroll.ts` → `setFollowButtonText()`; `web/src/session/live/live-follow.ts` → `createFollowScrollController`; `internal/ui/embedded/styles/session.css` → `.follow-button`.
- **Change:** `createFollowScrollController` already increments `pendingCount` and calls `showFollowButton()` — but `setFollowButtonText(button, _pendingCount)` discards it and always renders a bare arrow. Render the count: `↓ {pendingCount}` badge (resetting on click, as t3code's `scroll-to-end` does by re-pinning). Also: the button is centered above the composer — fine on desktop; on `@media (max-width: 900px)` t3code's pill sits directly above the composer bar; move pican's `.follow-button` to sit above `--pi-chat-composer-height` (it already uses that var) and increase hit target to ≥44px.
- **Effort:** Small. State already exists; this is a render + CSS change.

### B2. Dismissible worker-down / connection error banner (with session-scoped dismissal)
- **Pattern:** A11 (ThreadErrorBanner).
- **Files:** `web/src/components/session/SessionContent.svelte` (the `plain-state--worker-down` block), plus a small `$state`/module-set dismissal keyed `sessionId` (mirror `ThreadErrorBanner.tsx`'s `sessionDismissedThreadErrorBannerKeys`); `web/src/shared/english.ts` → add `session.workerExitedDismissed`/`session.dismissError`.
- **Change:** Keep the end-of-transcript marker but render it as a compact dismissible banner (X button) at the *top* of `#messages` when `model.workerStatus.state === 'error'`, full text in the existing `session.workerExited` copy + tooltip. Dismissal survives navigation within the session but resets on a new error code. pican already has `session.workerDown` shown in `SessionHeader`; the banner adds the *dismiss + hint* behavior (`workerExitedHint` already exists in strings).
- **Effort:** Small.

### B3. Jump numbers (⌘/Ctrl+1..9) for pinned session tabs
- **Pattern:** A6 (thread.jump + JumpHintBadge).
- **Files:** `web/src/components/session/PinnedTabsStrip.svelte` (+ `PinnedSessionSwitcher.svelte`), `web/src/shared/keyboard-nav.ts` → add a jump handler, `web/src/components/session/ShortcutsModal.svelte` → new category row.
- **Change:** When the pinned-tabs setting is on (`sessionTabsEnabled`, plumbed through `SessionShell`), bind `Meta/Ctrl+1..9` to activate the nth pinned tab (same action as clicking the tab — see `PinnedTabsStrip`'s tab activation). While the modifier is held, overlay a floating digit pill on the first 9 tabs (pointer-events-none, absolutely positioned, matching `JumpHintBadge`). Reuse `ShortcutsModal`'s static rows for discoverability. This is the single most impactful shortcut for pican's core workflow (multi-session switching) because pican *already has* the pinned-tab strip; it's missing only the numbers.
- **Effort:** Small–medium (one keydown handler + CSS overlay + modal row).

### B4. Timeline minimap for long sessions
- **Pattern:** A1 (TimelineMinimap) + A3 (pure logic).
- **Files:** new `web/src/session/render/timeline-minimap.ts` (pure: derive ticks from `model.activePath` user entries, `resolveMinimapIndexFromPointer`, viewport-intersection set); new `TimelineMinimap.svelte` mounted in `SessionContent.svelte`; `internal/ui/embedded/styles/session.css`; `web/src/shared/english.ts` → `session.minimapAria` strings.
- **Change:** Render one tick per user message in a ~18px rail at the left edge of `#messages-list`. Hover shows user prompt + assistant-response preview (pican has both in `SessionEntry`/`ActivityFold` data via `getToolResultLookup`/`messageBlocks` — reuse `createEntryMarkdownCache`). Click jumps by `scrollIntoView({block:'start'})` on `entry-<id>`. Show only when ≥ ~8 user messages (`TIMELINE_MINIMAP_MIN_ITEMS` pattern) and only `@media (pointer:fine)` — mobile already has the follow button + tree. Gate on `sessionTree`-style URL param? No — keep it CSS-visible on hover only.
- **Effort:** Medium (pure logic + one component + CSS). Highest perceived-value transcript feature.

### B5. Transcript content search (⇧⌘F) inside the session
- **Pattern:** A7 (ProjectContentSearchDialog), A1 (jump to match).
- **Files:** `web/src/components/shared/CommandPalette.svelte` → add a "search in transcript" mode (or a second overlay); `web/src/components/shared/command-palette.ts` → `filterPaletteSessions` sibling `searchTranscriptEntries`; `web/src/routes/SessionPage.svelte` → pass `model.entries` (already reactive) + `navigateTo`-style scroll; `web/src/shared/english.ts` → `palette.searchTranscript`, `palette.transcriptNoMatches`.
- **Change:** ⌘⇧F opens the palette overlay in transcript mode. Query filters text blocks of user/assistant entries + tool commands (`entry.message.content` text blocks, `bashExecution.command`, `ToolOutput` text are all in the model). Results: entry snippet with match highlighted (t3code `HighlightedSearchLine`), grouped, max ~50; Enter/click scrolls to `entry-<id>` and flashes the `new-entry-highlight` class pican already has. Respect `LoadEarlier` truncation: search loaded entries, hint if `model.truncated` ("results only cover loaded messages").
- **Effort:** Medium (client-side filter + overlay mode + scroll). Big win for long sessions; no server work needed.

### B6. Inline rename in the session header (kill `window.prompt`)
- **Pattern:** A5 (ChatHeader inline rename).
- **Files:** `web/src/components/session/SessionHeader.svelte` → add rename mode to the title element; `web/src/components/session/CommandMenu.svelte` → 'rename' action sets header-rename mode instead of `window.prompt`; `web/src/session/session-menu-actions.ts` → `renameSession` already exists; `web/src/shared/english.ts` → `session.renameTitle`.
- **Change:** Command menu "Rename" (or double-click/title menu) swaps the title span for an input (`autofocus`, `select()`, Enter → `renameSession`, Escape → cancel, blur → commit) mirroring `ChatHeader.tsx`. Reuse `resolveRenameCommit`-style trim/noop handling. The header already re-renders from `sessionTitle` store, so the input just calls the same `setSessionTitle` path.
- **Effort:** Small.

### B7. Keyboard-shortcut registry as single source of truth
- **Pattern:** A6 (contracts keybindings registry), plus t3code's `kbd` component.
- **Files:** new `web/src/shared/keybindings.ts` (command → {keys, when, description}); `web/src/shared/keyboard-nav.ts`, `web/src/components/session/SessionHeader.svelte`, `web/src/components/session/ChatComposer.svelte` read from it; `web/src/components/session/ShortcutsModal.svelte` renders *from* the registry instead of its hand-maintained `groups` array.
- **Change:** Today `ShortcutsModal.svelte` hardcodes key labels (⌘K, ⌘B, ⌘T, ⇧I, ⌃I …) while handlers live scattered in `keyboard-nav.ts`, `SessionsPage.svelte`, and the composer runtime — they drift. Move to one `Record<command, {keys, when, desc}>`; the modal, header tooltips, and handlers all derive from it. This makes B3 (jump numbers), ⌘, (settings, exists), and any future shortcut one-line changes.
- **Effort:** Medium (mechanical refactor, well-covered by existing tests in `keyboard-nav.test.ts`).

### B8. Header breadcrumb: clickable project → project home; right-click → action menu
- **Pattern:** A5 (breadcrumb + context menu).
- **Files:** `web/src/components/session/SessionHeader.svelte` — the `session-header-project` span currently only has a `title` tooltip; make it an `<a href={withBasePath('/?project=' + encodeURIComponent(cwd))}>` using `handleNavClick` (same pattern as `IndexHeader`'s `project-back`). Add `oncontextmenu` on the header bar that dispatches the same open action as `command-menu-btn` (or reuse `CommandMenu`'s `#command-menu-btn` `.click()` — the menu already closes on outside click, so a `preventDefault` contextmenu opening it is a 5-line change in `CommandMenu.svelte`'s `onMount`).
- **Effort:** Small.

### B9. Unify status colors + reserved status slot on session cards
- **Pattern:** A8 (color language + slot reservation).
- **Files:** `web/src/components/index/SessionCard.svelte` + `internal/ui/embedded/styles/session.css` (home cards), `web/src/components/session/SessionActivityDock.svelte` (`session-dock-count` colors) — pick pican's CSS vars (`--attention`, `--error`, `--success`, add a `--working`-equivalent) and use one mapping: needs-you = attention, running = info/working hue, failed = error, idle = muted. Ensure the status label slot has a fixed width (`min-width`) so streaming "waiting 12s — …" doesn't reflow the card.
- **Effort:** Small (CSS + one mapping module, e.g. `session/activity-status.ts`).

### B10. Toast: add optional title + description line
- **Pattern:** A9 (rich toasts).
- **Files:** `web/src/shared/toast.ts` (`showToast` options), `session.css` → `.toast-notice` styles.
- **Change:** Keep the single-slot design (it's simple and pican's callers rely on it), but render a two-line layout when `title` is passed (title currently becomes a native tooltip via `notice.title = title`). Several callers already pass titles (`new-session-toast`, `extension-notify` with `notification.type`) that would benefit. No stacking — pican's one-at-a-time semantics are fine; t3code's stacking is a "larger effort" (B12).
- **Effort:** Small.

### B11. Favicon reflects running/waiting state
- **Pattern:** browserFaviconStore/browserFaviconLogic.
- **Files:** `web/src/routes/SessionsPage.svelte` (has `setRunningSessions`/`onDelta` in `createStatusEvents`) — in `onDelta`/`onSnapshot`, paint a dot on the favicon via a canvas data-URL (document head link swap). Guard with `matchMedia('(prefers-reduced-motion)')`-adjacent sanity and only when any session runs/waiting.
- **Effort:** Small (one helper, ~30 lines, easily unit-tested with an injected document).

### B12. (Larger) Foldable turns + "+N work entries" disclosure
- **Pattern:** A2 (TurnFold + WorkGroupToggle).
- **Files:** `web/src/session/render/group-tool-runs.ts` (already groups tool runs into `ActivityFold` groups — extend to emit a foldable turn boundary + a `+N previous` toggle when a turn's tool count exceeds a threshold), `web/src/components/session/SessionContent.svelte` + `ActivityFold.svelte`.
- **Change:** pican's `ActivityFold` is per-turn already (one fold per assistant activity). The gap is *grouping consecutive turns* into a folded "turn" boundary (timestamp + chevron) and a `+N previous tool calls` disclosure when a turn had many tool runs. This is where transcript density control lives; pair with the settings that already exist (`toolsVisible`, `toolOutputsExpanded`).
- **Effort:** Larger (rendering model change; touches the shared live/export render path — must stay export-safe per the project contract).

### B13. (Larger) Anchored deep links to messages
- **Pattern:** A3 (anchoredEndSpace / timelineScrollAnchoring).
- **Files:** `web/src/components/session/SessionEntry.svelte` already renders `id="entry-<id>"` and `copyMessageLink` already copies a link — **the link target exists but nothing consumes it on load**. Add: on `SessionPage` mount, read a `?msg=<id>` param (or hash), wait for hydration, scroll `entry-<id>` into view with the *turn end* revealed (t3code: reveal end of the anchor's turn, not its top), and flash `new-entry-highlight`. Reuse `LoadEarlier`'s anchor-capture/restore helpers (`captureAnchor`/`restoreAnchor` are right there in `LoadEarlier.svelte`).
- **Effort:** Larger but mostly wiring; the primitives exist.

---

## (c) Quick wins vs larger efforts

### Quick wins (a focused afternoon each)
| # | Change | Files |
|---|--------|-------|
| Q1 | Follow button shows pending count + mobile hit target | `live-scroll.ts` (`setFollowButtonText`), `session.css` `.follow-button` |
| Q2 | Dismissible worker-down banner (session-scoped dismissal) | `SessionContent.svelte`, `english.ts` |
| Q3 | ⌘/Ctrl+1..9 jump to pinned tabs + held-modifier digit pills | `PinnedTabsStrip.svelte`, `keyboard-nav.ts`, `ShortcutsModal.svelte` |
| Q4 | Inline rename in header (kill `window.prompt`) | `SessionHeader.svelte`, `CommandMenu.svelte` |
| Q5 | Clickable project path in header → `/?project=` home; right-click header → command menu | `SessionHeader.svelte`, `CommandMenu.svelte` |
| Q6 | Status color language + fixed-width status slot on home cards/dock | `SessionCard.svelte`, `SessionActivityDock.svelte`, `session.css` |
| Q7 | Toast title renders as a second line instead of tooltip | `toast.ts`, `session.css` |
| Q8 | Favicon dot for running/waiting | `SessionsPage.svelte` status-events glue |

### Larger efforts (worth sequencing)
| # | Change | Files |
|---|--------|-------|
| L1 | Timeline minimap w/ hover previews | new `TimelineMinimap.svelte` + `session/render/timeline-minimap.ts`, `SessionContent.svelte` |
| L2 | Transcript content search (⇧⌘F) | `CommandPalette.svelte`, `command-palette.ts`, `SessionPage.svelte` |
| L3 | Keybinding registry → ShortcutsModal renders from it | `shared/keybindings.ts`, `ShortcutsModal.svelte`, `keyboard-nav.ts` |
| L4 | Anchored `?msg=` deep links (turn-end reveal) | `SessionPage.svelte`, `LoadEarlier.svelte` helpers, `SessionEntry.svelte` |
| L5 | Turn folds + "+N previous tool calls" disclosure | `group-tool-runs.ts`, `SessionContent.svelte`, `ActivityFold.svelte` |
| L6 | Palette/file/content overlay unification (⌘K/⌘P/⇧⌘F one reducer) | `CommandPalette.svelte`, `command-palette.ts` |

Suggested order: **Q1→Q8 (polish pass)** → **L3 (registry, unblocks more shortcuts)** → **L2 (search)** → **L1 (minimap)** → **L4/L5 (transcript density & deep links)**.

---

## (d) What NOT to copy

1. **The config/keybindings infrastructure wholesale.** t3code's registry is backed by contracts schemas, a server-served config, `when`-expression parsing, and per-platform label resolution (`keybindings.ts`, `contracts/src/keybindings.ts`). pican needs *one* `Record<command, {keys, when, desc}>` (B7), not a DSL. Adopt the *idea* (jump numbers, single source of truth), skip the machinery.
2. **Minimap on touch devices.** t3code gates the minimap on `@media (pointer:fine)`. pican's mobile already has the follow button, tree overlay, and PinnedTabs — a hover-driven rail is dead weight there. Skip it; keep only the (already planned) count-aware follow button.
3. **Snooze/settle lifecycle.** t3code's settle/snooze/wake lifecycle (thread-list-v2, threadSettled) is a product decision layered on their settlement model. pican's archive + pin + waiting-on-you already covers the *user-facing* outcomes (declutter + defer + flag). Copying "Settled" shelves would add a state machine without pican's server model.
4. **"New thread in project" via header breadcrumb click.** t3code's project crumb button starts a new thread in that project. pican's project crumb should navigate to the project home (B8), not create a session — accidental session creation from a nav affordance is a worse default for pican's one-session-per-project model.
5. **Mobile questionnaire takeover choreography.** `ThreadDetailScreen`'s pending-user-input card owns the composer slot with shared-value animations, keyboard-reserve math, and per-platform inset corrections — exquisite but irrelevant to pican's web-first layout where `AskQuestion`/`ExtensionUiCard` already render inline in the transcript and the composer stays available. Copy the *composer-stays-available* behavior pican has; don't import the takeover.
6. **App-launcher quick actions** (`appShortcuts.ts`). This is an Expo/native-launcher feature; pican is a web app. The *recent-sessions ordering with href allowlist* idea is only relevant if a PWA manifest/shortcut integration ever lands.
7. **Always-visible copy/fork/link action rows → hover-revealed.** t3code hides per-message actions behind hover. pican's always-visible `actions()` row in `SessionEntry.svelte` is better for discoverability (and required for touch). Don't regress to hover-only; if noise is a concern, follow t3code's *timestamps* pattern (hover-reveal the timestamp meta) but keep actions visible.
8. **Toasts that stack and thread-scope** (toast.logic.ts's visible-index reflow). pican's single-slot toast is intentional and its callers assume replacement semantics (`showToast` reuses one element per id). Stacking changes timing expectations across the app for marginal gain — B10 (two-line content) is the right size.

---

## Appendix: pican strengths confirmed (don't touch)
- `LiveReload` + `createFollowScrollController` (`session/live/live-follow.ts`): follow-scroll state machine, pending counter, sent-message follow window — matches t3code's live-follow reducer.
- `LoadEarlier.svelte`: anchor capture/restore with frame-retry — *better* than t3code's anchored loading in some respects (handles height settling).
- `ConnectionStatus.svelte`: delayed (1.2s) centered status pill — the ThreadSyncStatusPill pattern, already done.
- `ActivityFold.svelte`: live "running {command} · {elapsed}" summary with per-second ticker — the WorkingTimelineRow pattern.
- `ContextUsage` popover — the ContextWindowMeter pattern.
- `GitFooter` split button + PR actions, steer/queue composer, extension UI cards, artifacts sidebar with resizer: all beyond t3code's equivalent surfaces.
