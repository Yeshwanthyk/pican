# pican: pinned session tabs

Branch at planning time: `multi-runtime-opencode-claude` at `97dc080`. Re-check branch/HEAD before starting; other plans (`redesign-effect-ts.md`, `multi-runtime-opencode-claude.md`) may have moved the frontend. Do not revert unrelated changes.

## 0. Outcome

An opt-in quick-switch surface for pinned sessions so the user can hop between active sessions in one gesture, on desktop and mobile. The design was converged through 7 rounds of live prototype grilling; every visual and behavioral decision below is a **user verdict, not a suggestion** — implement exactly, do not re-litigate.

Primary usage is mobile. Polish matters, but UX-first: thumb reach and one-tap switching beat desktop convention wherever they conflict.

Prototype (primary source, throwaway): `plans/prototypes/pinned-tabs-round1.html` — final state shows the locked design; commit it to a throwaway branch per the prototype skill, don't ship it.

## 1. Locked design decisions (the 7 verdicts)

| Round | Question | Verdict |
|---|---|---|
| R1 | Where do tabs live? | **Strip** under header on desktop (>900px); **dock** at the bottom on mobile (≤900px) |
| R2 | Tab anatomy | **Browser-style** tabs on the desktop strip; **Live** (status-forward) tiles on mobile |
| R3 | Mobile overflow with many pins | **Squeeze**: active chip wide, all others collapse to fixed icon chips; never scrolls |
| R4 | Mobile dock ↔ composer join | **Tight**: bare chips row directly under the composer input, same stack, 6px gap, no container |
| R5 | Mobile home page | **List only**: no chips on home; the existing Pinned list section is the surface there |
| R6 | Desktop home page | **Session only**: no strip on home; strip exists only on the session page |
| R7 | Current session not pinned | **Guest tab**: temporary dashed/italic tab for the current session with an inline ○ pin action; evaporates on leave |

Consequences worth spelling out:

- Tabs are **session-page chrome only**. Home (mobile + desktop) is untouched except for whatever already exists.
- There is always an active tab on the session page: either the pinned tab you're in, or the guest tab.
- No horizontal scrolling anywhere in the tab surfaces. Desktop strip shrinks tabs (browser-style `flex: 0 1 190px; min-width: 48px`); mobile squeezes to icon chips.
- The feature is **opt-in** via a setting (default off), since it adds 36px of chrome on desktop and a chip row on mobile.

## 2. Visual spec

All colors/sizes via existing tokens in `internal/ui/embedded/styles/theme.css`. No new hex values. Fonts, radii, and blur treatments must match the existing header/thumb-bar exactly.

### 2.1 Desktop strip (>900px, session page only)

Mount: directly below `.session-header-bar` inside the fixed header stack (see §4.2 for offset math).

Bar:
- height `36px`, padding `0 10px`, `display: flex; align-items: flex-end; gap: 1px`
- background `var(--chrome-bg)`, `border-bottom: 1px solid var(--dim)`
- no scrollbar; tabs shrink instead (`overflow: hidden` as safety, but layout must not overflow with ≤8 pins)

Tab (browser anatomy):
- `height: 31px; padding: 0 8px 0 10px; flex: 0 1 190px; min-width: 48px; gap: 6px`
- `border-radius: 8px 8px 0 0`, `font-size: 11.5px`, color `var(--muted)`
- contents, in order: runtime glyph (15px, existing `/pi-icon.svg` / `/codex-icon.svg` mark treatment), status dot (6px: `var(--accent)` pulsing when running, `var(--attention)` when waiting, transparent when idle), title (ellipsized), close/unpin `×` (hidden, `display: inline` on tab hover; hover style: `color var(--text)`, bg `color-mix(in srgb, var(--dim) 80%, transparent)`)
- hover: `background: color-mix(in srgb, var(--surface-2) 70%, transparent)`
- active: `color: var(--text); background: var(--body-bg); border: 1px solid var(--dim); border-bottom: 0` plus a 1px `::after` strip in `var(--body-bg)` covering the bar's bottom border, so the tab visually merges into the page (Chromium effect)
- after the last tab: a `+` button (`font-size: 15px`, `var(--muted)`) that triggers the existing new-session flow (`#new-session-header-btn` behavior)

Guest tab (current session unpinned):
- same geometry, `font-style: italic`, `border: 1px dashed var(--muted); border-bottom: 0` when active
- instead of `×`, an inline `○` pin button; hover `color: var(--accent)`; clicking POSTs pin → tab converts in place to a normal pinned tab (drop italic/dash, gets `×`)
- always rendered last (after pinned tabs, before `+`)

