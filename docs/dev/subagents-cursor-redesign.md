# Subagents page — Cursor-style redesign + return-to-parent loop

## Why

The pican subagents dashboard is the only extension dashboard with zero
interactivity: hairline rows, no hover, no detail affordance, no activity
signal beyond two timestamps. Cursor's subagents panel (reference screenshots +
the pi-subagents TUI viewer landed in `pi-subagents` commits `2bd7df4` /
`4f41b8b`) shows per-agent cards with a live status marker, status chip, meta
line, and a click-through to the agent's conversation.

This redesign moves the pican `/subagents` page from rows to Cursor-style
cards and completes the Cursor loop: parent → see all subagents → select one →
steer/cancel from its transcript → return to the parent.

## The loop (Cursor-style)

1. **Parent session** — the parent chat shows subagent activity inline
   (`SubagentToolCard`) and there is a `/subagents` dashboard route.
2. **See all subagents** — `/subagents` lists every tracked agent as a card:
   status chip + live marker, title, id, harness, project, activity times,
   ordered running → failed → done → unknown by recency.
3. **Select** — the whole card links to the child transcript
   (`/session?id=<child>&parent=<parent>`); the `parent` param rides along.
4. **Steer / cancel** — the child session page is a full session view: the
   composer steers the subagent, the stop control aborts the run.
5. **Return** — when a `parent` param is present, the session header shows an
   `↑ Parent` chip that navigates back to the parent session, so the user
   resumes watching the overall session.

The page itself stays read-only (no abort/steer API in the web backend), so the
loop is: overview is read-only; steering happens in the child session view.

## Reference

- Cursor subagents panel: agent cards with title + current action + model,
  running agents animated, settled agents dim.
- pi-subagents TUI: `activity-rail` cards + two-pane dashboard.
- pican tokens: `--body-bg #111116`, `--surface #15151b`, `--surface-2 #191920`,
  `--text #e6e7eb`, `--muted #858a96`, `--dim #292a33`, `--accent #9cc7c0`,
  `--success #b5bd68`, `--danger #ef767a`; mono fonts.

## Slices

1. **Summary ribbon** — counts `N running · M done · N failed` under the
   header (mirrors the TUI footer counter). New strings in `english.ts`.
2. **Cards** — rounded cards (session-card recipe: surface mix bg, dim border,
   hover lift + focus ring). Running cards get an accent-tinted border +
   pulsing dot, done → `✓` success, error → `✕` danger.
3. **Card anatomy** — status chip + title + mono id + harness badge; second
   line: shortened project path; right column: `Active {t}` / `Spawned {t}`;
   whole card links to the child transcript with the parent param.
4. **Ordering** — running → error → done → unknown, most recent activity
   first within group.
5. **Return-to-parent** — `subagentTranscriptHref()` builds the child href with
   `&parent=`; `parentSessionParam()` reads it back on the session route;
   `SessionHeader` renders an `↑ Parent` chip (accent pill) when present.
6. **Responsive + reduced motion** — ≤700px single-column; pulse/spinner
   disabled under `prefers-reduced-motion`.

## Files

- `web/src/subagents/subagents.ts` — href builder + parent param reader
  (+ tests)
- `web/src/routes/SubagentsPage.svelte` — cards, ribbon, ordering, whole-card
  links
- `internal/ui/embedded/styles/subagents.css` — card + ribbon styles
- `web/src/routes/SessionPage.svelte`, `components/session/SessionShell.svelte`,
  `components/session/SessionHeader.svelte` — parent param threading + chip
  (+ SessionHeader test)
- `internal/ui/embedded/styles/session.css` — `.session-header-parent` chip
- `web/src/shared/english.ts` — 4 summary strings

## Verification

- `make test` (vitest + `go test ./...`) — subagents/SessionHeader/App route
  tests green.
- Static mockup: `subagents-ui-mockup.html` (repo root) shows the target design
  including the return-to-parent chip with sample data.