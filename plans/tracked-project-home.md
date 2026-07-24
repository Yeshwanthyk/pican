---
shaping: true
---

# pican: tracked-project home

Planning snapshot: `multi-runtime-opencode-claude` at `609d21cbfb44`.

This is intentionally one document with two vertical slices. Do not create a
new catalog service, event log, repository identity model, or per-runtime
archive abstraction.

Research input: [T3 Code session-organization research](./t3code-session-organization-research.md).

## Source

> i dont want to show 1000s of session and finding it per project is very hard.
> we should start with adding ones we want and tracking them and like t3code i
> want it to be pinned and archived

> ok plan this without overengineering and tell me

## Problem

The live catalog has 2,205 main-list sessions and 238 discovered project paths.
The home page loads a global page of 100 and then groups that page in the
browser. The Projects view is therefore neither a complete project index nor a
bounded workspace switcher.

`project_prefs` already distinguishes explicitly registered paths from
automatically discovered paths, but the normal UI treats its auto-seeded
`enabled` rows as the primary curation mechanism. The current 166 enabled rows
are bootstrap history, not 166 deliberate choices.

Pican already has ordered, server-backed session pins. It does not have a
runtime-neutral archive state: native Codex archive cannot provide the product
contract because Pi, Claude, and OpenCode do not expose the same capability.

## Outcome

The default `/` view is a bounded tracked-project home:

```text
Now                         running or waiting, from any project
Pinned                      existing ordered global pins
Tracked project A           up to 6 recent unarchived sessions
Tracked project B           up to 6 recent unarchived sessions
```

The user explicitly adds projects. Untracked native sessions remain available
through typed global search and All Sessions. Archive is pican-owned navigation
state and never mutates authoritative runtime data.

## Requirements

| ID | Requirement | Status |
|---|---|---|
| R0 | The default home must not render or paginate through thousands of native sessions. | Core goal |
| R1 | Projects on home must be explicitly tracked by their persisted absolute directory, not inferred from auto-seeded visibility preferences. | Must-have |
| R2 | Running, waiting-for-input, and pinned sessions must remain reachable even when their project is untracked. | Must-have |
| R3 | Each tracked project must show a bounded preview and open a complete, paginated project view. | Must-have |
| R4 | All unarchived native sessions must remain reachable through All Sessions and typed global search. | Must-have |
| R5 | Pin and archive must work consistently for Pi, Codex, Claude, and OpenCode without changing native runtime authority. | Must-have |
| R6 | Removing a tracked project or archiving a session must not delete native state or rebuildable projections. | Must-have |
| R7 | The UI must stay compact and usable on mobile without adding another persistent navigation shell. | Must-have |
| R8 | Existing pins survive rollout; the 166 auto-enabled discovered projects are not migrated as tracked intent. | Must-have |

## Selected shape A: focused home over the existing catalog

| Part | Mechanism |
|---|---|
| A1 | Reuse `project_prefs.source = 'registered' AND enabled = 1` as the tracked-project registry. Add `track`/`untrack` intent names while retaining old request aliases during migration. |
| A2 | Add `view=home`, `view=all`, and `view=archived` read scopes to `/api/sessions`; keep the current unscoped API behavior for compatibility. |
| A3 | Build `view=home` on the server from Now, pins, and at most six recent sessions per tracked project so every tracked project is represented before transport. |
| A4 | Use `/?project=<persisted-project-path>` for a complete project view and the existing server-side `project` filter plus pagination. |
| A5 | Add one SQLite `session_archives` table and `/api/archives` mutation endpoint. Archive state is local presentation metadata, like pins. |
| A6 | Replace the Timeline/Projects toggle with Projects, All Sessions, and Archived scopes. Rework the existing projects modal into a direct Add/Remove tracked-project surface. |
| A7 | Make empty command-palette search focused; once the user types, query `view=all` globally rather than limiting search to the current project. |
| A8 | Auto-track the persisted absolute project path after a successful web-created session so the new session does not disappear from home when it becomes idle. |

## Fit check: R × A

