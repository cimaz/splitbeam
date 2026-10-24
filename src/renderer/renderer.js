'use strict';

// `api` is the global exposed by preload.js via contextBridge.
const STORAGE_KEY = 'splitbeam.state';
const ROW_HEIGHT = 24;

const ICON_FOLDER =
  '<svg class="icon" viewBox="0 0 16 16" fill="currentColor"><path d="M1.5 3A1.5 1.5 0 0 1 3 1.5h3.1l1.6 1.8H13A1.5 1.5 0 0 1 14.5 4.8v7.7A1.5 1.5 0 0 1 13 14H3a1.5 1.5 0 0 1-1.5-1.5z"/></svg>';
const ICON_FILE =
  '<svg class="icon" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.2"><path d="M4 1.5h5.5L13 5v9.5H4z"/><path d="M9.5 1.5V5H13"/></svg>';
const ICON_UP =
  '<svg class="icon" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M8 13V3M3.5 7.5 8 3l4.5 4.5"/></svg>';

let sep = '/';
let homeDir = '/';
let showHidden = false;
let activePane = null;
let dragSource = null;
let favorites = [];
const panes = {};

// ---------- helpers ----------

function cleanError(err) {
  const msg = String(err && err.message ? err.message : err);
  return msg.replace(/^Error invoking remote method '[^']+': (Error: )?/, '');
}

function basename(p) {
  const trimmed = p.length > 1 && p.endsWith(sep) ? p.slice(0, -1) : p;
  return trimmed.slice(trimmed.lastIndexOf(sep) + 1);
}

function formatSize(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  const units = ['KB', 'MB', 'GB', 'TB'];
  let n = bytes / 1024;
  let i = 0;
  while (n >= 1024 && i < units.length - 1) {
    n /= 1024;
    i++;
  }
  return `${n < 10 ? n.toFixed(1) : Math.round(n)} ${units[i]}`;
}

