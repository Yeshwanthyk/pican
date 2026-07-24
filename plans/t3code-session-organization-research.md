# T3 Code session-organization research

Research date: 2026-07-24

## Source snapshot and scope

The requested local checkout, `/Users/yesh/code/personal/t3code`, does not exist, so there is no local branch, worktree state, SHA, or remote configuration to report. This report instead uses the official `pingdotgg/t3code` repository at upstream `main` commit [`38cfc25e5422e468303f2010f639cf3de9ad89ba`](https://github.com/pingdotgg/t3code/tree/38cfc25e5422e468303f2010f639cf3de9ad89ba), verified with `git ls-remote` and a clean shallow checkout. Every T3 link below is pinned to that commit.

T3 calls its app-level conversation a **thread** and reserves **session** for the live provider runtime attached to a thread. Its own glossary makes that distinction explicit: a project owns a workspace root and threads; a session is the provider-backed runtime for a thread ([glossary](https://github.com/pingdotgg/t3code/blob/38cfc25e5422e468303f2010f639cf3de9ad89ba/docs/reference/encyclopedia.md#L15-L37), [session definition](https://github.com/pingdotgg/t3code/blob/38cfc25e5422e468303f2010f639cf3de9ad89ba/docs/reference/encyclopedia.md#L91-L99)).

## Findings

### Projects are explicitly adopted, not inferred from every native session

**Source fact.** “Add project” is a command-palette flow. The user first chooses an environment, then either browses a local folder or clones from a Git URL/GitHub/GitLab/Bitbucket/Azure DevOps source ([source picker](https://github.com/pingdotgg/t3code/blob/38cfc25e5422e468303f2010f639cf3de9ad89ba/apps/web/src/components/CommandPalette.tsx#L938-L1027)). On submission, T3 normalizes the path, reopens the existing project if the same environment/path is already registered, or creates a new project record and immediately starts its first thread ([create-or-open flow](https://github.com/pingdotgg/t3code/blob/38cfc25e5422e468303f2010f639cf3de9ad89ba/apps/web/src/components/CommandPalette.tsx#L1270-L1383)). The server independently rejects a second active project with the same normalized workspace root ([invariant](https://github.com/pingdotgg/t3code/blob/38cfc25e5422e468303f2010f639cf3de9ad89ba/apps/server/src/orchestration/commandInvariants.ts#L75-L96)).

**Source fact.** There is one automatic entry path: ordinary web-mode startup defaults `autoBootstrapProjectFromCwd` to true, while desktop and headless startup do not ([CLI resolution](https://github.com/pingdotgg/t3code/blob/38cfc25e5422e468303f2010f639cf3de9ad89ba/apps/server/src/cli/config.ts#L285-L305)). That bootstrap adopts exactly the server cwd, reuses an existing project if present, and creates one “New thread” only when the project has no active thread ([bootstrap flow](https://github.com/pingdotgg/t3code/blob/38cfc25e5422e468303f2010f639cf3de9ad89ba/apps/server/src/serverRuntimeStartup.ts#L180-L249)). It still does not infer projects from native provider history.

**Source fact.** The durable project record is small: ID, title, `workspaceRoot`, optional repository identity, default model, scripts, timestamps, and `deletedAt`. A thread belongs to exactly one project and carries its own branch/worktree metadata and lifecycle timestamps ([contracts](https://github.com/pingdotgg/t3code/blob/38cfc25e5422e468303f2010f639cf3de9ad89ba/packages/contracts/src/orchestration.ts#L212-L223), [thread contract](https://github.com/pingdotgg/t3code/blob/38cfc25e5422e468303f2010f639cf3de9ad89ba/packages/contracts/src/orchestration.ts#L345-L378)).

**Source fact.** Across local/remote environments, physical project records can be collapsed into a logical project. The default grouping mode is repository identity, with repository-plus-path and fully separate alternatives ([settings defaults](https://github.com/pingdotgg/t3code/blob/38cfc25e5422e468303f2010f639cf3de9ad89ba/packages/contracts/src/settings.ts#L16-L40)); the sidebar deduplicates physical keys and builds one logical group containing its member project references ([grouping implementation](https://github.com/pingdotgg/t3code/blob/38cfc25e5422e468303f2010f639cf3de9ad89ba/apps/web/src/sidebarProjectGrouping.ts#L76-L159)).

**Inference.** T3’s organizing boundary is deliberate adoption: “this workspace belongs in T3.” It is not a browser over every workspace discoverable from Codex or Claude history.

### Default visibility is bounded in the stable sidebar

**Source fact.** Sidebar v2 is opt-in (`sidebarV2Enabled` defaults to false), so the project-grouped sidebar remains the default at this snapshot ([settings schema](https://github.com/pingdotgg/t3code/blob/38cfc25e5422e468303f2010f639cf3de9ad89ba/packages/contracts/src/settings.ts#L98-L117)). Projects default to expanded unless the user has persisted an override ([UI-state resolution](https://github.com/pingdotgg/t3code/blob/38cfc25e5422e468303f2010f639cf3de9ad89ba/apps/web/src/uiStateStore.ts#L307-L337)).

**Source fact.** Within each expanded project, T3 sorts non-archived threads by the configured order and initially renders at most six, the default `sidebarThreadPreviewCount`; “Show more” reveals the rest. If a project is collapsed, the currently routed thread alone remains visible. This “pinned collapsed thread” is a routing affordance, not a saved pin ([default count](https://github.com/pingdotgg/t3code/blob/38cfc25e5422e468303f2010f639cf3de9ad89ba/packages/contracts/src/settings.ts#L31-L40), [visibility calculation](https://github.com/pingdotgg/t3code/blob/38cfc25e5422e468303f2010f639cf3de9ad89ba/apps/web/src/components/Sidebar.tsx#L1257-L1345)).

**Source fact.** The beta sidebar v2 uses a different inbox model: all active threads are rich cards, snoozed threads sit in a collapsed shelf, and settled threads form a compact tail. Only the first 10 settled threads render initially, then 25 per “Show more”; the currently open deep thread is always pulled into view ([partition and paging](https://github.com/pingdotgg/t3code/blob/38cfc25e5422e468303f2010f639cf3de9ad89ba/apps/web/src/components/SidebarV2.tsx#L1357-L1486), [rendered shelves](https://github.com/pingdotgg/t3code/blob/38cfc25e5422e468303f2010f639cf3de9ad89ba/apps/web/src/components/SidebarV2.tsx#L2452-L2531)). Auto-settle defaults to three inactive days when sidebar v2 is enabled, and closed/merged PR threads also settle ([settings](https://github.com/pingdotgg/t3code/blob/38cfc25e5422e468303f2010f639cf3de9ad89ba/apps/web/src/components/settings/BetaSettingsPanel.tsx#L53-L102)).

### There is no conventional persistent “pin” collection

**Source fact.** Neither the project nor thread schema has a `pinned` field, and there is no pin/unpin command. The closest durable mechanism is `settledOverride`, whose values are `"settled"` and `"active"` ([thread schema](https://github.com/pingdotgg/t3code/blob/38cfc25e5422e468303f2010f639cf3de9ad89ba/packages/contracts/src/orchestration.ts#L345-L370)).

**Source fact.** In sidebar v2, explicitly un-settling an auto-settled thread writes the `"active"` override. The source calls that the “explicit keep-active pin”; it suppresses auto-settle until real activity clears it server-side ([settlement resolver](https://github.com/pingdotgg/t3code/blob/38cfc25e5422e468303f2010f639cf3de9ad89ba/packages/client-runtime/src/state/threadSettled.ts#L231-L295)). The row code likewise describes un-settling an auto-settled row as making it “pinned active” ([row action](https://github.com/pingdotgg/t3code/blob/38cfc25e5422e468303f2010f639cf3de9ad89ba/apps/web/src/components/SidebarV2.tsx#L2370-L2403)).

**Inference.** T3’s “pin” is a keep-in-the-active-inbox override, not pican’s ordered, cross-project Pinned section. It does not provide a compact set of favorite threads above everything else, nor an explicit user-controlled pin order.

### Archive, delete, and remove are separate lifecycle operations

**Source fact.** Archive and delete are distinct commands. An archived thread retains its record and can be unarchived; deletion sets a separate deletion lifecycle ([commands](https://github.com/pingdotgg/t3code/blob/38cfc25e5422e468303f2010f639cf3de9ad89ba/packages/contracts/src/orchestration.ts#L560-L576), [event payloads](https://github.com/pingdotgg/t3code/blob/38cfc25e5422e468303f2010f639cf3de9ad89ba/packages/contracts/src/orchestration.ts#L955-L969)). Archived threads are excluded from the main shell query and loaded through a separate archived-shell query ([active/archive queries](https://github.com/pingdotgg/t3code/blob/38cfc25e5422e468303f2010f639cf3de9ad89ba/apps/server/src/orchestration/Layers/ProjectionSnapshotQuery.ts#L351-L416)). The stable sidebar blocks archiving a currently running turn and routes the user to a fresh draft after archiving the open thread ([archive action](https://github.com/pingdotgg/t3code/blob/38cfc25e5422e468303f2010f639cf3de9ad89ba/apps/web/src/hooks/useThreadActions.ts#L158-L214)).

**Source fact.** Archived threads are managed from a dedicated Settings page, where they can be restored or deleted ([archived-thread panel](https://github.com/pingdotgg/t3code/blob/38cfc25e5422e468303f2010f639cf3de9ad89ba/apps/web/src/components/settings/SettingsPanels.tsx#L1544-L1654)). Delete is presented as permanently clearing conversation history; for a thread with an otherwise orphaned worktree, T3 separately asks whether to delete that worktree too ([delete flow](https://github.com/pingdotgg/t3code/blob/38cfc25e5422e468303f2010f639cf3de9ad89ba/apps/web/src/hooks/useThreadActions.ts#L217-L310)).

**Source fact.** Removing a non-empty project is guarded. The stable sidebar first says to delete its threads, then offers an explicit force path warning that conversation history is permanently cleared. Removing the project entry does not imply deleting the workspace files ([project removal](https://github.com/pingdotgg/t3code/blob/38cfc25e5422e468303f2010f639cf3de9ad89ba/apps/web/src/components/Sidebar.tsx#L1428-L1512)).

### Navigation and search operate over T3’s catalog

**Source fact.** The stable navigation hierarchy is logical project → recent thread preview → expanded thread list. The default project and thread sort are both most-recently-updated, while manual project order is also supported ([defaults](https://github.com/pingdotgg/t3code/blob/38cfc25e5422e468303f2010f639cf3de9ad89ba/packages/contracts/src/settings.ts#L16-L40)). Sidebar v2 instead uses one flat thread list with an “All projects”/single-project scope menu ([scope control](https://github.com/pingdotgg/t3code/blob/38cfc25e5422e468303f2010f639cf3de9ad89ba/apps/web/src/components/SidebarV2.tsx#L2268-L2305)).

**Source fact.** The command palette’s empty state shows 12 recent threads. Once the user types, it searches all loaded non-archived projects and threads. Project terms include title and workspace path; thread terms include title, project title, and branch. Ranking favors exact, then prefix, then substring matches ([recent limit and root groups](https://github.com/pingdotgg/t3code/blob/38cfc25e5422e468303f2010f639cf3de9ad89ba/apps/web/src/components/CommandPalette.logic.ts#L14-L14), [thread terms](https://github.com/pingdotgg/t3code/blob/38cfc25e5422e468303f2010f639cf3de9ad89ba/apps/web/src/components/CommandPalette.logic.ts#L145-L196), [filter/ranking](https://github.com/pingdotgg/t3code/blob/38cfc25e5422e468303f2010f639cf3de9ad89ba/apps/web/src/components/CommandPalette.logic.ts#L199-L296)). Selecting a project opens its latest non-archived thread, or creates a new thread if it has none ([navigation behavior](https://github.com/pingdotgg/t3code/blob/38cfc25e5422e468303f2010f639cf3de9ad89ba/apps/web/src/components/CommandPalette.tsx#L740-L805)).

### Persistence is app-owned and event-sourced

**Source fact.** T3 stores server state in `<baseDir>/userdata/state.sqlite` in production, with settings and UI-adjacent server files alongside it ([derived paths](https://github.com/pingdotgg/t3code/blob/38cfc25e5422e468303f2010f639cf3de9ad89ba/apps/server/src/config.ts#L95-L119)). The SQLite database contains an append-only orchestration event log ([event schema](https://github.com/pingdotgg/t3code/blob/38cfc25e5422e468303f2010f639cf3de9ad89ba/apps/server/src/persistence/Migrations/001_OrchestrationEvents.ts#L7-L43)) plus read-optimized project, thread, message, activity, session, turn, approval, and projector-state tables ([projection schema](https://github.com/pingdotgg/t3code/blob/38cfc25e5422e468303f2010f639cf3de9ad89ba/apps/server/src/persistence/Migrations/005_Projections.ts#L7-L111)).

**Source fact.** Provider continuation state is keyed by T3 thread ID in `provider_session_runtime`, with provider/adapter identity, status, last-seen time, opaque resume cursor, and runtime payload ([runtime schema](https://github.com/pingdotgg/t3code/blob/38cfc25e5422e468303f2010f639cf3de9ad89ba/apps/server/src/persistence/Migrations/004_ProviderSessionRuntime.ts#L7-L28)). Browser IndexedDB caches shell and thread snapshots for warm startup/resume, while project expansion/order and visit state live in local storage; these are caches/preferences, not the authoritative catalog ([IndexedDB stores](https://github.com/pingdotgg/t3code/blob/38cfc25e5422e468303f2010f639cf3de9ad89ba/apps/web/src/connection/storage.ts#L36-L74), [local UI state](https://github.com/pingdotgg/t3code/blob/38cfc25e5422e468303f2010f639cf3de9ad89ba/apps/web/src/uiStateStore.ts#L1-L54)).

### T3 avoids thousands of native sessions by never importing them

**Source fact.** The Codex adapter’s session collection is an in-memory map keyed by T3 `ThreadId`. `startSession` adds a runtime for a T3 thread, and `listSessions` returns only live values from that map; it does not call Codex `thread/list` to discover the user’s global history ([adapter map/start](https://github.com/pingdotgg/t3code/blob/38cfc25e5422e468303f2010f639cf3de9ad89ba/apps/server/src/provider/Layers/CodexAdapter.ts#L1356-L1408), [list implementation](https://github.com/pingdotgg/t3code/blob/38cfc25e5422e468303f2010f639cf3de9ad89ba/apps/server/src/provider/Layers/CodexAdapter.ts#L1656-L1686)). Durable provider bindings are likewise keyed by the app thread ID ([directory contract](https://github.com/pingdotgg/t3code/blob/38cfc25e5422e468303f2010f639cf3de9ad89ba/apps/server/src/provider/Services/ProviderSessionDirectory.ts#L17-L64)).

**Inference.** This is the primary scale control. T3’s UI cardinality is “threads created in explicitly added T3 projects,” not “everything the native CLIs have ever recorded.” The stable sidebar then limits rendering to six threads per project, and v2 pages its settled tail.

**Important limitation.** T3 does not currently prove a fully scalable catalog query once its own thread count becomes very large. The shell query loads every non-deleted, non-archived T3 thread with no SQL limit ([shell query](https://github.com/pingdotgg/t3code/blob/38cfc25e5422e468303f2010f639cf3de9ad89ba/apps/server/src/orchestration/Layers/ProjectionSnapshotQuery.ts#L351-L382)), and command-palette search filters those loaded objects in memory. Its strong defense is the adoption boundary and render caps, not server-side search/pagination over millions of rows.

## Pican's current shape and live scale

Pican currently chooses the opposite catalog boundary. Its project filter is off by default, so every discovered native session shows. On first discovery, it also seeds every existing project as enabled; only later discoveries default to disabled (`internal/server/projects.go:20-24,39-52,89-113`). Codex reconciliation deliberately walks paginated native `thread/list` results (`internal/codex/rpc.go:26-52`). The homepage mitigates volume with 100-session API pages (`web/src/routes/SessionsPage.svelte:48,124-145`), but discovery and the mental model remain native-history-first.

The live server on 2026-07-24 reports 2,205 main-list sessions and 238 discovered project paths. Of those project rows, 166 are enabled, 72 are disabled, and none are explicitly registered. The project filter is off. There are 43 project paths with at least 10 sessions and 88 one-session paths. Those 166 enabled rows are therefore bootstrap history, not evidence that the user deliberately chose 166 projects to track.

The current Projects layout is not a real project catalog. `SessionsPage` requests the latest global 100 sessions, then `SessionsList` groups only that loaded slice in memory (`web/src/components/index/SessionsList.svelte:57-62`; `web/src/index/sessions.ts:324-342`). A project can be absent or undercounted until more global pages are loaded. The server already accepts an exact `project` query before pagination (`internal/server/handlers.go:246-289`), but the home screen does not expose project-first navigation around it.

Pican already has the conventional pin model T3 lacks: `session_pins` is a server-side ordered set independent of append-only transcripts (`internal/server/pins.go:13-66`), and the homepage splits those sessions into an explicit Pinned section. The live database has one pin. However, project filtering currently runs before pins are marked and injected into page one (`internal/server/handlers.go:256-287`), so a pinned session can disappear when its project is disabled. Pins should win over project visibility.

Archive is a separate gap. Only Codex exposes native archive/unarchive capabilities; Pi, Claude, and OpenCode do not (`internal/runtimes/builtins.go:116-169`). A product-level Archived shelf therefore cannot honestly be implemented as a native runtime action. It needs a pican-owned presentation overlay that never deletes or rewrites native session state.

## Recommended product shape

The home screen should become a **tracked-project inbox**, not a browser over all native history.

1. **Now** always shows running, waiting, approval-blocked, and input-blocked work, even if its project is untracked or the session was archived earlier.
2. **Pinned** keeps pican's existing global ordered pins and always surfaces them. Pinning an archived session should unarchive it, or equivalently pins must take precedence over archive.
3. **Projects** contains only explicitly tracked canonical directories. Each project initially shows three to six active/recent sessions plus a count. Selecting one opens a real server-filtered project view rather than grouping the current global page.
4. **History** is a collapsed, paged tail for inactive sessions. T3's “settled” model is useful here because users should not have to archive thousands of old sessions manually.
5. **Archived** is an explicit secondary scope backed by pican-local metadata. Archive removes a session from normal navigation but retains the native session and rebuildable projection. Native Codex archive remains a separate runtime-specific action.

“Add project” should be a first-class action beside New session, not a setting hidden behind Manage Projects. The initial identity can be exact canonical path—the same invariant pican already validates. Repository-level grouping can come later for worktrees and monorepos.

Typed search should continue to reach the full indexed, non-archived native catalog, including untracked projects. The empty command palette should stay focused: pinned sessions, tracked projects, and a short recent list. “All sessions” remains an explicit escape hatch for discovery and recovery, not the default landing page.

This preserves the right authority boundary. Native Pi, Codex, Claude, and OpenCode state stays authoritative; pican owns only curation metadata such as tracked projects, project order, session pins, local archive, and optional keep-active state. Projection rebuilds must never erase that curation.

## Migration and delivery order

Do not turn the existing 166 enabled rows into tracked projects. They were automatically seeded and are not trustworthy intent. Existing users should get a one-time “Choose projects to track” flow, with their existing pins preserved and “All sessions” always available. New installs should start with no tracked projects and make Add project the obvious first action.

The smallest coherent delivery is:

1. Add an explicit tracked-project registry, project order, a bounded project-first home, and a true project detail query. Reuse the existing pin storage and make pins override filtering.
2. Add runtime-neutral local archive/unarchive and a separate Archived view. Do not proxy this to native Codex archive.
3. Add derived History/settled behavior with a conservative inactivity threshold. Never auto-hide live, blocked, or pinned work.

This is deliberately not “flip the current filter on.” That would expose 166 accidental selections and retain the broken global-page grouping. The first slice needs the registry and navigation shape together.

## Decisions still worth validating in implementation

- Whether the project preview cap is three, four, or six sessions should be tested at pican's actual desktop and mobile density. T3's six is a useful ceiling, not a design requirement.
- Exact canonical path is the safe first identity. Repository identity and repository-plus-path should wait until worktree behavior is explicitly designed.
- Auto-settle timing should be configurable only after the default is proven. T3 uses three days in its beta sidebar; pican should first validate that against long-running agent work.
- Removing a tracked project must remove only pican's navigation metadata. It must not delete projections or imply deletion of authoritative runtime sessions.