### 2.2 Mobile chips (≤900px, session page only)

Mount: inside the composer stack, **below** the input (`order: 2; margin-top: 6px`) — the Tight join. No container, no border, no background around the row; chips sit on the composer's existing bottom gradient. The chips row scrolls/lifts together with the composer (keyboard open included, see §4.4).

Row: `display: flex; align-items: center; gap: 5px; min-width: 0`.

Idle chip (not active):
- fixed `40 × 40px`, `border-radius: 9px`
- `border: 1px solid color-mix(in srgb, var(--dim) 80%, transparent)`, `background: color-mix(in srgb, var(--surface) 70%, transparent)`
- centered runtime glyph `17px`; status dot `6px` absolutely positioned `top: 3px; right: 3px`
- waiting: border becomes `color-mix(in srgb, var(--attention) 55%, transparent)` — the amber ring is the "needs you" signal and must be visible without any text

Active chip (the session you're in — Live anatomy):
- `flex: 1 1 auto` (absorbs all remaining row width), `height: 40px`, `padding: 0 11px`, `justify-content: flex-start; gap: 8px`
- `background: var(--surface-2); border-color: var(--dim)`
- contents: glyph, inline status dot, then a two-line block (`line-height 1.25`): title `10.5px var(--text)` ellipsized, activity caption `9px` ellipsized
- activity caption text + color: running → current activity (e.g. `⚡ Bash — grep pins`) in `var(--accent)`; waiting → `awaiting your answer` in `var(--attention)`; idle → `idle · <age>` in `var(--muted)`. Source the caption from the same fields the home list uses (`currentActivity`, waiting state, `lastActivity`).
- width transition `flex-basis .16s ease` when the active chip changes; respect `prefers-reduced-motion` (disable transition and dot pulse)

Guest chip: active-chip geometry with `border-style: dashed; font-style: italic`; long-press or a trailing ○ glyph pins (use a small `○` button inside the chip, 24px hit area minimum — actual hit target padded to ≥40px via padding/pseudo-element).

Capacity: with 40px chips + 5px gaps, a 390px viewport fits the active chip + ~6 idle chips. Do not scroll: beyond that, clamp — render the first N idle chips that fit plus the active/guest chip; overflow pins remain reachable via the existing `PinnedSessionSwitcher` popover (title tap), which stays untouched.

### 2.3 States and edge cases

- 0 pins + current session pinned-nothing: strip shows only guest tab + `+`; chips show only guest chip. Surface still appears (it's how you pin your first session from inside it).
- Feature off (default): nothing renders; all existing offsets unchanged.
- Static export (`web/src/export`): never render tabs. Live-only chrome, same rule as `SessionHeader`.
- Pinned session that no longer exists (stale pin): omit it (the `/api/sessions` join already drops unknown ids).
- `×` on desktop unpins (POST `/api/pins` remove) — it does not close/kill anything. Optimistic removal, toast on failure, matching `SessionCard.svelte`'s optimistic pin pattern.

## 3. Behavior spec

- Tap/click a tab or chip → `navigate('/session?id=' + encodeURIComponent(id))` (existing client-side nav; App.svelte remounts the session tree).
- **Prefetch**: call `prefetchSession(id)` (web/src/routes/session-prefetch.ts) on `pointerenter` and `touchstart`/`pointerdown` for every tab/chip, exactly like `SessionCard.svelte` does. This is mandatory — it's what makes switching feel instant.
- Active detection: current `sessionId` prop (already available in `SessionShell`/`SessionHeader`).
- Ordering: server pin order (`pinOrder`, oldest-pin first) — same as `/api/pins`. Guest last.
- Live status: subscribe to the same global SSE status events the home page uses to refresh summaries; a lightweight shared store (§4.3) keeps captions/dots current without each surface refetching.
- Keyboard (desktop): `⌘1…⌘8` jump to pin N; `⌘⇧[` / `⌘⇧]` cycle. Register in the session page shortcuts layer and document in the ⌘/ shortcuts sheet. Skip if a conflicting binding already exists — check `CommandMenu`/shortcut registry first and prefer non-conflicting alternates (`Alt+1…`) over breaking existing bindings.
- Guest pin action: POST to `/api/pins` (same call as `SessionCard`), optimistic UI (guest converts immediately), rollback + toast on failure.

## 4. Implementation

### 4.1 Setting (opt-in)

- Key: `sessionTabs` (values `"off"` default / `"on"`), added to `SERVER_SETTING_KEYS` in `web/src/shared/settings-store.ts` **and** `settingDefaults` in `internal/server/settings.go` (both allowlists required for server sync).
- UI: a toggle in `web/src/components/settings/SessionDisplayDefaultsSettings.svelte` (Session Display section) labeled "Pinned session tabs" with help text "Show pinned sessions as tabs inside a session for quick switching."

### 4.2 Desktop strip mount + offsets

- New component `web/src/components/session/PinnedTabsStrip.svelte`, rendered in `SessionShell.svelte` directly after `SessionHeader` (the seam where `PinnedSessionSwitcher` already mounts).
- The session layout hard-codes a 52px header offset (`internal/ui/embedded/styles/session.css` ~line 3215) and mobile reserves `52px + safe-area-inset-top` (~line 3306). When tabs are on, desktop content offset becomes `88px` (52 + 36). Implement by setting a class on the shell root (e.g. `.has-session-tabs`) and overriding the offset custom-property/rules in `session.css` — do not fork the layout. Mobile offsets are untouched (chips live in the composer, not the header).
- WCO/PWA mode: the strip renders below the draggable title bar and must be `app-region: no-drag` (children of `:root.wco .session-header-bar` already handle this pattern — mirror it).

### 4.3 Shared pins store

- New `web/src/session/pinned-tabs-store.svelte.ts` (Svelte 5 runes store): holds `NormalizedSession[]` for pins, fetches `/api/pins` + `/api/sessions` join on session-page mount (reuse the join logic currently inside `PinnedSessionSwitcher.svelte` — extract it, don't duplicate), refreshes on the global SSE status/reload events (same events `SessionsPage.svelte` subscribes to) and on pin/unpin mutations.
- Both `PinnedTabsStrip` and the mobile chips consume this store. `PinnedSessionSwitcher` should be refactored to consume it too (single source of truth), but its UI stays as-is.

### 4.4 Mobile chips mount

- New component `web/src/components/session/PinnedChips.svelte`, rendered inside the composer stack in `ChatComposer.svelte` (or `SessionShell` if the composer stack lives there — locate the sticky bottom wrapper and place chips as its last child, `order` below the input). It must live inside the same fixed/sticky element as the input so iOS keyboard handling (the visual-viewport pinning in session.css ~line 3229) moves them together.
- Hidden at >900px via the existing mobile media query breakpoint (900px, matching session.css).
- Export build must tree-shake it out: gate on the same live-only condition that excludes the header/composer from exports.

### 4.5 CSS

- All styles in `internal/ui/embedded/styles/session.css` (project convention: global CSS, no scoped styles). New sections: `/* Pinned session tabs (desktop strip) */` and `/* Pinned session chips (mobile) */`. Use only theme tokens; copy exact values from §2.
- `prefers-reduced-motion`: kill dot pulse and chip width transition.

### 4.6 Backend

None. `/api/pins` (GET/POST), `pinned`/`pinOrder` on summaries, and SSE status events already exist. Only the settings allowlist entry from §4.1.

## 5. Waves and gates

**Wave 1 — store + setting.** Extract pin-list join into `pinned-tabs-store`, refactor `PinnedSessionSwitcher` onto it, add the `sessionTabs` setting (both allowlists + settings UI). Gate: existing switcher behaves identically (manual check), settings round-trips through server, `npm test` in `web/` passes.

**Wave 2 — desktop strip.** `PinnedTabsStrip` + strip CSS + 88px offset wiring + guest tab + prefetch + unpin + `+`. Gate: with setting on at >900px, strip matches §2.1 pixel-for-pixel against the prototype; with setting off, zero layout change; WCO mode drag regions intact.

**Wave 3 — mobile chips.** `PinnedChips` + chips CSS + Tight join in the composer stack + squeeze behavior + guest chip. Gate: on a real phone (or 390px + touch emulation): no horizontal scroll at 7 pins, active chip caption live-updates, keyboard open keeps chips attached to the input, amber waiting ring visible.

**Wave 4 — behavior polish.** Prefetch on hover/touchstart verified (network tab), keyboard shortcuts, SSE-driven status updates on both surfaces, reduced-motion. Gate: switching between two warm sessions feels instant (< ~300ms perceived); e2e smoke (`e2e/`) covering: enable setting → pin two sessions → switch via tab → guest tab pin.

Commit per wave. After the final gate, move the prototype file to a throwaway branch and note the verdict table in the commit message.
