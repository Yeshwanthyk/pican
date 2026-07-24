# Installation & Usage

## Features

### Remote control

- Run one binary with Pi, Codex, Claude, or a comma-separated combination (`both` remains Pi+Codex; default `pi`)
- Continue Pi, Codex, or Claude sessions from the browser with text or image attachments
- Start a brand-new session against any project path, right from the web UI
- In-browser model switching and thinking-level selection where the session runtime supports them
- Per-session worker status (idle / running / error) with crashed-worker eviction and 10-minute idle reaping
- Multiple sessions run in parallel — kick off work in one, watch another stream
- `PICAN_TOKEN` for safe LAN exposure — required by default for any explicit non-loopback bind

### Reading sessions

- Browse Pi transcripts and materialized Codex/Claude sessions together, with runtime badges, filters, search, and branch navigation
- Live incremental updates while pi is still running (via fsnotify; ~ms latency)
- Follow mode for tailing active sessions
- Deep links to individual messages
- Download a session as JSONL
- Share static snapshots as secret GitHub Gists
- `/web`, `/remote`, `/refresh`, `/pican token` and `/pican set-token` pi extensions for opening sessions, remote QR, session sync, and token management

## Requirements

- [Go](https://go.dev) 1.25+ (only for building from source)
- `pi` on your `PATH` when Pi runtime is enabled
- Codex CLI installed and signed in when Codex runtime is enabled
- Claude CLI installed and signed in for Claude browser chat, creation, terminal resume, and model availability (cached projections remain readable without it)
- Optional: `gh` for sharing
- On Windows: pi needs a bash shell for its shell tool — [Git for Windows](https://git-scm.com/download/win) is enough (see pi's Windows docs)

## Install

### Pi package (recommended)

```bash
pi install npm:@yeshwanthyk/pican@beta
```

This single command:
- Installs the npm pi package under pi's package directory
- Runs the package `postinstall` script (`install.sh`, or `install.ps1` on Windows)
- Downloads the matching pican binary for your package version and platform from GitHub Releases
- Installs it to `~/.pi/agent/bin/pican` (`pican.exe` on Windows)
- Sets up auto-start on login (launchd on macOS, systemd on Linux, a Run-key launcher on Windows)
- Registers the `/web`, `/remote`, `/refresh`, `/pican token`, and `/pican set-token` pi commands

Session auto-titling is built into pican (not the extension) and configured on the `/settings` page. It's on by default: pican names sessions automatically using a free built-in word heuristic (no AI), re-titling on every new message. You can switch to titling once per session, and/or pick a model to write smarter titles instead of the heuristic.

On Linux, auto-start is configured as a user systemd service at `~/.config/systemd/user/pican.service`. The installer rewrites its `ExecStart` to the actual installed binary path. If Tailscale is available at runtime, pican publishes the localhost server with Tailscale Serve HTTPS. If user systemd is unavailable, run it manually with `~/.pi/agent/bin/pican -o`.

To install only for a specific project (shared with your team via `.pi/settings.json`):

```bash
pi install -l npm:@yeshwanthyk/pican@beta
```

Then restart pi (or run `/reload`), and use `/web`, `/pican`, `/remote`, `/refresh`. Manage your access token with `/pican token` and `/pican set-token`.

If npm aborts with `ENOTEMPTY` while renaming `@yeshwanthyk/pican`, remove npm's stale hidden backup directories and reinstall the beta channel:

```bash
rm -rf ~/.pi/agent/npm/node_modules/@yeshwanthyk/.pican-*
pi install npm:@yeshwanthyk/pican@beta
```

### Quick install (no build tools needed)

macOS / Linux:

```bash
curl -fsSL https://raw.githubusercontent.com/Yeshwanthyk/pican/main/install.sh | bash
```

Windows (PowerShell):

```powershell
irm https://raw.githubusercontent.com/Yeshwanthyk/pican/main/install.ps1 | iex
```

This downloads the latest pican binary, installs it to `/usr/local/bin` (`~/.pi/agent/bin` on Windows), and sets up auto-start on login. No Go, Node, or pi required.

### Download binary

Pre-built binaries are attached to each [GitHub Release](https://github.com/Yeshwanthyk/pican/releases).

```bash
# macOS (Apple Silicon)
curl -L -o pican https://github.com/Yeshwanthyk/pican/releases/latest/download/pican-darwin-arm64
chmod +x pican

# macOS (Intel)
curl -L -o pican https://github.com/Yeshwanthyk/pican/releases/latest/download/pican-darwin-amd64
chmod +x pican

# Linux (amd64)
curl -L -o pican https://github.com/Yeshwanthyk/pican/releases/latest/download/pican-linux-amd64
chmod +x pican

# Linux (arm64)
curl -L -o pican https://github.com/Yeshwanthyk/pican/releases/latest/download/pican-linux-arm64
chmod +x pican
```

```powershell
# Windows (x64)
irm -OutFile pican.exe https://github.com/Yeshwanthyk/pican/releases/latest/download/pican-windows-amd64.exe

# Windows (ARM64)
irm -OutFile pican.exe https://github.com/Yeshwanthyk/pican/releases/latest/download/pican-windows-arm64.exe
```

Then move it to your PATH:

```bash
cp pican ~/.pi/agent/bin/
# or system-wide:
sudo cp pican /usr/local/bin/
```

### Build from source

```bash
git clone https://github.com/Yeshwanthyk/pican.git
cd pican
make build   # builds the Vite bundle, then embeds it into the Go binary

# optional: put it on PATH
cp pican ~/.pi/agent/bin/
```

The frontend bundle is embedded by `web/assets_embed.go`, so `go build` needs
`web/dist` to exist first. `make build` does both steps in order; if you build
by hand, run `npm --prefix web install && npm --prefix web run build` before
`go build ./cmd/pican`.

## Uninstall

```bash
pi remove npm:@yeshwanthyk/pican@beta
```

This runs the package `preuninstall` script (`uninstall.sh`, or `uninstall.ps1`
on Windows), which stops the running instance and removes:

- the pican binary (`~/.pi/agent/bin/pican`, or `/usr/local/bin/pican` for standalone installs)
- the version file (`~/.pi/agent/pican-version`)
- the runtime state file (`~/.pi/agent/pican/pican-state.json`)
- the auto-start config (launchd plist on macOS, systemd user service on Linux, Run-key entry + launcher scripts on Windows)

Your data is preserved so a later reinstall picks up where you left off:
`~/.pi/agent/pican.sqlite`, `~/.pi/agent/pican-memory.sqlite`, your session
files under `~/.pi/agent/sessions/`, and `~/.config/pican/env` (including
`PICAN_TOKEN`). Remove those manually if you want a clean slate.

## Usage

```bash
# Start on the default port (31415)
pican

# Start and open a browser
pican -o

# Custom port
pican -p 8080

# Runtime: pi (default), codex, claude, or a comma-separated set
# "both" remains the Pi+Codex alias
pican -runtime=both
pican -runtime=pi,claude

# Explicit Codex executable path (not a shell command)
pican -runtime=both -codex-command=/absolute/path/to/codex
# equivalent fallback when the flag is absent:
PICAN_CODEX_COMMAND=/absolute/path/to/codex pican -runtime=both

# Claude catalog + browser chat with explicit executable/config home
pican -runtime=claude \
  -claude-command=/absolute/path/to/claude \
  -claude-home=/absolute/path/to/.claude
# Environment fallbacks: PICAN_CLAUDE_COMMAND, PICAN_CLAUDE_HOME,
# then CLAUDE_CONFIG_DIR for the home.

# Override bind host (loopback is unauthenticated by default)
pican --host 127.0.0.1

# Non-loopback bind requires a token — pican refuses to start otherwise
PICAN_TOKEN=$(openssl rand -hex 16) pican --host 192.168.1.50
```

By default, pican enables only Pi and binds to `127.0.0.1`. If Tailscale is running with MagicDNS, pican also runs `tailscale serve --bg --https=<port> http://127.0.0.1:<port>` and prints the HTTPS tailnet URL. Any explicit non-loopback bind requires `PICAN_TOKEN` to be set; pass `--insecure` to override for local testing.

## Remote Access

Leave pican listening locally, then use the printed Tailscale HTTPS URL from your phone or laptop on the tailnet.

On Linux, allow your user to manage Tailscale before installing/running pican, otherwise `tailscale serve` may require sudo and auto-start can fail:

```bash
sudo tailscale set --operator=$USER
```

```bash
# 1. Start pican
pican

# 2. From any other Tailscale-connected device, open the printed
#    "Tailscale HTTPS" URL.
```

> By default, pican refuses to bind to a non-loopback address unless `PICAN_TOKEN` is set — anyone who can reach the bound address could otherwise view sessions and send instructions to pi. To override this guard for local-network testing, pass `--insecure`. **Don't use `--insecure` on Tailscale or any address reachable from outside your machine.**
>
> Clients can pass the token via the `Authorization: Bearer <token>` header, the `X-Pican-Token` header, or once via `?token=<token>` (which sets a `pican_token` cookie for subsequent requests). Tokens passed via `?token=` end up in browser history, server access logs, and `Referer` headers from any links on the page — prefer the header form for anything beyond the initial bookmark.

## Codex runtime

The installed Codex CLI owns sign-in and persistent thread state. pican starts `codex app-server --stdio` with the current environment unchanged, including `HOME`; it never reads `~/.codex/auth.json`. Run `codex` normally first to install/sign in, then choose `-runtime=codex` or `-runtime=both`.

> **Warning:** pican always runs Codex sessions in YOLO mode (`approvalPolicy: never` with `danger-full-access`), equivalent to `codex --yolo`. Model-generated commands can access the whole host filesystem and network without confirmation.

Startup behavior:

- `codex` mode creates `~/.pi/agent/sessions` if absent and exits if its initial Codex catalog sync fails.
- `both` mode requires the existing sessions directory. If Codex is unavailable, Pi keeps working and the UI reports Codex unavailable; sync retries every minute.
- A Codex executable override is one path via `-codex-command` (preferred) or `PICAN_CODEX_COMMAND`. pican appends `app-server --stdio` itself.
- Generated auto-start entries invoke pican without `-runtime`, so they remain Pi-only by default. To persist `codex`/`both`, add `-runtime=…` (and optional `-codex-command=…`) to launchd `ProgramArguments`, systemd `ExecStart`, or the Windows starter's binary command.

Codex remains authoritative under `~/.codex`. pican creates rebuildable `codex-<thread-id>.jsonl` projections under `~/.pi/agent/sessions` so both runtimes use the same browse, render, SSE, download, export, and share paths. Projection refresh is atomic and preserves local names/labels/model/effort metadata. These are not append-only Pi transcripts and can be rebuilt from Codex.

Existing projections remain viewable, downloadable, exportable, and shareable while Codex is unavailable. Chat, create, rename, fork/clone, and model/effort operations require the runtime. This is cached local viewing, not browser-offline support: pican intentionally does not service-worker-cache session data.

Codex sessions support text/images, steering an active turn, persistent queues, cancel, model and reasoning effort, `/review`, `/compact`, rename, labels, fork/clone, status/SSE, and `codex resume <thread-id>` copying from the session header. YOLO mode bypasses command/file approvals. Unexpected approval requests are declined defensively; permission and user-input requests receive empty responses, and MCP elicitation is declined.

## Claude runtime

The configured Claude home defaults to `~/.claude`. pican reads `projects/*/*.jsonl` as the authoritative transcript catalog and never rewrites those files. It creates rebuildable `claude-<session-id>.jsonl` projections under the Pi sessions directory for search, viewing, labels, download, export, share, and live external-session discovery.

Command precedence is `-claude-command`, `PICAN_CLAUDE_COMMAND`, then `claude`. Home precedence is `-claude-home`, `PICAN_CLAUDE_HOME`, `CLAUDE_CONFIG_DIR`, then `~/.claude`. For the default home, pican leaves `CLAUDE_CONFIG_DIR` unset so Claude Code uses the native subscription/OAuth profile; non-default homes remain explicitly isolated. pican probes the installed CLI with `--version` and `auth status --json`; missing CLI/auth disables Claude operations without hiding cached projections. Native changes are debounced and reconciled every minute as recovery. Malformed lines or incomplete appends never authorize projection deletion.

Creating a browser session records a fresh UUID projection; the first prompt creates native Claude state, while existing sessions resume their native UUID. Each active session gets one long-lived installed `claude` bidirectional stream-json process. Text and image input, cancellation, terminal resume, and model discovery are supported. Steering, persistent queues, in-session model/effort changes, rename, fork/clone, archive/delete, approvals, and user questions remain unavailable.

> **Warning:** Claude browser workers always launch with `--dangerously-skip-permissions`. Model-generated commands can access the host without confirmation. pican does not expose Claude approval or `AskUserQuestion` dialogs.

## Browser Chat

Open a session page and use the composer at the bottom to continue that exact Pi, Codex, or Claude session.

- `Enter` sends, `Shift+Enter` inserts a newline
- Drag-and-drop or paste images directly into the composer
- The model picker and thinking/reasoning-level selector are scoped to the session runtime
- Each active session gets one dedicated, reusable Pi, Codex, or Claude worker, so different sessions do not block each other
- Steering and persistent queues appear only for runtimes that support them; Claude requires the current turn to finish or be cancelled before the next send

## Sharing Sessions

Click **Share** on a session page to create a secret GitHub Gist.

Requirements:
- `gh` installed
- `gh auth login` completed

Sharing returns:
- the secret gist URL
- a preview URL at `https://pi.dev/session/#<gistId>`

Shared gists are snapshots and do not live-update.

## Auto-Start on Login

### macOS

```bash
cp init/com.pican.plist ~/Library/LaunchAgents/
launchctl load ~/Library/LaunchAgents/com.pican.plist
```

### Linux (systemd)

```bash
# Install the systemd user service
mkdir -p ~/.config/systemd/user
cp init/pican.service ~/.config/systemd/user/

# Optional: set your PICAN_TOKEN for non-loopback binds
# (or use /pican set-token <token> from inside pi)
mkdir -p ~/.config/pican
echo 'PICAN_TOKEN=your-token-here' > ~/.config/pican/env

# Enable and start
systemctl --user daemon-reload
systemctl --user enable --now pican.service

# Check status
systemctl --user status pican.service

# View logs
journalctl --user -u pican.service -f
```

> For the service to start at boot (before login), use a system service instead:
> copy `init/pican.service` to `/etc/systemd/system/` and use `sudo systemctl`.

### Windows

The installer configures this automatically, without needing admin rights: a
`pican` entry under `HKCU\Software\Microsoft\Windows\CurrentVersion\Run`
launches `~/.config/pican/pican-start.vbs` at login, which starts the binary
hidden (no console window) after loading `~/.config/pican/env`
(`PICAN_TOKEN`, `PATH`, ...).

To manage it by hand:

```powershell
# Start / stop
wscript.exe "$HOME\.config\pican\pican-start.vbs"
taskkill /IM pican.exe /F

# Remove auto-start
Remove-ItemProperty -Path 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Run' -Name 'pican'
```

There is no service supervision on Windows: if pican crashes it stays down
until the next login (launchd/systemd restart it automatically on the other
platforms).