function formatDate(ms) {
  if (!ms) return '';
  const d = new Date(ms);
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function describe(paths) {
  return paths.length === 1 ? `"${basename(paths[0])}"` : `${paths.length} items`;
}

function loadState() {
  try {
    return JSON.parse(localStorage.getItem(STORAGE_KEY)) || {};
  } catch {
    return {};
  }
}

function saveState() {
  try {
    localStorage.setItem(
      STORAGE_KEY,
      JSON.stringify({
        showHidden,
        favorites,
        active: activePane && activePane.side,
        left: { path: panes.left.path, sort: panes.left.sort },
        right: { path: panes.right.path, sort: panes.right.sort },
      })
    );
  } catch {
    // storage unavailable; not critical
  }
}

// ---------- dialog ----------

const dialogEl = document.getElementById('dialog');
const dlgMessage = dialogEl.querySelector('.dlg-message');
const dlgInput = dialogEl.querySelector('.dlg-input');
const dlgButtons = dialogEl.querySelector('.dlg-buttons');

/**
 * Shows a modal dialog. Resolves to { value, text } where value is the clicked
 * button's value ('' when cancelled with Escape) and text is the input content.
 */
function showDialog({ message, input = null, selectEnd = null, buttons }) {
  return new Promise((resolve) => {
    dlgMessage.textContent = message;
    dlgInput.hidden = input === null;
    dlgInput.value = input ?? '';
    dlgButtons.replaceChildren();
    let primary = null;
    for (const b of buttons) {
      const btn = document.createElement('button');
      btn.textContent = b.label;
      btn.value = b.value;
      if (b.kind) btn.className = b.kind;
      if (b.kind === 'primary' || b.kind === 'danger') primary = btn;
      dlgButtons.append(btn);
    }
    dialogEl.returnValue = '';
    dialogEl.addEventListener(
      'close',
      () => {
        resolve({ value: dialogEl.returnValue, text: dlgInput.value.trim() });
        if (activePane) activePane.list.focus();
      },
      { once: true }
    );
    dlgInput.onkeydown = (e) => {
      if (e.key === 'Enter' && primary) {
        e.preventDefault();
        dialogEl.close(primary.value);
      }
    };
    dialogEl.showModal();
    if (input !== null) {
      dlgInput.focus();
      dlgInput.setSelectionRange(0, selectEnd ?? dlgInput.value.length);
    } else if (primary) {
      primary.focus();
    }
  });
}

const alertError = (message) =>
  showDialog({ message, buttons: [{ label: 'OK', value: 'ok', kind: 'primary' }] });

// ---------- pane ----------

class Pane {
  constructor(side, el) {
    this.side = side;
    this.el = el;
    this.path = null;
    this.parent = null;
    this.entries = [];
    this.view = [];
    this.cursor = 0;
    this.selected = new Set();
    this.anchor = 0;
    this.sort = { key: 'name', desc: false };
    this.history = [];
    this.historyIndex = -1;
    this.typeahead = '';
    this.typeaheadTimer = null;

    el.append(document.getElementById('pane-template').content.cloneNode(true));
    this.list = el.querySelector('.list');
    this.pathInput = el.querySelector('.path');
    this.status = el.querySelector('.status');
    this.sortButtons = el.querySelectorAll('.colhead button');

    this.bindEvents();
  }

  get other() {
    return this.side === 'left' ? panes.right : panes.left;
  }

  bindEvents() {
    this.el.addEventListener('mousedown', (e) => {
      setActive(this);
      if (e.button === 3) this.back();
      if (e.button === 4) this.forward();
    });

    this.el.querySelector('.up').addEventListener('click', () => this.goUp());
    this.el.querySelector('.home').addEventListener('click', () => this.navigate(homeDir));

    this.pathInput.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        this.navigate(this.pathInput.value.trim()).then(() => this.list.focus());
      } else if (e.key === 'Escape') {
        this.pathInput.value = this.path;
        this.list.focus();
      }
      e.stopPropagation();
    });
    this.pathInput.addEventListener('blur', () => {
      this.pathInput.value = this.path;
    });

    for (const btn of this.sortButtons) {
      btn.addEventListener('click', () => {
        const key = btn.dataset.sort;
        this.sort = { key, desc: this.sort.key === key ? !this.sort.desc : false };
        const current = this.view[this.cursor];
        this.applyView();
        this.focusName(current && current.name);
        this.render();
        saveState();
      });
    }

    this.list.addEventListener('mousedown', (e) => {
      const row = e.target.closest('.row');
      if (!row || e.button !== 0) return;
      const i = Number(row.dataset.index);
      if (e.ctrlKey || e.metaKey) {
        this.toggleSelect(i);
        this.anchor = i;
      } else if (e.shiftKey) {
        this.selectRange(this.anchor, i);
      } else {
        this.anchor = i;
      }
      this.cursor = i;
      // Update rows in place: replacing them would break dblclick and dragstart,
      // which need the same element under both clicks.
      this.updateRows();
    });

    this.list.addEventListener('dblclick', (e) => {
      const row = e.target.closest('.row');
      if (row) this.openEntry(this.view[Number(row.dataset.index)]);
    });

    this.list.addEventListener('contextmenu', (e) => {
      e.preventDefault();
      setActive(this);
      const row = e.target.closest('.row');
      const entry = row && this.view[Number(row.dataset.index)];
      if (!entry || entry.isParent) return showFolderMenu(this);
      // Right-clicking outside the selection targets just that item, like other file managers
      if (!this.selected.has(entry.path)) this.selected.clear();
      this.cursor = Number(row.dataset.index);
      this.anchor = this.cursor;
      this.updateRows();
      showItemMenu(this, entry);
    });

    // Drag and drop between panes
    this.list.addEventListener('dragstart', (e) => {
      const row = e.target.closest('.row');
      const entry = row && this.view[Number(row.dataset.index)];
      if (!entry || entry.isParent) return e.preventDefault();
      const paths = this.selected.has(entry.path) ? [...this.selected] : [entry.path];
      dragSource = { pane: this, paths };
      e.dataTransfer.effectAllowed = 'copyMove';
      e.dataTransfer.setData('text/plain', paths.join('\n'));
    });
    this.list.addEventListener('dragend', () => {
      dragSource = null;
    });
    this.el.addEventListener('dragover', (e) => {
      if (!dragSource || dragSource.pane === this) return;
      e.preventDefault();
      e.dataTransfer.dropEffect = e.shiftKey ? 'move' : 'copy';
      this.el.classList.add('drop-target');
    });
    this.el.addEventListener('dragleave', (e) => {
      if (!this.el.contains(e.relatedTarget)) this.el.classList.remove('drop-target');
    });
    this.el.addEventListener('drop', (e) => {
      this.el.classList.remove('drop-target');
      if (!dragSource || dragSource.pane === this) return;
      e.preventDefault();
      const { pane, paths } = dragSource;
      dragSource = null;
      transfer(e.shiftKey ? 'move' : 'copy', pane, paths, this.path);
    });
  }

  async load(dir, { focus = null, record = true } = {}) {
    let result;
    try {
      result = await api.list(dir);
    } catch (err) {
      this.setStatus(cleanError(err), true);
      return false;
    }
    const changedDir = result.path !== this.path;
    this.path = result.path;
    this.parent = result.parent;
    this.entries = result.entries;
    this.pathInput.value = this.path;

    if (changedDir) {
      this.selected.clear();
      this.cursor = 0;
      this.anchor = 0;
      this.list.scrollTop = 0;
      if (record) {
        this.history = this.history.slice(0, this.historyIndex + 1);
        this.history.push(this.path);
        this.historyIndex = this.history.length - 1;
      }
    } else {
      const existing = new Set(this.entries.map((e) => e.path));
      for (const p of this.selected) if (!existing.has(p)) this.selected.delete(p);
    }

    const current = !changedDir && this.view[this.cursor];
    this.applyView();
    this.focusName(focus ?? (current && current.name));
    this.render();
    if (this === activePane) renderFavorites();
    saveState();
    return true;
  }

  navigate(dir, opts) {
    return this.load(dir, opts);
  }

  refresh() {
    return this.path ? this.load(this.path) : Promise.resolve(false);
  }

  goUp() {
    if (this.parent) this.navigate(this.parent, { focus: basename(this.path) });
  }

  back() {
    if (this.historyIndex <= 0) return;
    this.historyIndex--;
    this.load(this.history[this.historyIndex], { record: false });
  }

  forward() {
    if (this.historyIndex >= this.history.length - 1) return;
    this.historyIndex++;
    this.load(this.history[this.historyIndex], { record: false });
  }

  applyView() {
    const { key, desc } = this.sort;
    const dir = desc ? -1 : 1;
    const byName = (a, b) => a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: 'base' });
    const visible = this.entries.filter((e) => showHidden || !e.hidden);
    visible.sort((a, b) => {
      if (a.isDir !== b.isDir) return a.isDir ? -1 : 1;
      if (key !== 'name' && a[key] !== b[key]) return (a[key] - b[key]) * dir;
      return byName(a, b) * (key === 'name' ? dir : 1);
    });
    this.view = this.parent ? [{ name: '..', path: this.parent, isDir: true, isParent: true }, ...visible] : visible;
    for (const p of this.selected) {
      if (!visible.some((e) => e.path === p)) this.selected.delete(p);
    }
  }

  focusName(name) {
    const i = name ? this.view.findIndex((e) => e.name === name) : -1;
    this.cursor = i >= 0 ? i : Math.min(this.cursor, Math.max(0, this.view.length - 1));
  }

  render() {
    const frag = document.createDocumentFragment();
    this.view.forEach((entry, i) => {
      const row = document.createElement('div');
      row.className = 'row';
      row.dataset.index = i;
      if (entry.isDir) row.classList.add('dir');
      if (entry.hidden) row.classList.add('hidden');
      if (entry.isLink) row.classList.add('link');
      if (i === this.cursor) row.classList.add('cursor');
      if (this.selected.has(entry.path)) row.classList.add('selected');
      row.draggable = !entry.isParent;

      const name = document.createElement('span');
      name.className = 'name';
      name.innerHTML = entry.isParent ? ICON_UP : entry.isDir ? ICON_FOLDER : ICON_FILE;
      const label = document.createElement('span');
      label.textContent = entry.name;
      name.append(label);
      if (entry.isLink) name.title = 'Symbolic link';

      const size = document.createElement('span');
      size.className = 'size';
      size.textContent = entry.isParent ? '' : entry.isDir ? '<DIR>' : formatSize(entry.size);

      const mtime = document.createElement('span');
      mtime.className = 'mtime';
      mtime.textContent = entry.isParent ? '' : formatDate(entry.mtime);

      row.append(name, size, mtime);
      frag.append(row);
    });
    this.list.replaceChildren(frag);

    for (const btn of this.sortButtons) {
      btn.classList.toggle('sorted', btn.dataset.sort === this.sort.key);
      btn.classList.toggle('desc', this.sort.desc);
    }

    this.scrollToCursor();
    this.updateStatus();
  }

  scrollToCursor() {
    const row = this.list.children[this.cursor];
    if (row) row.scrollIntoView({ block: 'nearest' });
  }

  setCursor(i) {
    if (!this.view.length) return;
    const next = Math.max(0, Math.min(this.view.length - 1, i));
    const rows = this.list.children;
    if (rows[this.cursor]) rows[this.cursor].classList.remove('cursor');
    this.cursor = next;
    if (rows[next]) rows[next].classList.add('cursor');
    this.scrollToCursor();
  }

  /** Refreshes cursor/selection highlighting without rebuilding the rows. */
  updateRows() {
    const rows = this.list.children;
    for (let i = 0; i < rows.length; i++) {
      rows[i].classList.toggle('cursor', i === this.cursor);
      rows[i].classList.toggle('selected', this.selected.has(this.view[i].path));
    }
    this.scrollToCursor();
    this.updateStatus();
  }

  pageSize() {
    return Math.max(1, Math.floor(this.list.clientHeight / ROW_HEIGHT) - 1);
  }

  toggleSelect(i) {
    const entry = this.view[i];
    if (!entry || entry.isParent) return;
    if (this.selected.has(entry.path)) this.selected.delete(entry.path);
    else this.selected.add(entry.path);
  }

  selectRange(from, to) {
    const [a, b] = from < to ? [from, to] : [to, from];
    for (let i = a; i <= b; i++) {
      const entry = this.view[i];
      if (entry && !entry.isParent) this.selected.add(entry.path);
    }
  }

  selectAll() {
    for (const e of this.view) if (!e.isParent) this.selected.add(e.path);
    this.render();
  }

  clearSelection() {
    this.selected.clear();
    this.render();
  }

  /** Selected items, or the item under the cursor if nothing is selected. */
  targets() {
    if (this.selected.size) return [...this.selected];
    const entry = this.view[this.cursor];
    return entry && !entry.isParent ? [entry.path] : [];
  }

  async openEntry(entry) {
    if (!entry) return;
    if (entry.isParent) return this.goUp();
    if (entry.isDir) return this.navigate(entry.path);
    try {
      await api.open(entry.path);
    } catch (err) {
      this.setStatus(cleanError(err), true);
    }
  }

  typeAhead(char) {
    clearTimeout(this.typeaheadTimer);
    this.typeahead += char.toLowerCase();
    this.typeaheadTimer = setTimeout(() => (this.typeahead = ''), 900);
    const i = this.view.findIndex((e) => !e.isParent && e.name.toLowerCase().startsWith(this.typeahead));
    if (i >= 0) this.setCursor(i);
  }

  setStatus(text, isError = false) {
    this.status.textContent = text;
    this.status.classList.toggle('error', isError);
    this.status.title = text;
  }

  updateStatus() {
    let dirs = 0;
    let files = 0;
    let selSize = 0;
    for (const e of this.view) {
      if (e.isParent) continue;
      if (e.isDir) dirs++;
      else files++;
      if (this.selected.has(e.path) && !e.isDir) selSize += e.size;
    }
    let text = `${dirs} folder${dirs === 1 ? '' : 's'}, ${files} file${files === 1 ? '' : 's'}`;
    if (this.selected.size) text += `  ·  ${this.selected.size} selected (${formatSize(selSize)})`;
    const hiddenCount = this.entries.length - (dirs + files);
    if (hiddenCount > 0) text += `  ·  ${hiddenCount} hidden`;
    this.setStatus(text);
  }
}

