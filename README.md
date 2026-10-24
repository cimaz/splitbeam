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
| Ctrl+S | Sync folders (recursive, one way) |
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

Drag items onto the other pane to copy them; hold Shift while dropping to move.
Favorites, pane locations, sorting and the hidden-files setting are remembered between sessions.
