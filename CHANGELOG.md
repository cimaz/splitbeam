# Changelog

All notable changes to SplitBeam are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [0.3.0] - 2026-10-24

### Added

- Update notification: SplitBeam checks GitHub for a newer release at startup and every 6 hours and
  shows a bar with Download (the .deb or AppImage matching your install), Release notes and
  Skip this version.

## [0.2.0] - 2026-10-24

### Added

- Network section in the sidebar for SFTP servers: password, SSH key (with passphrase) or SSH agent
  sign-in; browse, copy, move, rename, create folders and delete on servers, including transfers between
  servers. Server fingerprints are confirmed on first connection and changes are flagged. Dropped
  connections reconnect automatically.

## [0.1.0] - 2026-10-24

### Added

- Dual pane file browser with sortable Name, Size and Modified columns, editable path bar,
  back/forward history and remembered pane locations.
- Keyboard workflow: F2 rename, F3/F4 open, F5 copy and F6 move to the other pane,
  F7 new folder, F8/Delete move to trash, type-ahead search, Ctrl+H hidden files,
  Ctrl+U swap panes, Ctrl+M mirror the active folder in the other pane.
- Multi-selection with Space/Insert, Ctrl+click and Shift+click; drag items to the other pane
  to copy (Shift to move).
- Favorites sidebar with Home, Desktop, Documents and Downloads by default; add the current
  folder with + or Ctrl+D, remove on hover, drag to reorder.
- Right-click menus for items and for the folder background, also on the Menu key and Shift+F10.
- Recursive one-way folder Sync (Ctrl+S) in either direction, with a preview of changes,
  optional trashing of target-only items, progress and cancel.
- .deb and AppImage packages.
- Released under the MIT License.

[Unreleased]: https://github.com/cimaz/splitbeam/compare/v0.3.0...HEAD
[0.3.0]: https://github.com/cimaz/splitbeam/compare/v0.2.0...v0.3.0
[0.2.0]: https://github.com/cimaz/splitbeam/compare/v0.1.0...v0.2.0
[0.1.0]: https://github.com/cimaz/splitbeam/releases/tag/v0.1.0
