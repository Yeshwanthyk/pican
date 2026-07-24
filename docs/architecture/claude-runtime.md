# Claude CLI Runtime

pican catalogs Claude Code sessions from native files and drives live chat through one installed `claude` CLI process per active session. It does not use a Claude SDK and never rewrites Claude's native transcripts.

## Configuration and authority

```bash
pican -runtime=claude
pican -runtime=pi,claude \
  -claude-command=/absolute/path/to/claude \
  -claude-home=/absolute/path/to/.claude
```

Configuration precedence is:

- command: `-claude-command`, `PICAN_CLAUDE_COMMAND`, then `claude` from `PATH`;
- home: `-claude-home`, `PICAN_CLAUDE_HOME`, `CLAUDE_CONFIG_DIR`, then `~/.claude`.

The command value is one executable, never a shell fragment. The default `~/.claude` home leaves `CLAUDE_CONFIG_DIR` unset so Claude Code uses its native subscription/OAuth profile; non-default homes are passed explicitly as `CLAUDE_CONFIG_DIR`. `<claude-home>/projects/*/*.jsonl` is authoritative and strictly read-only. `~/.pi/agent/sessions/**/claude-<native-id>.jsonl` is an atomically replaceable projection that may be deleted and rebuilt.

## Catalog and projection

`internal/claude.Catalog` scans direct project directories and UUID-named JSONL files. Native identity comes from the filename and is checked against every record that declares `sessionId`. Cwd comes from transcript records; Claude's encoded project-directory name is only the fallback. Paths and projection cwd values are canonicalized before storage.

A parser snapshot opens the file read-only, records its initial size, consumes only newline-terminated records within that prefix, and checks size/modtime/file identity afterward. Snapshot stability is tracked separately from catalog completeness: a stable snapshot may still contain an isolated malformed record, while an incomplete tail or concurrent append is never stable enough to retire a live preview. It therefore has these outcomes:

- complete valid file: materialize and allow the enclosing complete catalog scan to reconcile membership;
- malformed complete line, conflicting identity, incomplete tail, or concurrent append: materialize the valid stable prefix but mark the scan partial;
- unknown valid record: preserve it as an opaque `custom_message` with `claudeRaw`;
- unreadable/unparseable file: retain its existing projection and mark the scan partial.

User, assistant, thinking, tool-use, tool-result, image, model, usage, native title, and parent-chain data are translated into pican's rendering contract. Assistant entries retain `claudeMessageId`, allowing the live preview to retire only when the matching native message reaches the projection.

`internal/projections.Store` owns identity locking, safe paths, local metadata preservation, duplicate migration, and fsync-backed atomic replacement. A full sync prunes only a pre-scan snapshot after a complete stable native scan. Per-file watcher refreshes never prune. Startup sync, a one-minute recovery scan, and a 100 ms debounced native watcher cover external changes and missed filesystem events.

## Fresh creation and resume

Creating a Claude session generates a UUID and an empty projection carrying `claudeFresh: true`. This is pican-owned creation intent, not conversation history; complete catalog scans retain it until the first native transcript exists. No file is created under the Claude home.

The first browser prompt starts native creation with `--session-id <uuid>`. Existing sessions, or fresh projections whose native transcript already appeared before worker restart, use `--resume <uuid>`. The flags are mutually exclusive. Every `system:init` must report the requested native ID, canonical cwd, and `permissionMode: "bypassPermissions"`; a mismatch fails and evicts the worker rather than attaching pican to another native session.

## Live worker

The worker manager owns one long-lived process per active pican session:

```text
claude -p
  --input-format stream-json
  --output-format stream-json
  --include-partial-messages
  --verbose
  --dangerously-skip-permissions
  [--model <model>]
  (--session-id <uuid> | --resume <uuid>)
```

Arguments are passed directly as argv, cwd is set on the child process, and both the availability probe and worker remove inherited `ANTHROPIC_API_KEY` so execution uses the configured Claude home's OAuth identity. This prevents a stale key from making the probe pass while the worker fails, and prevents a key from crossing explicitly isolated work/personal homes. `--dangerously-skip-permissions` is unconditional: pican does not present approval or `AskUserQuestion` UI for Claude.

The first input line triggers Claude initialization, so the worker writes the queued first user record and waits up to 35 seconds for the matching init before acknowledging launch. Timeout terminates the process tree and leaves an errored worker for manager eviction. Later prompts reuse the same process. Text and supported image blocks are emitted as one NDJSON object per stdin line. Concurrent steering is rejected because Claude steering has not been proven.

`stream_event` and `assistant` records update a UTF-8-safe bounded transient preview. `result` keeps the worker running while it retries a read-only native transcript refresh. Once a stable snapshot containing the matching native assistant message is projected, the worker marks the preview done, broadcasts the projection reload, and becomes idle. Stdout is never persisted as conversation history. Exact native message IDs prevent preview/projection duplication; a timeout retires the preview with a visible refresh error while the watcher remains the recovery path.

Cancellation writes:

```json
{"type":"control_request","request_id":"...","request":{"subtype":"interrupt"}}
```

A successful `control_response` leaves the process reusable. If the interrupt does not complete within the worker deadline, pican terminates the whole process tree. Malformed or out-of-order known stream-json, native identity violations, stdout/process exit, or crashes put the worker in `error`; unknown well-formed record types are reported and ignored for forward compatibility. The manager evicts an errored worker on the next send, and the composer remains usable so that recovery path is reachable. Intentional close and ten-minute idle reaping close stdin, terminate the child tree, and wait for cleanup; the reaper cannot close a worker reserved by an accepted send.

## Availability and capabilities

Availability is independent from cached projection readability. A bounded cached probe invokes:

```text
claude --version
# Native default profile:
claude auth status --json
# Non-default isolated profile:
CLAUDE_CONFIG_DIR=<configured-home> claude auth status --json
```

A missing executable or logged-out home disables only Claude operations; cached projections remain viewable/exportable. Model discovery exposes the CLI aliases `sonnet`, `opus`, and `haiku`.

Enabled capabilities are create, resume, chat, cancel, image input, cwd-local file references, and model listing. Interactive approvals, user questions, steering, persistent queues, model/effort switching, slash commands, subagents, rename, archive/delete, fork, and clone remain unsupported rather than being emulated.

## Rendering and export

Claude projections use the normal session cache, viewer, search, pagination, labels, SSE projection-file watcher, download, static export, and share paths. Live reconciliation uses `replaceable-projection`, so it always requests a full canonical snapshot and replaces same-ID entries. Static export remains snapshot-only: no Claude process, filesystem watcher, API, SPA, chat, or SSE behavior enters export/share output.
