# Changelog

## 0.0.3 - 2026-07-25

### Added

- Optional pinned-session tabs on desktop and compact pinned-session chips on mobile.
- End-to-end coverage for pinned-session navigation and lifecycle behavior.

### Changed

- Simplified mobile session navigation, actions, and header layout.
- Kept the active project visible while switching between pinned sessions.
- Reduced the session home feed to stable, project-focused navigation.

### Fixed

- Prevented live updates from remounting, flickering, or unexpectedly reordering session rows.
- Kept tracked sessions in their project section while their runtime status changes.
- Preserved mobile session menus while live session data refreshes.
