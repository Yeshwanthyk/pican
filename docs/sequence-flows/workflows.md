# Sequence Flow: Workflows Dashboard

The Workflows dashboard is a read-only view over run snapshots written by an
external pi extension under `<agentDir>/workflows/`. pi-web never creates or
modifies these files.

Each valid run directory is named `wf_<12 lowercase hex characters>` and has a
`workflow.json` snapshot. Optional `transcripts.json`, `result.json`, and
`script.js` files add detail to the run view. The list endpoint skips malformed
or missing snapshots so one incomplete run cannot break the dashboard.

## HTTP endpoints

| Method | Path | Purpose |
|--------|------|---------|
| GET | `/api/workflows` | List valid run summaries, newest first |
| GET | `/api/workflows/run?runId=wf_…` | Read one workflow, transcripts, result, and script |

The detail endpoint validates `runId` against the complete run-id pattern
before joining any path. Both endpoints use the same auth middleware as the
other `/api` routes.

## Live updates

`internal/server/workflows_watcher.go` watches the agent directory, the
`workflows/` directory when it appears, and each valid run directory. Writes,
creates, renames, and removals are debounced per run for 100ms. A change emits
a named `workflows-updated` SSE event with `{ "runId": "wf_…" }` on the
`__all__` topic. A poller is used if fsnotify cannot start.

`WorkflowsPage.svelte` listens through the shared status-event connection and
debounces its own refetch. It refreshes the list and, when open, the selected
run. Deep links use `/workflows?runId=wf_…`.
