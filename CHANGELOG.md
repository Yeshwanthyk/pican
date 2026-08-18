# Changelog

All notable changes to pican are documented in this file.

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and
versioning follows [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

Releases are cut locally (no CI): see [RELEASING.md](RELEASING.md) for the
exact bump → build → publish flow. Every release must update this file, bump
`package.json`'s `version`, and create a GitHub release tagged `v<version>`
with the four platform binaries and `sha256sums.txt`.

## [Unreleased]

No unreleased changes yet.

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