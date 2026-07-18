# Sequence Flow: Subagents Review

The Subagents panel is a read-only review surface over records written by the external pi-subagents extension. pi-web doesn't create or modify subagent records.

## Data sources and merge

`GET /api/subagents` starts with the existing session-summary cache. Sessions whose resolved display name starts with `subagent: ` become child records; their project, filename, last activity, and live state come from the same summary and running-status machinery used by the sessions index.

The endpoint also scans up to 100 session files active within the last seven days. It only JSON-decodes lines that mention `subagent_spawn` or `subagent-result`, producing parent records without loading whole conversations into memory. A spawn and child merge when their titles and child working directories match and the child's session-header timestamp falls within five minutes after the spawn.

Explicit `done` or `error` results take precedence over live state. Without a result, a running child or parent produces `running`; otherwise the status is `unknown`. Unmatched child and parent records remain visible. Results are sorted by latest activity or spawn time, newest first, and capped at 200.

With `?session=<filename-or-uuid>` the parent scan is restricted to that session and unmatched children are dropped, so the scoped view never leaks other sessions' subagents.

## HTTP endpoint

| Method | Path | Purpose |
|--------|------|---------|
| GET | `/api/subagents` | List merged subagent review records (`?session=` scopes to one parent session) |

## Entry points

Like workflows and tasks, subagents are session-scoped: the session `⋯` menu shows a Subagents item (only when the session has spawn records), which opens `/subagents?session=<id>`. There is no global nav entry; `/subagents` without a param still renders the unscoped list for direct URLs.

## Live updates

`SubagentsPage.svelte` listens on the existing `__all__` SSE topic and debounces refetches for `new-session`, `status-snapshot`, and `status-delta` events by 300ms. No subagent-specific event is required. Child transcripts and parent conversations open through the standard `/session?id=…` SPA route.