// ---------- operations ----------

function setActive(pane) {
  if (activePane === pane) return;
  if (activePane) activePane.el.classList.remove('active');
  activePane = pane;
  pane.el.classList.add('active');
  if (document.activeElement !== pane.pathInput) pane.list.focus();
  renderFavorites();
  saveState();
}

// ---------- favorites ----------

const favoritesList = document.querySelector('.favorites');

function renderFavorites() {
  const frag = document.createDocumentFragment();
  favorites.forEach((fav, i) => {
    const li = document.createElement('li');
    li.dataset.index = i;
    li.title = fav.path;
    li.draggable = true;
    if (activePane && activePane.path === fav.path) li.classList.add('current');

    const name = document.createElement('span');
    name.className = 'fav-name';
    name.textContent = fav.name;

    const remove = document.createElement('button');
    remove.className = 'fav-remove';
    remove.title = 'Remove from favorites';
    remove.textContent = '×';

    li.insertAdjacentHTML('afterbegin', ICON_FOLDER);
    li.append(name, remove);
    frag.append(li);
  });
  favoritesList.replaceChildren(frag);
}

/** Adds `dir` (default: the pane's current folder) to favorites after asking for a name. */
async function addFavorite(pane, dir = pane && pane.path) {
  if (!dir) return;
  if (favorites.some((f) => f.path === dir)) {
    pane.setStatus('This folder is already in favorites');
    return;
  }
  const { value, text } = await showDialog({
    message: `Add to favorites:\n${dir}\n\nName`,
    input: basename(dir) || dir,
    buttons: [
      { label: 'Cancel', value: '' },
      { label: 'Add', value: 'go', kind: 'primary' },
    ],
  });
  if (!value) return;
  favorites.push({ name: text || basename(dir) || dir, path: dir });
  renderFavorites();
  saveState();
}

