# Composer + Queue UX — t3code scout findings for pican

Research date: 2026-08-18 (session)
Scope: read-only. Sources:
- t3code reference checkout: `/Users/yesh/Documents/personal/reference/t3code` (apps/web, apps/mobile, packages/contracts, packages/shared)
- pican: `web/src/components/session/`, `web/src/session/chat/`, `internal/server/chat_queue_drainer.go`, `internal/ui/embedded/styles/session.css`, `web/src/shared/english.ts`
- Prior pican research, same topic: `docs/research/t3code-interrupt-steer.md` (2026-07-26, OpenSrc cache) — this doc extends it with the composer+queue **UX** lens; it does not repeat its interrupt-path analysis.

## Bottom line

pican's queue is architecturally ahead of t3code: it is server-side, survives the browser being closed (autonomous drainer in `chat_queue_drainer.go`), syncs across tabs via SSE `queue` events, and already has a per-item, keyboard-first docked list — t3code mobile only shows a count and t3code web has no queue at all (its web composer disables send while running). What pican is missing is **presence and lifecycle affordances**:

1. The queue affordance disappears when the worker is idle and shows no count badge (`ChatToolbar.svelte` hides `#pi-chat-queue` unless `toolbar.isRunning`).
2. "Send now" and "Edit" are keyboard-only (Enter / E in `QueuePanel.svelte`) — no mouse affordances.
3. Every queued row is tagged "queued next" (`QueuePanel.svelte` `itemState()`), not just the head row.
4. Edit *claims and deletes* the row server-side before copying text to the textarea (`steer-queue.ts` `edit()` → `queueApi.remove`) — an abandoned edit loses the message permanently.
5. No per-item lifecycle state (`queued → dispatching → picked up`); rows just vanish when the drainer pops them.
6. No keyboard shortcut to enqueue the current draft; no enqueue feedback pulse.
7. The queue never appears in the transcript; the panel is the only surface.

t3code's closest analogs — the web **prompt stash** (⌘S save, count badge, restore menu) and the mobile **outbox** (durable queue, per-item states, edit-in-place with drain hold, optimistic enqueue with rollback) — are the patterns to mine. Details below.

---

## (a) t3code patterns worth adopting

### A1. Count badge + quiet save acknowledgment (prompt stash)
`apps/web/src/components/chat/ComposerStashBadge.tsx` — a small pill on the composer's top-right shoulder showing the stash count; on save it *pulses* (count remounts via `pulseKey`, badge lifts to full opacity, ~1200ms) instead of firing a toast. This is the right feedback model for "your item was accepted": visible, non-interrupting, countable.
Adopt for pican: count badge on the Queue button and/or the panel header that ticks over + pulses when a message is enqueued.

### A2. One-line "N queued will send automatically" presence line
`apps/mobile/src/features/threads/ThreadComposer.tsx` (~L898): when `queueCount > 0`, renders a quiet caption under the composer — `{count} queued message(s) will send automatically.` — and the send action's label flips to "Queue" while the thread is busy/disconnected (`sendLabel = connectionState !== "connected" || queueCount > 0 ? "Queue" : "Send"`). No panel, no list: presence + expectation setting. This is the minimal viable queue UI and exactly what pican's collapsed state should look like.

### A3. Edit a queued item in place, hold the drainer while editing
`apps/mobile/src/state/use-thread-outbox.ts` — `editingQueuedMessageIdsAtom` holds message IDs open in an editor; `use-thread-outbox-drain.ts` re-checks that atom *after* its confirm await and skips any message being edited ("defer to the next drain pass rather than sending a payload being edited"). Saving rewrites the queued payload via `updateThreadOutboxMessage` (thread-outbox.ts) instead of delete-then-resend.
This is the fix for pican's edit-loss hole: the row stays queued while the user edits; the drainer doesn't race it.

