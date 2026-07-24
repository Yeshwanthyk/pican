# pican

pican is a self-hosted browser UI and installable PWA for native [Pi](https://pi.dev) sessions, [Codex CLI](https://developers.openai.com/codex/cli/) threads, and Claude Code sessions.

One server can select any registered runtime combination. It keeps native state authoritative while presenting a shared session list, transcript viewer, chat surface, and export surface.

## Features

- Unified Pi, Codex, and Claude session browser
- Live token streaming, tool calls, reasoning, and status updates
- Continue sessions with text and image attachments
- Runtime-scoped model and reasoning-effort controls where supported
- Capability-driven steering, queues, cancellation, lifecycle actions, and labels
- Session search, project grouping, pins, schedules, tasks, workflows, subagents, and scratchpads
- Markdown, syntax highlighting, images, diffs, artifacts, and collapsible tool output
- Static HTML/JSONL export and GitHub Gist sharing
- Responsive desktop/mobile UI, themes, fonts, keyboard navigation, and PWA installation
- Localhost-first serving with optional Tailscale HTTPS and token authentication

## Install

Install as a Pi package:

```bash
pi install npm:@yeshwanthyk/pican@beta
```

The package installs the `pican` binary, configures auto-start, and registers `/web`, `/pican`, `/remote`, and `/refresh`.

Or install the latest standalone release:

```bash
curl -fsSL https://raw.githubusercontent.com/Yeshwanthyk/pican/main/install.sh | bash
```

See [the installation guide](user-docs/en/install.md) for manual downloads, Windows, service configuration, and remote access.

## Run

```bash
pican                         # Pi runtime, port 31415
pican -runtime=codex          # Codex only
pican -runtime=both           # Pi and Codex
pican -runtime=pi,claude      # Pi + Claude catalog and browser chat
pican -runtime=both -p 8080   # custom port
```

Useful environment variables:

```bash
PICAN_TOKEN=...                       # required for non-loopback binds
PICAN_CODEX_COMMAND=/path/to/codex    # Codex executable override
PICAN_CLAUDE_COMMAND=/path/to/claude  # Claude executable override
PICAN_CLAUDE_HOME=/path/to/.claude    # Claude config/transcript home
PI_CODING_AGENT_DIR=/path/to/agent    # Pi agent directory override
```

The installed Codex CLI owns authentication and thread state under `~/.codex`; pican never reads `auth.json`. Codex sessions currently run with `approvalPolicy: never` and `danger-full-access`, equivalent to `codex --yolo`. Claude transcripts under the configured home's `projects/` directory are strictly read-only; pican creates replaceable local projections and runs one installed `claude` stream-json process per active session. Claude browser chat always passes `--dangerously-skip-permissions`; interactive approvals and user questions are not supported.

## Data

- Pi transcripts: `~/.pi/agent/sessions`
- Codex state: `~/.codex`
- Claude state: configured Claude home, default `~/.claude` (read-only)
- pican data: `~/.pi/agent/pican`
- pican database: `~/.pi/agent/pican.sqlite`
- pican memory database: `~/.pi/agent/pican-memory.sqlite`
- pican config: `~/.config/pican/env`

Codex and Claude projections under the Pi sessions directory are local presentation caches. Native runtime state remains authoritative.

## Development

```bash
make setup
make test
make check
make build
./pican -runtime=both
```

```bash
make e2e-setup   # once
make e2e
```

Always use `make build`; it embeds the current frontend assets into the Go binary.
`make check` includes Oxlint, Oxfmt/Svelte formatting checks, TypeScript and `svelte-check`, unit tests, the production build, installer tests, and `go vet`. Playwright remains a separate `make e2e` gate.

Architecture documentation lives in [`docs/architecture`](docs/architecture/README.md).