favoritesList.addEventListener('click', (e) => {
  const li = e.target.closest('li');
  if (!li) return;
  const i = Number(li.dataset.index);
  if (e.target.closest('.fav-remove')) {
    favorites.splice(i, 1);
    renderFavorites();
    saveState();
  } else if (activePane) {
    activePane.navigate(favorites[i].path);
  }
  // Hand keyboard focus back to the active pane
  if (activePane) activePane.list.focus();
});

// Reordering favorites by drag and drop
let favDragIndex = null;

/** Where a drop at this event's position would insert, as an index into favorites. */
function favDropTarget(e) {
  const li = e.target.closest('.favorites li');
  if (!li) return { index: favorites.length, li: null, after: true };
  const rect = li.getBoundingClientRect();
  const after = e.clientY > rect.top + rect.height / 2;
  return { index: Number(li.dataset.index) + (after ? 1 : 0), li, after };
}

function clearFavDropMarkers() {
  for (const el of favoritesList.querySelectorAll('.drop-before, .drop-after')) {
    el.classList.remove('drop-before', 'drop-after');
  }
}

favoritesList.addEventListener('dragstart', (e) => {
  const li = e.target.closest('li');
  if (!li) return;
  favDragIndex = Number(li.dataset.index);
  e.dataTransfer.effectAllowed = 'move';
  e.dataTransfer.setData('text/plain', favorites[favDragIndex].path);
  li.classList.add('dragging');
});

favoritesList.addEventListener('dragover', (e) => {
  if (favDragIndex === null) return;
  e.preventDefault();
  e.dataTransfer.dropEffect = 'move';
  const { li, after } = favDropTarget(e);
  clearFavDropMarkers();
  const marker = li || favoritesList.lastElementChild;
  if (marker) marker.classList.add(after ? 'drop-after' : 'drop-before');
});

favoritesList.addEventListener('dragleave', (e) => {
  if (!favoritesList.contains(e.relatedTarget)) clearFavDropMarkers();
});

favoritesList.addEventListener('drop', (e) => {
  if (favDragIndex === null) return;
  e.preventDefault();
  let { index } = favDropTarget(e);
  const [moved] = favorites.splice(favDragIndex, 1);
  if (index > favDragIndex) index--;
  favorites.splice(index, 0, moved);
  favDragIndex = null;
  renderFavorites();
  saveState();
});

