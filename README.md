# SplitBeam

A keyboard-friendly dual pane file browser built on Electron.

## Run

```sh
npm install
npm start
```

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
| Ctrl+L | Edit path (supports `~`) |
| Ctrl+R | Refresh |
| Ctrl+Home | Home folder |
| Type letters | Jump to matching name |

Drag items onto the other pane to copy them; hold Shift while dropping to move.
Pane locations, sorting and the hidden-files setting are remembered between sessions.
