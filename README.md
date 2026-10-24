# SplitBeam

A keyboard-friendly dual pane file browser built on Electron.

## Run

```sh
npm install
npm start
```

## Build packages

```sh
npm run dist            # both .deb and AppImage
npm run dist:deb        # .deb only
npm run dist:appimage   # AppImage only
```

`npm run dist:win` builds the Windows installer and portable .exe (on Linux this needs Wine; the release
workflow below builds them on GitHub's Windows machines instead).

Packages are written to `dist/`. Install the .deb with `sudo apt install ./dist/splitbeam-<version>-amd64.deb`;
the AppImage runs directly after `chmod +x` (it needs `libfuse2`). The app icon source is `build/icon.svg`.

## Versioning and releases

SplitBeam follows [Semantic Versioning](https://semver.org) and records changes in [CHANGELOG.md](CHANGELOG.md).
The version shows in the window title and with `splitbeam --version`.

1. As you work, add entries under `## [Unreleased]` in CHANGELOG.md (`### Added`, `### Changed`, `### Fixed`, …).
2. With a clean working tree, run one of:

   ```sh
   npm run release:patch   # 0.1.0 -> 0.1.1  bug fixes
   npm run release:minor   # 0.1.0 -> 0.2.0  new features
   npm run release:major   # 0.1.0 -> 1.0.0  breaking changes
   ```

   This bumps the version in package.json, moves the Unreleased entries into a dated section,
   commits as "Release vX.Y.Z" and tags `vX.Y.Z`. It stops if Unreleased is empty.
3. Push with `git push --follow-tags`. The tag starts the **Release** workflow on GitHub Actions
   (`.github/workflows/release.yml`), which builds the .deb, AppImage, Windows installer and portable .exe
   and publishes a GitHub release with this version's changelog notes. It can also be run by hand from the
   Actions tab for an existing tag.
4. Done. If you publish by hand instead, attach the .deb and AppImage built with `npm run dist`. Running copies of SplitBeam
   check `https://api.github.com/repos/cimaz/splitbeam/releases/latest` once at startup and offer the
   update (you can also check any time from the Menu, F1); that request is the only network traffic SplitBeam makes besides your SFTP servers.

## Keys

| Key | Action |
| --- | --- |
| Tab, ←/→ | Switch active pane |
| ↑/↓, PgUp/PgDn, Home/End | Move cursor |
| Enter / double-click | Open folder or file (default app) |
| Backspace, Alt+↑ | Parent folder |
| Alt+←/→, mouse back/forward | History back/forward |
| Space / Insert, Shift+↑/↓ | Toggle selection |
| Ctrl+click, Shift+click | Toggle / range select |
| Ctrl+A, Esc | Select all / clear selection |
| F2 | Rename |
| F3 / F4 | Open with default app |
| F5 | Copy to other pane |
| F6 | Move to other pane |
| F7 | New folder |
| F8 / Delete | Move to trash |
| Ctrl+H | Toggle hidden files |
| Ctrl+U | Swap panes |
| Ctrl+M | Mirror active pane's folder in the other pane |
| Ctrl+S | Sync folders (recursive, one way) |
| F1 | Menu: installed version, check for updates, GitHub repository, About |
| Ctrl+L | Edit path (supports `~`) |
| Ctrl+R | Refresh |
| Ctrl+Home | Home folder |
| Ctrl+D | Add current folder to favorites |
| Type letters | Jump to matching name |
| Right-click, Menu key, Shift+F10 | Context menu for the item or folder |

The **Favorites** sidebar starts with Home, Desktop, Documents and Downloads. Click one to open it in the
active pane, use **+** (or Ctrl+D) to add the active pane's current folder, and hover a favorite to remove it with **×**. Drag favorites up or down to reorder them.

**Sync** copies one pane's folder into the other, recursively. Pick the direction (left → right or right → left),
review the list of changes, then confirm. New and changed files are copied with their timestamps; files that
exist only in the target are kept unless you tick the option to move them to the trash.

**Network** (below Favorites) holds your SFTP servers. Click **+** to add one: host, port, username, the folder
to start in, and how to sign in — password (asked when connecting and kept in memory only, never saved), an SSH key
file (passphrases are asked for too) or your SSH agent. Click a server to open it in the active pane; right-click
for Open in other pane, Edit, Disconnect and Remove. A green dot marks connected servers.

Remote folders work like local ones: browse, rename, create folders and copy or move with F5/F6 or drag and drop,
in any direction (local ↔ server, server ↔ server). Opening a remote file downloads a temporary copy. Servers have
no trash, so deleting on a server is permanent. The first connection shows the server's fingerprint to confirm; if
it later changes, SplitBeam warns before connecting. Sync is for local folders only.

Drag items onto the other pane to copy them; hold Shift while dropping to move.
Favorites, pane locations, sorting and the hidden-files setting are remembered between sessions.

## License

[MIT](LICENSE) © 2026 cimaz
