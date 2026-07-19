# pican

pican is a self-hosted browser UI and installable PWA for native [Pi](https://pi.dev) sessions and [Codex CLI](https://developers.openai.com/codex/cli/) threads.

One server can run Pi, Codex, or both. It keeps each runtime authoritative while presenting a shared session list, transcript viewer, composer, and export surface.

## Features

- Unified Pi and Codex session browser
- Live token streaming, tool calls, reasoning, and status updates
- Continue sessions with text and image attachments
- Runtime-scoped model and reasoning-effort controls
- Steering, queued follow-ups, cancellation, fork/clone, rename, labels, archive, and delete
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
pican -runtime=both -p 8080   # custom port
```

Useful environment variables:

```bash
PICAN_TOKEN=...                       # required for non-loopback binds
PICAN_CODEX_COMMAND=/path/to/codex    # Codex executable override
PI_CODING_AGENT_DIR=/path/to/agent    # Pi agent directory override
```

The installed Codex CLI owns authentication and thread state under `~/.codex`; pican never reads `auth.json`. Codex sessions currently run with `approvalPolicy: never` and `danger-full-access`, equivalent to `codex --yolo`.

## Data

- Pi transcripts: `~/.pi/agent/sessions`
- Codex state: `~/.codex`
- pican data: `~/.pi/agent/pican`
- pican database: `~/.pi/agent/pican.sqlite`
- pican memory database: `~/.pi/agent/pican-memory.sqlite`
- pican config: `~/.config/pican/env`

Codex projections under the Pi sessions directory are local presentation caches. Native Codex thread state remains authoritative.

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

Architecture documentation lives in [`docs/architecture`](docs/architecture/README.md).
