# Sequence Flow: Tasks Board

The Tasks board is a read-only view over JSON stores written by the external
pi-tasks extension. pican never creates or modifies task stores or output
files.

Project stores live directly under `<project>/.pi/tasks/`: `tasks.json` has
project scope and `tasks-<sessionId>.json` has session scope. Named global
stores live under `~/.pi/tasks/`. The list endpoint skips malformed JSON files
so an interrupted or unrelated write cannot break the board.

Task executions may create Pi child sessions named `pi-tasks: <subject>`. The
shared `/api/sessions` and `/api/projects` catalog boundary excludes these
extension-managed children, matching subagent-child filtering so implementation
sessions do not appear as top-level work.

## HTTP endpoints

| Method | Path | Purpose |
|--------|------|---------|
| GET | `/api/tasks?project=<absolute path>` | List project, session, and global task stores |
| GET | `/api/tasks?project=<absolute path>&session=<id>` | List only `tasks.json` and the matching `tasks-<sessionId>.json` |
| GET | `/api/tasks/output?project=<absolute path>&taskId=<id>` | Read a project's task output as plain text |

Both endpoints require an absolute, cleaned project path. The path must match a
project in the sessions cache or contain a `.pi/tasks` directory. Task IDs are
restricted to letters, numbers, dots, underscores, and hyphens before an output
path is constructed. Both endpoints use the same auth middleware as other API
routes.

## Live updates

`internal/server/tasks_watcher.go` lazily registers a project's task directory
after its first query. It watches the nearest existing parent until a missing
`.pi/tasks` directory appears, then watches that directory directly. The global
tasks directory is watched when it exists. Atomic writes, renames, creates, and
removals are debounced for 100ms and emit a named `tasks-updated` SSE event with
`{ "project": "<absolute path or global>" }` on the `__all__` topic.

`TasksPage.svelte` listens through the shared status-event connection and
debounces matching refreshes. Global deep links use `/tasks?project=<absolute
path>`. Session-scoped links include both `session=<id>` and `project=<absolute
path>`, hide the project selector, and link back to the session. The session
command menu always shows Tasks; a session without tasks opens the board's
instructional empty state.