| Req | Requirement | Status | A |
|---|---|---|:---:|
| R0 | The default home must not render or paginate through thousands of native sessions. | Core goal | ✅ |
| R1 | Projects on home must be explicitly tracked by their persisted absolute directory, not inferred from auto-seeded visibility preferences. | Must-have | ✅ |
| R2 | Running, waiting-for-input, and pinned sessions must remain reachable even when their project is untracked. | Must-have | ✅ |
| R3 | Each tracked project must show a bounded preview and open a complete, paginated project view. | Must-have | ✅ |
| R4 | All unarchived native sessions must remain reachable through All Sessions and typed global search. | Must-have | ✅ |
| R5 | Pin and archive must work consistently for Pi, Codex, Claude, and OpenCode without changing native runtime authority. | Must-have | ✅ |
| R6 | Removing a tracked project or archiving a session must not delete native state or rebuildable projections. | Must-have | ✅ |
| R7 | The UI must stay compact and usable on mobile without adding another persistent navigation shell. | Must-have | ✅ |
| R8 | Existing pins survive rollout; the 166 auto-enabled discovered projects are not migrated as tracked intent. | Must-have | ✅ |

No requirement is unresolved. The implementation still needs normal UI density
validation at desktop and mobile widths; that does not change the mechanisms.

## State ownership

| State | Owner | Class | Recovery |
|---|---|---|---|
| Conversation, native session lifecycle, cwd | Pi/Codex/Claude/OpenCode | Authoritative | Re-read native state and rebuild projections |
| Pican JSONL for non-Pi runtimes | Projection store | Rebuildable projection | Runtime catalog reconciliation |
| Tracked project path | Enabled `project_prefs` row with `source='registered'` | Stored pican curation | SQLite backup; never inferred from all discovered paths |
| Session pin and order | `session_pins` | Stored pican curation | Existing behavior |
| Session archive timestamp | `session_archives` | Stored pican curation | SQLite backup; missing row means unarchived |
| Now membership | worker/status state plus unresolved waiting summary | Derived live state | Status snapshot and session reload |
| Project preview and counts | Current unarchived summaries grouped by persisted project path | Derived read model | Recompute on request |
| Current scope/project | URL query | Display/navigation state | Browser history |

Add only this schema:

```sql
CREATE TABLE IF NOT EXISTS session_archives (
  session_id TEXT PRIMARY KEY,
  archived_at TEXT NOT NULL
);
```

Do not add a second project table. Fix `register`/`track` conflict handling so an
already discovered row is promoted to `source='registered'`; today that upsert
leaves its old source unchanged.

## Read contract

`GET /api/sessions` remains compatible for callers that do not send `view`.
New live-app calls use explicit scopes:

- `view=home`: return every Now session first, even if it was previously
  archived; then include unarchived pins plus at most six remaining unarchived
  sessions per tracked project. Sort Now and project previews by current
  activity; retain `pinOrder` for the Pinned group. This view has no Load More.
- `view=all`: all unarchived main-list sessions, including untracked projects,
  with the existing `q`, `limit`, and `offset` behavior.
- `view=archived`: archived main-list sessions with the same paging and search
  behavior.
- `project=<path>`: all unarchived main-list sessions for the exact persisted
  project, paginated. `project` takes precedence over the legacy project filter.

Before counting or grouping, every scope must apply the same btw/subagent
exclusions. `/api/projects` must use that same main-list set so project counts
match the sessions the user can open from home.

`GET /api/projects` continues returning discovered and registered paths, and
adds an explicit `tracked` boolean. The live app ignores the legacy
`filterEnabled`/`enabled` curation model. Keep those fields and old actions
temporarily so existing callers do not break.

## Commands and transitions

| Command | Preconditions | Write | Publication/result |
|---|---|---|---|
| Track project | Path passes the existing absolute-directory preparation contract | Upsert `project_prefs` with `enabled=1`, `source='registered'` | Project appears on focused home |
| Untrack project | Existing registered path | Delete the registered preference; discovery may later recreate it as untracked | Sessions remain in All/search |
| Pin session | Session exists | In one SQLite transaction delete its archive row, then insert its pin row | Session appears in Pinned |
| Unpin session | Pin exists or no-op | Delete pin row | Session falls back to tracked project or All |
| Archive session | Session exists, is not running, and is not waiting for input | In one transaction insert archive row and delete pin row | Session leaves normal scopes and appears in Archived |
| Unarchive session | Archive exists or no-op | Delete archive row | Session returns to its tracked project or All |
| Create web session | Runtime creation succeeds and projection/session resolves | Track the persisted `resolved.Session.Project`, not the raw request string | New project and session remain on home |