### A4. Per-item lifecycle states
`apps/mobile/src/state/thread-outbox-model.ts` models each item as `Queued / Pushing / Picked up / Failed` with `createdAt`. The prior pican research (`t3code-interrupt-steer.md`) already recommended `queued → dispatching → accepted/picked-up | failed`; pican currently has only `queued` (row exists) and "gone" (drainer `PopHead` + SSE refresh). Adopting a `dispatching` state closes the "did it actually send?" gap.

### A5. Optimistic enqueue with rollback-merge
`apps/mobile/src/state/use-thread-composer-state.ts` (~L146): enqueue publishes to the atom synchronously and clears the draft on the tap frame; if the durable write fails, the item is rolled out and the content is merged back into the draft. pican already does the clear-on-queue part (`steer-queue.ts` `enqueueFromComposer`) and restores on failed *send* (`chat-submit.ts`), but a failed *queue POST* currently just drops the text with no restore — the user's draft silently vanishes.

### A6. Keyboard-first list menu
`apps/web/src/components/chat/ComposerStashMenu.tsx` — opened by ⌘S (on empty composer too), arrows navigate, Enter restores, ⌘Backspace deletes, Esc dismisses; capture-phase window listener wins over the editor. pican's `QueuePanel.svelte` already does this well (↑↓ E ⌫ ↩ Esc, document-level capture) — this is the pattern to keep and extend (e.g. Alt+↑/↓ to reorder, matching t3code's menu idiom).

### A7. Primary-action clarity while running
`apps/web/src/components/chat/ComposerPrimaryActions.tsx` — the primary action becomes a red square Stop while running; ordinary submit is disabled on desktop (`showSendWhileRunning` is mobile-only). pican deliberately differs (Steer + Queue while running is the product), so the useful fragment is narrower: the primary action area should *read as one unit* — currently the Steer/Queue pair in `pi-chat-route-actions` gives the Queue button no count and no state, so it looks like a disabled decoration until hover.

### A8. Banner stack for transient state above the composer
`apps/web/src/components/chat/ComposerBannerStack.tsx` — stacked dismissible alerts above the composer with a collapsed cap (top border of the hidden banner peeks), hover/focus expands the stack. Useful for pican's "paused — N held", "resume kicks the drainer", or "first queued item now sending" moments without a modal.

### A9. Draft persistence with debounce + beforeunload flush
`apps/web/src/composerDraftStore.ts` — per-thread drafts, 300ms-debounced localStorage writes, `beforeunload` flush. pican already captures composer text per session (`SessionShell.svelte` → `initialComposerText`/`onComposerTextCapture` via `composer-storage.ts`), but only snapshots on capture — see B9 for the small gap.

### A10. Mobile pill↔card morph + attachment strip
`apps/mobile/src/features/threads/ThreadComposer.tsx` — collapsed pill (thumbnail attachments + send), expands to a card with attachment strip and toolbar on focus; layout morphs with one shared transition timing. pican has the same collapsed/expanded idea (`composer-collapsed` in `session.css` + `composer-expand.ts`) — the transferable piece is the **attachment strip with per-item remove + zoom**, which pican's `pi-chat-attachments` strip partially has. Not a queue concern; noted for completeness.

---

## (b) Concrete pican improvements

### Target design for how the queue should LOOK and BEHAVE

Recommendation: **keep the docked, keyboard-first list as the source of truth; add always-on presence, mouse affordances, lifecycle state, and safer edit — do not move the queue into the transcript as permanent chips.**