favoritesList.addEventListener('dragend', () => {
  favDragIndex = null;
  clearFavDropMarkers();
  for (const el of favoritesList.querySelectorAll('.dragging')) el.classList.remove('dragging');
});

document.querySelector('.fav-add').addEventListener('click', () => addFavorite(activePane));

// ---------- context menus ----------

const SEPARATOR = { type: 'separator' };

async function copyText(pane, text, what) {
  try {
    await api.copyText(text);
    pane.setStatus(`Copied ${what} to clipboard`);
  } catch (err) {
    pane.setStatus(cleanError(err), true);
  }
}

/** Menu position below the cursor row, for menus opened from the keyboard. */
function cursorMenuPosition(pane) {
  const row = pane.list.children[pane.cursor];
  const r = (row || pane.list).getBoundingClientRect();
  return { x: r.left + 24, y: row ? r.bottom : r.top };
}

async function showItemMenu(pane, entry, pos) {
  const targets = pane.targets();
  const multi = targets.length > 1;
  const count = multi ? ` ${targets.length} items` : '';
  const choice = await api.popupMenu(
    [
      { id: 'open', label: entry.isDir ? 'Open' : 'Open with default app', accelerator: 'Enter' },
      entry.isDir && { id: 'openOther', label: 'Open in other pane' },
      { id: 'reveal', label: 'Show in system file manager' },
      SEPARATOR,
      { id: 'copy', label: `Copy${count} to other pane`, accelerator: 'F5' },
      { id: 'move', label: `Move${count} to other pane`, accelerator: 'F6' },
      { id: 'rename', label: 'Rename', accelerator: 'F2', enabled: !multi },
      { id: 'trash', label: `Move${count} to trash`, accelerator: 'F8' },
      SEPARATOR,
      { id: 'copyPath', label: multi ? 'Copy paths' : 'Copy path' },
      { id: 'copyName', label: multi ? 'Copy names' : 'Copy name' },
      entry.isDir && {
        id: 'favorite',
        label: 'Add to favorites',
        enabled: !favorites.some((f) => f.path === entry.path),
      },
      SEPARATOR,
      { id: 'mkdir', label: 'New folder', accelerator: 'F7' },
    ].filter(Boolean),
    pos
  );

  switch (choice) {
    case 'open':
      return pane.openEntry(entry);
    case 'openOther':
      return pane.other.navigate(entry.path);
    case 'reveal':
      return api.reveal(entry.path);
    case 'copyPath':
      return copyText(pane, targets.join('\n'), multi ? 'paths' : 'path');
    case 'copyName':
      return copyText(pane, targets.map(basename).join('\n'), multi ? 'names' : 'name');
    case 'favorite':
      return addFavorite(pane, entry.path);
    case 'copy':
    case 'move':
    case 'rename':
    case 'trash':
    case 'mkdir':
      return runAction(choice);
  }
}

async function showFolderMenu(pane, pos) {
  const choice = await api.popupMenu([
    { id: 'mkdir', label: 'New folder', accelerator: 'F7' },
    { id: 'refresh', label: 'Refresh', accelerator: 'CmdOrCtrl+R' },
    { id: 'hidden', label: showHidden ? 'Hide hidden files' : 'Show hidden files', accelerator: 'CmdOrCtrl+H' },
    SEPARATOR,
    { id: 'mirror', label: 'Open this folder in other pane', accelerator: 'CmdOrCtrl+M' },
    { id: 'openExternal', label: 'Open in system file manager' },
    SEPARATOR,
    { id: 'copyPath', label: 'Copy folder path' },
    {
      id: 'favorite',
      label: 'Add folder to favorites',
      accelerator: 'CmdOrCtrl+D',
      enabled: !favorites.some((f) => f.path === pane.path),
    },
  ], pos);

  switch (choice) {
    case 'refresh':
      return pane.refresh();
    case 'openExternal':
      return api.open(pane.path).catch((err) => pane.setStatus(cleanError(err), true));
    case 'copyPath':
      return copyText(pane, pane.path, 'folder path');
    case 'favorite':
      return addFavorite(pane);
    case 'mkdir':
    case 'hidden':
    case 'mirror':
      return runAction(choice);
  }
}