Use one small global `curation-updated` SSE event after successful project,
pin, or archive mutation. The home route refetches its current scope. This
keeps desktop and mobile views consistent without a client-side curation store.

## Invariants

1. Native state and session projections are never edited by track, untrack,
   pin, archive, or unarchive.
2. A session cannot be both pinned and archived. Pinning unarchives; archiving
   unpins.
3. A running or waiting session cannot be archived. Enforce this in the server,
   not only by disabling a button. If a previously archived session becomes
   active through its direct URL, Now temporarily surfaces it.
4. Now bypasses both tracked-project and archive membership. Pinned bypasses
   tracked-project membership.
5. Untracked and archived sessions remain directly viewable by URL. Archive is
   navigation state, not an authorization boundary.
6. Failed or partial runtime catalog scans do not alter tracked projects, pins,
   or archive rows.
7. Static export ignores all live curation state and remains unchanged.

## UI contract

### Projects home: `/`

- Replace the current Timeline/Projects toggle with scope links: Projects, All,
  Archived.
- Keep the current compact Now and Pinned ticker rows.
- Render tracked projects as compact groups sorted by latest preview activity.
  Each group shows at most six rows and a `View all N` affordance.
- Put `Add project` beside the scope control on desktop and in the existing
  mobile overflow menu. The empty state also contains the same action.
- A fresh focused home with no tracked projects says: `No tracked projects`
  and `Add a project, or open All Sessions.` It still renders Now and Pinned.
- The header reports focused information such as `3 projects · 14 shown`;
  `2,205 sessions` belongs only in All Sessions.

### Project detail: `/?project=<path>`

- Show a back action, the shortened project name, persisted path, total count,
  New session, and the existing paginated ticker list.
- Do not add a second project page component. `SessionsPage` accepts the URL
  scope/project and remounts when it changes.

### All Sessions and Archived

- All Sessions is the existing paginated timeline with archived rows excluded.
- Archived is the same compact timeline with Restore instead of Archive.
- Do not preserve the current client-side Projects grouping inside All
  Sessions; it is misleading when only a global page has loaded.

### Session actions

- Add Archive to `SessionCard` and Archive/Restore to the live session
  `CommandMenu`. `/api/session` includes the pican-local `archived` boolean so
  the direct session route can render the correct action without consulting a
  runtime capability.
- Disable Archive while the session is running or waiting, with a precise
  reason. The server still rejects stale/racing requests with `409`.
- After archiving the currently open session, navigate to `/`.
- This is always the pican-local archive action. Do not condition its presence
  on runtime `capabilities.archive`, and do not call the Codex native archive
  endpoint.

### Search

- Opening the palette with an empty query shows pinned and recent focused-home
  sessions.
- Typing switches the server query to `view=all&q=<query>`, across every
  unarchived project.
- Do not implicitly constrain typed search to the current session cwd.
- Archived search stays inside the Archived view rather than mixing archived
  rows into normal results.

## Slice 1: tracked projects and bounded home

Visible result: `/` contains only Now, Pinned, and six-session previews for
explicitly tracked projects. Project detail and All Sessions remain complete.

Backend:

- Update `internal/server/projects.go` with tracked-set helpers, `track` and
  `untrack`, source promotion, aligned counts, and compatibility aliases.
- Refactor `internal/server/handlers.go` session-list filtering into explicit
  view selection before pagination. Mark pins before home inclusion.
- Snapshot the server's current running-ID set for Now inclusion; use parsed
  waiting state for waiting inclusion.
- After successful `/api/new-session`, resolve the created session and track its
  persisted project.
- Update `internal/server/projects_test.go`, `pins_test.go`, and
  `pagination_test.go` with the boundary cases in the acceptance contract.

Frontend:

- Extend `web/src/lib/schema.ts` and `web/src/index/sessions.ts` with tracked
  project and session-view query fields.
- Update `App.svelte` to derive the home scope/project from `location.search`
  and key `SessionsPage` on that navigation state.