- **Presence**: a count badge on the Queue button (`ChatToolbar.svelte`) whenever `queueStore.count > 0`, plus a collapsed one-line strip ("N queued · auto-send" / "N queued · paused") above the composer when the list is hidden. Mirrors A1 + A2.
- **List**: keep `QueuePanel.svelte`. Header: status (Queue / Queue paused) + count + pause/resume. Rows: `[icon] [snippet] [tag · time] [send-now] [edit] [remove]`. Head row tagged "next up", other rows "queued #n"; steer rows keep "steering" (accent icon). Per-item cancel stays instant (matches t3code delete semantics). Reorder via Alt+↑/↓ (and later a drag handle).
- **Lifecycle**: head row flips to a "dispatching…" spinner when the drainer claims it, cleared when the matching user entry lands (reuse the `reconcileSteersAgainstEntries` text-match machinery in `steer-queue.ts`). No permanent transcript chips; an optional transient "sending…" chip only.
- **Edit**: no delete. Copy to textarea, PATCH the queued row's text server-side, mark it editing locally; a send or Enter commits it (as steer or send by running state); Esc/abandon leaves the updated row queued. The drainer holds nothing because the content is already updated server-side.

### B1. Count badge + paused state on the Queue button; show it while idle too  — *quick win*
- **File**: `web/src/components/session/chat/ChatToolbar.svelte` (+ `ChatComposer.svelte` to pass `queueStore` into `ChatToolbar`).
- **Change**: `#pi-chat-queue` currently renders only when `toolbar.isRunning` and has no count. Render it when `toolbar.isRunning || store.count > 0`; add a count badge (t3code `ComposerStashBadge` style, `tabular-nums`) and a paused glyph/class when `store.paused`. This makes a paused or non-empty queue reachable when the worker is idle — today the only way to pause/resume an idle queue is to have the panel open from before.
- **Strings** (`web/src/shared/english.ts`): add `composer.queueBadgeCount` / `composer.queuePausedBadge` aria labels.

### B2. Per-row "Send now" button + fix head-row labeling  — *quick win*
- **File**: `web/src/components/session/chat/QueuePanel.svelte`.
- **Change**: `itemState()` returns `composer.queuedNext` for *every* queued row today. Return "next up" only for the head (lowest `position`), "queued #n" otherwise (add strings). Add a visible play (Send now) button per queued row calling `store.actions.sendNow(id)` — currently Enter-only, so mouse users cannot send-now. Play icon already imported (`Play`) for the resume toggle.
- **Tests**: extend `QueuePanel.test.ts` (head vs non-head labels) and `steer-queue.test.ts` (mouse path uses the same `sendNow`).

### B3. Enqueue shortcut (Alt+Enter) + enqueue feedback pulse  — *quick win*
- **Files**: `web/src/components/session/chat/textarea-controls.ts` (in `onKeydown`: `event.altKey && key === 'Enter'` → queue instead of submit), `web/src/components/session/chat/chat-composer-runtime.ts` (thread a `queueAction` into `setupTextareaControls` or dispatch a `pi-chat-queue` custom event), `steer-queue.ts` (expose `enqueueFromComposer` for the shortcut; add a pulse — e.g. a `queuePulse` counter on `QueueStore` that `ChatToolbar`/`QueuePanel` render as a brief highlight), `ShortcutsModal.svelte` + `english.ts` (document it next to `composer.focusShortcut`).
- **t3code analog**: ⌘S stash in `ChatComposer.tsx` (~L2294: capture-phase keydown, always claims the shortcut so the browser save dialog never opens). Alt+Enter avoids Cmd/Ctrl+Enter collisions (browser full-screen, terminal newline). Only fire when the textarea has content; disabled on mobile text input mode like Enter-send.

