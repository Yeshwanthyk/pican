---
name: memory
description: Manages project-local long-term memory in SQLite for pi-web users. Use when storing, searching, correcting, or listing memories.
---

# Memory

Use this skill for project memory tasks. Every memory is scoped to a specific project (working directory) so facts stay relevant to the right context.

## Core files
- `$PI_CODING_AGENT_DIR/pi-web-memory.sqlite` (default `~/.pi/agent/`) — primary memory database, auto-initialized on first use
- `.pi/skills/memory/data/schema.sql` — schema definition (shipped with the skill)
- `.pi/skills/memory/scripts/memory.py` — CLI implementation

## Project context

Memories are associated with a project via `--cwd` and `--project`. This allows the same database to serve multiple projects without cross-polluting recall. When a pi session is active, also capture session info so you can trace which conversation produced a memory.

| Context field | Source | Example |
|---|---|---|
| `--cwd` | `pwd` / pi session header `cwd` | `/Users/setkyar/pi-web` |
| `--project` | basename of cwd | `pi-web` |
| `--session-id` | pi session header `id` (8-char UUID) | `a1b2c3d4` |
| `--session-name` | `/name` or `session_info` entry | `Refactor auth module` |

Pi sessions are stored as JSONL trees in `getSessionsDir()` (default `~/.pi/agent/sessions/<encoded-cwd>/`). Each session file has a header with `id`, `cwd`, `timestamp`, and optional `parentSession`. Entries form a tree via `id`/`parentId`; use `/tree` to navigate branches, `/fork` to split into a new session, and `/name` to set a display name.

When the user says "remember that" or "save this for later", record:
- The fact itself (`add-memory`)
- `--cwd` of the current project
- `--project` (derived from cwd basename)
- Current pi session ID and name if a pi session is active

## Common commands
```bash
# Optional: initialize explicitly (normal commands also auto-initialize)
python3 .pi/skills/memory/scripts/memory.py init

# Remember a project fact
python3 .pi/skills/memory/scripts/memory.py add-memory "Prefers tabs over spaces" \
  --category preference --importance 4 --cwd /Users/setkyar/pi-web --project pi-web

# Remember with session context
python3 .pi/skills/memory/scripts/memory.py add-memory "Decided to use Go 1.25 for the backend" \
  --category decision --importance 5 --cwd /Users/setkyar/pi-web --project pi-web \
  --session-id a1b2c3d4 --session-name "pi-web backend refactor"

# Search across all projects or filter by project
python3 .pi/skills/memory/scripts/memory.py search "tabs" --project pi-web
```

## Rules
- Store explicit remember requests without asking again, unless sensitive.
- **Always capture `--cwd` and `--project`** when adding a memory. Derive `--project` from the basename of cwd.
- When a pi session is active, also capture `--session-id` and `--session-name` so memories are traceable to the conversation that produced them.
- Ask before storing sensitive domains like finance, health, legal, identity, addresses, or private documents.
- Never store passwords, API keys, seed phrases, OTPs, or full card numbers.
- Prefer additive schema changes only.
- Use `schema-change` for schema updates.

## Outdated memories

Memories are point-in-time snapshots. A memory recorded three months ago may no longer reflect reality — the codebase changed, the decision was reversed, or the preference shifted.

When recalling memories:
- **Check the timestamp** — `created_at` tells you when the memory was recorded. Older memories carry less weight.
- **Verify against code** — use `read`, `bash`, `rg` to confirm a memory still reflects the current codebase before acting on it.
- **Treat old memories as hints, not facts** — if a memory from March says "Auth uses JWT", but the current code has session cookies, the code wins.
- **Correct stale memories** — when you detect a memory is outdated, use `add-memory` with updated info (the new memory naturally supersedes the old one in search recency). Optionally archive the old entry if needed.
- **Surfacing staleness** — when presenting a recalled memory to the user, note its age: "I recall from [March 2026] that we decided X — let me verify that's still the case."

## When to use
- Remember project-specific facts, decisions, conventions, or patterns
- Save user preferences or personal facts
- Check existing stored context before answering a question about the current project