- Reshape `SessionsPage.svelte`, `IndexHeader.svelte`, `HomeMenu.svelte`,
  `ProjectsModal.svelte`, and `SessionsList.svelte` around the three scopes and
  bounded project groups.
- Keep `SessionCard.svelte` pin behavior and the visual
  `PinnedSessionSwitcher.svelte` contract intact; make its summary lookup use
  `view=all` so the retired legacy project filter cannot hide a pin.
- Change command-palette query construction so typed searches are global.
- Add all user-facing copy through `web/src/shared/english.ts`.

Slice 1 acceptance:

1. With zero tracked projects, home shows only Now/Pinned and the Add Project
   empty state; All Sessions still reports the full unarchived catalog.
2. Tracking existing discovered project `/pican` promotes it to registered and
   shows at most six of its sessions on home.
3. Tracking a second quiet project shows both project groups even if the first
   project has more than 100 newer sessions.
4. Clicking `View all N` shows the correct full project count and paginates.
5. An untracked running, waiting, or pinned session remains on home.
6. A session created from the web tracks its resolved persisted project path.
7. Typed command-palette search finds an untracked session.

Commit this slice as one logical block.

## Slice 2: local archive

Visible result: any idle session can be archived and restored consistently
across every runtime, with a separate Archived scope.

Backend:

- Add `internal/server/archives.go` with schema, set/read helpers, orphan
  cleanup, `/api/archives`, and pin/archive transactions.
- Register the table and route in `internal/server/server.go`.
- Add `Archived` to `sessions.SessionSummary`, mark it from SQLite in both list
  and live `/api/session` responses, and apply archive scope before pagination.
- Publish `curation-updated` after track, pin, archive, and restore.
- Add `internal/server/archives_test.go` for round trips, pin/archive
  exclusivity, live/waiting rejection, missing sessions, paging, and orphan
  cleanup.

Frontend:

- Add archive schema/API adapters beside the existing pin adapters.
- Add Archive/Restore affordances to `SessionCard.svelte`.
- Add the local Archive/Restore action to `CommandMenu.svelte` and navigate
  home after a successful archive.
- Wire Archived scope, empty state, errors, optimistic updates, SSE refetch,
  and mobile/desktop styling.
- Keep the static export dependency graph unchanged.

Slice 2 acceptance:

1. Archive removes an idle session from Projects, project detail, All Sessions,
   Pinned, and normal palette results without changing its native files.
2. Archived shows the same session and Restore returns it to the correct scope.
3. Archiving a pinned session removes its pin atomically; pinning an archived
   session restores it atomically.
4. Running and waiting sessions return `409` and remain visible.
5. Direct `/session?id=…` viewing and static export still work while archived.
6. Pi, Codex, Claude, and OpenCode follow the same local archive contract.
7. A mutation on one connected browser refreshes the other through
   `curation-updated`.

Commit this slice as one logical block.

## Explicitly out

- Automatic settle/history thresholds.
- Project pinning, manual project order, or drag-and-drop.
- Repository identity, worktree collapsing, monorepo grouping, or remote
  environment identity.
- Importing or rewriting native archive state.
- Deleting sessions or projections as part of archive/untrack.
- A migration wizard or automatic conversion of enabled discovered projects.
- A new frontend global store, event-sourced curation system, or background
  indexing service.

All Sessions is the history escape hatch in this version. Add automatic
settling only after the tracked-project home proves that another lifecycle
layer is still necessary.

## Verification

During each slice, run focused Go and Vitest files for the touched boundaries.
At the end:

```bash
make build
make check
```

If Vitest hits host `ENOSPC`, retry once with `VITEST_MAX_WORKERS=4`.

Manual acceptance at desktop width and a 390px mobile viewport:

1. Start with no tracked projects.
2. Add two projects with very different session counts.
3. Verify bounded previews, project detail, All Sessions, and typed global
   search.
4. Pin an untracked session, then archive and restore an idle session.
5. Attempt to archive running and waiting sessions.
6. Open the same server in a second browser and verify curation refresh.

Update `docs/architecture/system-overview.md`,
`docs/architecture/backend.md`, and `docs/architecture/frontend.md` in the same
slices. Update the English README/user docs only if the existing project
management surface is currently documented there.