async function transfer(kind, srcPane, paths, destDir) {
  if (!paths.length) return;
  const verb = kind === 'copy' ? 'Copy' : 'Move';
  if (srcPane.path === destDir) {
    srcPane.setStatus(`Cannot ${kind} into the same folder`, true);
    return;
  }

  const conflicts = [];
  for (const p of paths) {
    if (await api.exists(await api.join(destDir, basename(p)))) conflicts.push(p);
  }

  let message = `${verb} ${describe(paths)} to\n${destDir}`;
  const buttons = [{ label: 'Cancel', value: '' }];
  if (conflicts.length) {
    message += `\n\n${describe(conflicts)} already exist${conflicts.length === 1 ? 's' : ''} in the destination.`;
    if (conflicts.length < paths.length) buttons.push({ label: 'Skip existing', value: 'skip' });
    buttons.push({ label: 'Overwrite', value: 'overwrite', kind: 'danger' });
  } else {
    buttons.push({ label: verb, value: 'go', kind: 'primary' });
  }

  const { value } = await showDialog({ message, buttons });
  if (!value) return;

  const todo = value === 'skip' ? paths.filter((p) => !conflicts.includes(p)) : paths;
  const errors = [];
  for (let i = 0; i < todo.length; i++) {
    srcPane.setStatus(`${kind === 'copy' ? 'Copying' : 'Moving'} ${i + 1}/${todo.length}: ${basename(todo[i])}`);
    try {
      await api[kind](todo[i], destDir);
    } catch (err) {
      errors.push(`${basename(todo[i])}: ${cleanError(err)}`);
    }
  }

  srcPane.selected.clear();
  await Promise.all([srcPane.refresh(), srcPane.other.refresh()]);
  if (errors.length) await alertError(`${verb} finished with errors:\n\n${errors.join('\n')}`);
}

async function makeDir(pane) {
  const { value, text } = await showDialog({
    message: `Create a new folder in\n${pane.path}`,
    input: '',
    buttons: [
      { label: 'Cancel', value: '' },
      { label: 'Create', value: 'go', kind: 'primary' },
    ],
  });
  if (!value || !text) return;
  try {
    await api.mkdir(pane.path, text);
    await pane.load(pane.path, { focus: text });
    if (pane.other.path === pane.path) pane.other.refresh();
  } catch (err) {
    alertError(cleanError(err));
  }
}

async function rename(pane) {
  const entry = pane.view[pane.cursor];
  if (!entry || entry.isParent) return;
  const dot = entry.isDir ? -1 : entry.name.lastIndexOf('.');
  const { value, text } = await showDialog({
    message: `Rename "${entry.name}" to`,
    input: entry.name,
    selectEnd: dot > 0 ? dot : null,
    buttons: [
      { label: 'Cancel', value: '' },
      { label: 'Rename', value: 'go', kind: 'primary' },
    ],
  });
  if (!value || !text || text === entry.name) return;
  try {
    await api.rename(entry.path, text);
    pane.selected.delete(entry.path);
    await pane.load(pane.path, { focus: text });
    if (pane.other.path === pane.path) pane.other.refresh();
  } catch (err) {
    alertError(cleanError(err));
  }
}

async function trash(pane) {
  const paths = pane.targets();
  if (!paths.length) return;
  const { value } = await showDialog({
    message: `Move ${describe(paths)} to the trash?`,
    buttons: [
      { label: 'Cancel', value: '' },
      { label: 'Move to trash', value: 'go', kind: 'danger' },
    ],
  });
  if (!value) return;
  const errors = [];
  for (const p of paths) {
    try {
      await api.trash(p);
    } catch (err) {
      errors.push(`${basename(p)}: ${cleanError(err)}`);
    }
  }
  pane.selected.clear();
  await Promise.all([pane.refresh(), pane.other.refresh()]);
  if (errors.length) alertError(`Some items could not be trashed:\n\n${errors.join('\n')}`);
}

function toggleHidden() {
  showHidden = !showHidden;
  for (const pane of Object.values(panes)) {
    const current = pane.view[pane.cursor];
    pane.applyView();
    pane.focusName(current && current.name);
    pane.render();
  }
  saveState();
}

function swapPanes() {
  const { left, right } = panes;
  const [l, r] = [left.path, right.path];
  left.navigate(r);
  right.navigate(l);
}

function runAction(action) {
  const pane = activePane;
  switch (action) {
    case 'rename':
      return rename(pane);
    case 'open':
      return pane.openEntry(pane.view[pane.cursor]);
    case 'copy':
      return transfer('copy', pane, pane.targets(), pane.other.path);
    case 'move':
      return transfer('move', pane, pane.targets(), pane.other.path);
    case 'mkdir':
      return makeDir(pane);
    case 'trash':
      return trash(pane);
    case 'hidden':
      return toggleHidden();
    case 'swap':
      return swapPanes();
    case 'mirror':
      return pane.other.navigate(pane.path);
    case 'sync':
      return openSync();
  }
}

// ---------- sync ----------

const syncEl = document.getElementById('sync-dialog');
const syncSummary = syncEl.querySelector('.sync-summary');
const syncPlanList = syncEl.querySelector('.sync-plan');
const syncDelete = syncEl.querySelector('.sync-delete');
const syncProgress = syncEl.querySelector('.sync-progress');
const syncProgressBar = syncProgress.querySelector('progress');
const syncCurrent = syncEl.querySelector('.sync-current');
const syncRunBtn = syncEl.querySelector('.sync-run');
const syncCancelBtn = syncEl.querySelector('.sync-cancel');
const syncRadios = syncEl.querySelectorAll('input[name="sync-direction"]');
const SYNC_LIST_LIMIT = 500;
const SYNC_LABELS = { new: 'new', update: 'update', replace: 'replace', delete: 'trash' };

let syncPlanId = null;
let syncToken = 0;
let syncRunning = false;

