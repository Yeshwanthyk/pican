# Changelog

All notable changes to pican are documented in this file.

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and
versioning follows [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

Releases are cut locally (no CI): see [RELEASING.md](RELEASING.md) for the
exact bump → build → publish flow. Every release must update this file, bump
`package.json`'s `version`, and create a GitHub release tagged `v<version>`
with the four platform binaries and `sha256sums.txt`.

## [Unreleased]

## [0.0.7] - 2026-08-18

### Changed

- Auto-titles are now written once per session by default, anchored on the
  durable subject of the first user message, instead of being rewritten on
  every user turn. Use the new "Regenerate title" session-menu action (or the
  per-turn setting) when the subject genuinely shifts.
- Title prompts now follow t3code's editorial rules: never copy or truncate a
  message verbatim, avoid project names already visible in the UI, and name
  the product change rather than the mock, plan, branch, or PR used to produce
  it.

### Added

- "Regenerate title" action in the session menu re-titles a session on demand
  (new `/api/regenerate-title` endpoint); an explicit regenerate overrides an
  existing auto or manual title but still loses to a rename made while it runs.

### Fixed

- In-app update now restarts bare/manual-run instances by re-executing the
  binary when no service manager (launchd plist or systemd unit) is present,
  instead of shutting down after the failed service restart.

## [0.0.6] - 2026-08-18

### Added

- Waiting sessions ("Waiting on you") with answer buttons now surface in the
  home feed on mobile, where the rail was previously hidden; peer machines
  show an online-count entry in the home menu on phones.
- Queue button on the composer toolbar now stays visible while idle when the
  queue is non-empty or paused, with a queued-count badge and paused state.
- Queue rows now label the head item "next up" and later items "queued #n",
  and each queued row has a mouse-accessible "Send now" button.
- Skeleton loading rows replace the bare "Loading sessions…" text on the home
  feed.
- The home rail collapses to a single centered column when it has nothing to
  show (no waiting sessions, no peer machines).
- Follow button shows the pending new-message count while streaming.

## [0.0.5] - 2026-08-18

First public release. pican is a fork of
[pi-web](https://github.com/ygncode/pi-web) by Set Kyar Wa Lar (YGNCode), MIT
licensed.

### Added

- Remote control of a pi coding agent from any browser on your network
  (desktop, phone, or tablet), including Tailscale remote access.
- Session transcripts with pinned session chips; pinned chips show the project
  label.
- Tasks, workflows, and subagent activity views.
- Peer "Machines" aggregation for browsing sessions across multiple pican
  instances.
- Static session export (self-contained HTML snapshot).
- In-app updater: checks GitHub Releases, downloads the matching platform
  binary, verifies its sha256 checksum, and atomically swaps it in place.
  The pi-side `/pican update` command uses the same release assets.
- Artifacts panel in the session right sidebar.

### Changed

- Branding and internals migrated from pi-web to pican (module, package,
  commands, env vars, storage).
- Localization reduced to English-only.
- Update channel moved from the npm registry to GitHub Releases.

### Removed

- Schedules feature (cron-based autonomous session firing).
- Done-sound playback on response completion.
- "btw" scratch-chat popup feature.
- Share / GitHub-gist publishing feature.
- Right-sidebar scratchpad.

## Prior history

Commits before `v0.0.5` (the pi-web import and pican migration) are not
summarized here; see the git history and
[pi-web](https://github.com/ygncode/pi-web) for that lineage.