### B4. Edit in place — PATCH instead of claim-DELETE  — *medium*
- **Files**: `web/src/components/session/chat/queue-api.ts` (add `update(position, { message, displayText })`; the server already has PATCH on `/api/chat/queue` for paused), `web/src/components/session/chat/steer-queue.ts` (`edit()`: PATCH the row's new text, `takeLocalById` locally, drop into textarea; on send/Enter, dispatch normally; if the user abandons, the updated row re-appears on the next SSE refresh), `web/src/components/session/chat/queue-store.svelte.ts` (optional `editingId` for styling), tests in `steer-queue.test.ts` (replace the "edit DELETEs the row" case at ~L233).
- **Why**: today `edit()` calls `queueApi.remove(position)` first — if the user edits and then navigates away or reloads, the message is gone from both the queue and the composer. t3code's outbox edits in place and holds the drainer (`use-thread-outbox.ts` `editingQueuedMessageIdsAtom`; `use-thread-outbox-drain.ts` skips editing messages). PATCH-first gives the same safety with one endpoint, and the drainer never races because the stored content is already the edited content.
- **Server**: `internal/server` chat-queue handler needs an `update` route (message/displayText) — no drainer change required.

### B5. Per-item dispatching state  — *medium (server + client)*
- **Files**: `internal/server/chat_queue_drainer.go` — after `PopHead`, don't treat the row as gone before `chatSender.Send` is accepted; broadcast a queue event carrying a `dispatching` marker (or have the handler return head status), `web/src/components/session/chat/queue-api.ts` (`QueueItemSchema` gains `status`), `queue-store.svelte.ts` (`QueueDisplayItem.status`), `QueuePanel.svelte` (spinner row for the head while dispatching).
- **Why**: this is the state the prior research doc (`t3code-interrupt-steer.md`, "Implication for pican") already called for, and t3code's outbox proves the state model (`Queued/Pushing/Picked up/Failed` in `thread-outbox-model.ts`). It closes the "I queued it, then it silently vanished" gap.
- **Cheap alternative**: client-only — when an SSE `queue` event removes the head row while the worker is running, show a transient "Sending next message…" row that clears via the existing `reconcileSteersAgainstEntries` text-match on the next `pi-session-reload`.

### B6. Reorder queued items (Alt+↑/↓)  — *medium (server + client)*
- **Files**: `queue-api.ts` (`move(position, delta)` or swap), the server `/api/chat/queue` handler (swap two positions — positions are numeric and per-session, so a swap is atomic under the drainer's single goroutine), `queue-store.svelte.ts` (`moveById`), `QueuePanel.svelte` (Alt+↑/↓ on the focused row, matching the existing document-level keydown routing; guard: do not allow moving the head row while the drainer is running, since it may pop it mid-swap — reuse the `toolbar.isRunning`/worker-status signal).
- **Why**: the panel already signals ordering (positions, head row) so users will expect to reorder; without it, the only "reorder" is delete-and-re-enqueue.

### B7. Collapsible queue panel with a persistent count strip  — *medium*
- **File**: `QueuePanel.svelte` + `session.css` (`.pi-queue-panel`).
- **Change**: when collapsed, render only the header (status + count + pause/resume) — t3code's mobile "N queued will send automatically" line (A2) as a one-liner; click to expand the list. Reduces the layout jump when the first item lands (`ChatComposer.svelte` mounts the panel above the shell, so it pushes the composer down) and keeps the composer compact.
- **Also**: give the panel a fade/slide enter (t3code `ComposerConnectionStatusPill` uses `FadeInDown/FadeOutDown` for the same above-composer slot).

### B8. (Optional, larger) Transient "sending…" chip in the transcript
- **Files**: `web/src/components/session/SessionContent.svelte` + `SessionEntry.svelte` (live render only — per the project contract, static export/share output must stay clean), driven by the B5 dispatching state.
- **Recommendation**: do B5 first; only add this if the panel is frequently collapsed. t3code shows *nothing* in the timeline for queued items (only the count), so this is a pican differentiator, not a borrowed pattern — keep it transient (ghost/dashed row that becomes the real user entry when the message lands), never a permanent chip.

### B9. (Small) Draft restore on failed queue POST
- **File**: `web/src/components/session/chat/steer-queue.ts` — `enqueueFromComposer` clears the textarea immediately, but `store.enqueueQueued()` failure (`queueApi.add` rejects) currently swallows the text. Mirror `chat-submit.ts`'s restore-on-failure (and t3code's rollback-merge, A5): keep the typed text around until `add` resolves; restore on failure with a status message.
- **Tests**: `steer-queue.test.ts` — add a case for a failed POST restoring the draft.

### B10. (Small) Queue presence for paused-with-items state
- **File**: `web/src/components/session/chat/QueuePanel.svelte` header — when `store.paused && count > 0`, the header already says "Queue paused"; add the A8-style one-line banner variant ("Paused — N messages held; resume to auto-send") so the state reads at a glance without opening anything, and make the Resume button the header's primary action (already styled `pi-queue-toggle--resume`).

---

## (c) Quick wins vs larger efforts

### Quick wins (hours, frontend-only)
1. **B1** — Queue button count badge + paused glyph + show while idle (`ChatToolbar.svelte`).
2. **B2** — Head-row "next up" label fix + per-row Send-now button (`QueuePanel.svelte`).
3. **B3** — Alt+Enter to enqueue + pulse feedback (`textarea-controls.ts`, `steer-queue.ts`, `QueueStore`).
4. **B10** — Paused-with-items banner line (`QueuePanel.svelte`).
5. **B9** — Draft restore when the queue POST fails (`steer-queue.ts`).

### Medium efforts (day-scale)
6. **B4** — Edit in place via PATCH, no claim-DELETE (`queue-api.ts` + server route + `steer-queue.ts`).
7. **B5** — Dispatching lifecycle state (drainer + `queue-api.ts` + store + panel).
8. **B7** — Collapsible panel + persistent count strip (`QueuePanel.svelte` + CSS).

### Larger efforts
9. **B6** — Server-side reorder (swap endpoint + Alt+↑/↓ + drag handle).
10. **B8** — Transcript "sending…" ghost chip (live render only, contract-safe).

Suggested order: B1→B2→B3 first (all pure frontend, high visibility), then B4 (safety) before B5/B6 (which touch the drainer/API).

---

## (d) What NOT to copy

1. **t3code web's disable-send-while-running** (`ComposerPrimaryActions.tsx`). pican's steer/queue-while-running is the product; replacing it with t3code's Stop-only model would remove the queue's raison d'être. Copy only the visual *consistency* of the primary action, not the behavior.
2. **The mobile outbox's full offline durability machinery** (JSON-file storage, retry timers, backoff caps in `thread-outbox-manager.ts`/`use-thread-outbox-drain.ts`). pican's server-side queue already outlives the browser and drains autonomously; bolting on client durability would duplicate the server and create two sources of truth.
3. **The prompt stash's localStorage quota gymnastics** (`promptStashStore.ts`: 20-entry cap, eviction toasts, image recompression, `pendingImageCount` orphan healing). pican's queue items are *committed-to-run messages*, not drafts — capping or evicting them would silently drop user intent. The stash's *presentation* (badge/pulse/menu) is the transferable part; its storage policy is not.
4. **The Lexical editor and collapsed inline mention tokens** (`composer-editor-mentions.ts`, `composerDraftStore.ts`'s terminal-context placeholders). pican's plain textarea with `@mention`/`/command` autocomplete (`mention-autocomplete.ts`, `slash-command.ts`) is simpler and already tested; the token-collapse machinery is a large maintenance surface for a marginal gain.
5. **t3code's "queue is only a count" UI** (`ThreadComposer.tsx` count line). It's the *floor*, not the target — pican's docked per-item panel already exceeds it. Don't regress toward count-only.
6. **The t3code web footer chrome** (provider pickers, traits menus, runtime-mode controls, interaction-mode toggles, `ComposerFooterModeControls`). pican's minimal toolbar (`ChatToolbar.svelte`: attach / status / thinking / model / context / stop / steer+queue) is the right density for a remote-control app; copying the sprawl would bury the queue.
7. **Draft-stash semantics for the queue button** (stash = save-anytime, restore-on-demand). pican's Queue is a *send-later* primitive with server ordering; labeling or positioning it like a bookmark stash would mislead. Keep "Queue next" language (strings `composer.queueNext`) and the `CornerDownRight`/`Layers` icon vocabulary.