/** The selected direction: the radio value names the source pane. */
function syncDirection() {
  const from = [...syncRadios].find((r) => r.checked).value;
  const source = panes[from];
  return { source: source.path, target: source.other.path };
}

function openSync() {
  for (const side of ['left', 'right']) {
    const p = panes[side];
    syncEl.querySelector(`[data-paths="${side}"]`).textContent = `${p.path}  →  ${p.other.path}`;
  }
  for (const r of syncRadios) r.checked = r.value === activePane.side;
  syncDelete.checked = false;
  syncProgress.hidden = true;
  syncRunBtn.hidden = false;
  syncCancelBtn.textContent = 'Cancel';
  setSyncInputsDisabled(false);
  syncEl.showModal();
  compareSync();
}

function setSyncInputsDisabled(disabled) {
  for (const r of syncRadios) r.disabled = disabled;
  syncDelete.disabled = disabled;
}

function setSyncSummary(text, isError = false) {
  syncSummary.textContent = text;
  syncSummary.classList.toggle('error', isError);
}

async function compareSync() {
  const token = ++syncToken;
  syncPlanId = null;
  syncRunBtn.disabled = true;
  syncPlanList.replaceChildren();
  setSyncSummary('Comparing…');
  const { source, target } = syncDirection();
  try {
    const plan = await api.syncPlan(source, target, syncDelete.checked);
    if (token !== syncToken) return; // direction or options changed meanwhile
    syncPlanId = plan.id;
    renderSyncPlan(plan);
    syncRunBtn.disabled = plan.actions.length === 0;
  } catch (err) {
    if (token === syncToken) setSyncSummary(cleanError(err), true);
  }
}

function syncListItem(cls, badge, rel, meta = '') {
  const li = document.createElement('li');
  li.className = cls;
  for (const [className, text] of [['badge', badge], ['rel', rel], ['meta', meta]]) {
    const span = document.createElement('span');
    span.className = className;
    span.textContent = text;
    li.append(span);
  }
  return li;
}

function renderSyncPlan({ actions, errors, unchanged }) {
  const counts = { new: 0, update: 0, replace: 0, delete: 0 };
  for (const a of actions) counts[a.type]++;
  const parts = [];
  if (counts.new) parts.push(`${counts.new} new`);
  if (counts.update) parts.push(`${counts.update} to update`);
  if (counts.replace) parts.push(`${counts.replace} to replace`);
  if (counts.delete) parts.push(`${counts.delete} to trash`);
  parts.push(`${unchanged} unchanged`);
  if (errors.length) parts.push(`${errors.length} unreadable`);
  setSyncSummary(actions.length ? parts.join('  ·  ') : `Already in sync — ${parts.join('  ·  ')}`);

  const frag = document.createDocumentFragment();
  for (const e of errors) frag.append(syncListItem('error', 'error', e.rel, e.message));
  for (const a of actions.slice(0, SYNC_LIST_LIMIT)) {
    const name = a.isDir ? a.rel + sep : a.rel;
    const meta = [a.isDir ? 'folder' : formatSize(a.size), a.targetNewer ? 'target is newer' : ''].filter(Boolean).join(', ');
    frag.append(syncListItem(a.type, SYNC_LABELS[a.type], name, meta));
  }
  if (actions.length > SYNC_LIST_LIMIT) {
    const more = document.createElement('li');
    more.className = 'more';
    more.textContent = `…and ${actions.length - SYNC_LIST_LIMIT} more`;
    frag.append(more);
  }
  syncPlanList.replaceChildren(frag);
}

async function runSync() {
  if (syncPlanId === null || syncRunning) return;
  syncRunning = true;
  setSyncInputsDisabled(true);
  syncRunBtn.disabled = true;
  syncProgress.hidden = false;
  syncProgressBar.value = 0;
  syncCurrent.textContent = '';
  const unsubscribe = api.onSyncProgress(({ done, total, current }) => {
    syncProgressBar.max = Math.max(1, total);
    syncProgressBar.value = done;
    syncCurrent.textContent = current ? `${done + 1}/${total}  ${current}` : '';
  });

  let result = null;
  try {
    result = await api.syncRun(syncPlanId);
  } catch (err) {
    setSyncSummary(cleanError(err), true);
  } finally {
    unsubscribe();
    syncRunning = false;
    syncPlanId = null;
  }

  if (result) {
    const ok = result.done - result.errors.length;
    const head = result.cancelled ? `Cancelled after ${result.done} of ${result.total} items` : `Synced ${ok} of ${result.total} items`;
    setSyncSummary(result.errors.length ? `${head} — ${result.errors.length} failed` : head, result.errors.length > 0);
    syncPlanList.replaceChildren(...result.errors.map((e) => syncListItem('error', 'error', e.rel, e.message)));
  }
  syncRunBtn.hidden = true;
  syncCancelBtn.textContent = 'Close';
  await Promise.all([panes.left.refresh(), panes.right.refresh()]);
}

syncRunBtn.addEventListener('click', runSync);
syncCancelBtn.addEventListener('click', () => {
  if (syncRunning) {
    api.syncCancel();
    syncCancelBtn.textContent = 'Cancelling…';
  } else {
    syncToken++; // drop any comparison still in flight
    syncEl.close();
  }
});
// Escape: cancel a running sync instead of hiding the dialog mid-way
syncEl.addEventListener('cancel', (e) => {
  if (syncRunning) {
    e.preventDefault();
    syncCancelBtn.click();
  } else {
    syncToken++;
  }
});
syncEl.addEventListener('close', () => {
  if (activePane) activePane.list.focus();
});
for (const r of syncRadios) r.addEventListener('change', compareSync);
syncDelete.addEventListener('change', compareSync);

// ---------- keyboard ----------

const FKEYS = { F2: 'rename', F3: 'open', F4: 'open', F5: 'copy', F6: 'move', F7: 'mkdir', F8: 'trash', Delete: 'trash' };

document.addEventListener('keydown', (e) => {
  if (document.querySelector('dialog[open]') || !activePane) return;
  if (e.target instanceof HTMLInputElement) return;
  const pane = activePane;
  const ctrl = e.ctrlKey || e.metaKey;

  if (e.key === 'ContextMenu' || (e.key === 'F10' && e.shiftKey)) {
    e.preventDefault();
    const entry = pane.view[pane.cursor];
    const pos = cursorMenuPosition(pane);
    if (!entry || entry.isParent) showFolderMenu(pane, pos);
    else showItemMenu(pane, entry, pos);
    return;
  }

  if (FKEYS[e.key] && !ctrl && !e.altKey) {
    e.preventDefault();
    runAction(FKEYS[e.key]);
    return;
  }

  if (ctrl) {
    const key = e.key.toLowerCase();
    const actions = {
      h: () => toggleHidden(),
      u: () => swapPanes(),
      m: () => runAction('mirror'),
      a: () => pane.selectAll(),
      r: () => pane.refresh(),
      d: () => addFavorite(pane),
      s: () => openSync(),
      l: () => {
        pane.pathInput.focus();
        pane.pathInput.select();
      },
      home: () => pane.navigate(homeDir),
    };
    if (actions[key]) {
      e.preventDefault();
      actions[key]();
    }
    return;
  }

  if (e.altKey) {
    if (e.key === 'ArrowLeft') pane.back();
    else if (e.key === 'ArrowRight') pane.forward();
    else if (e.key === 'ArrowUp') pane.goUp();
    else return;
    e.preventDefault();
    return;
  }

  switch (e.key) {
    case 'Tab':
      setActive(pane.other);
      break;
    case 'ArrowDown':
      if (e.shiftKey) {
        pane.toggleSelect(pane.cursor);
        pane.cursor = Math.min(pane.view.length - 1, pane.cursor + 1);
        pane.render();
      } else pane.setCursor(pane.cursor + 1);
      break;
    case 'ArrowUp':
      if (e.shiftKey) {
        pane.toggleSelect(pane.cursor);
        pane.cursor = Math.max(0, pane.cursor - 1);
        pane.render();
      } else pane.setCursor(pane.cursor - 1);
      break;
    case 'PageDown':
      pane.setCursor(pane.cursor + pane.pageSize());
      break;
    case 'PageUp':
      pane.setCursor(pane.cursor - pane.pageSize());
      break;
    case 'Home':
      pane.setCursor(0);
      break;
    case 'End':
      pane.setCursor(pane.view.length - 1);
      break;
    case 'Enter':
      pane.openEntry(pane.view[pane.cursor]);
      break;
    case 'Backspace':
      pane.goUp();
      break;
    case 'Insert':
    case ' ':
      pane.toggleSelect(pane.cursor);
      pane.cursor = Math.min(pane.view.length - 1, pane.cursor + 1);
      pane.render();
      break;
    case 'Escape':
      pane.clearSelection();
      break;
    case 'ArrowLeft':
    case 'ArrowRight':
      setActive(e.key === 'ArrowLeft' ? panes.left : panes.right);
      break;
    default:
      if (e.key.length === 1) pane.typeAhead(e.key);
      else return;
  }
  e.preventDefault();
});

document.querySelector('.keybar').addEventListener('click', (e) => {
  const btn = e.target.closest('button');
  if (btn && activePane) runAction(btn.dataset.action);
});

window.addEventListener('focus', () => {
  for (const pane of Object.values(panes)) pane.refresh();
});

// ---------- init ----------

(async function init() {
  let version;
  [sep, homeDir, version] = await Promise.all([api.sep(), api.home(), api.version()]);
  document.title = `SplitBeam ${version}`;
  const state = loadState();
  showHidden = !!state.showHidden;
  favorites = Array.isArray(state.favorites) ? state.favorites : await api.defaultFavorites();
  renderFavorites();

  panes.left = new Pane('left', document.getElementById('pane-left'));
  panes.right = new Pane('right', document.getElementById('pane-right'));

  await Promise.all(
    ['left', 'right'].map(async (side) => {
      const pane = panes[side];
      const saved = state[side] || {};
      if (saved.sort) pane.sort = saved.sort;
      if (!(saved.path && (await pane.load(saved.path)))) await pane.load(homeDir);
    })
  );

  setActive(panes[state.active] || panes.left);
})();
