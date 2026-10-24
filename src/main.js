const { app, BrowserWindow, ipcMain, shell, Menu, clipboard } = require('electron');
const path = require('path');
const fs = require('fs/promises');
const os = require('os');

if (process.argv.includes('--version')) {
  console.log(`${app.getName()} ${app.getVersion()}`);
  process.exit(0);
}

function createWindow() {
  const win = new BrowserWindow({
    width: 1280,
    height: 800,
    minWidth: 720,
    minHeight: 400,
    title: 'SplitBeam',
    backgroundColor: '#1e1f24',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  win.loadFile(path.join(__dirname, 'renderer', 'index.html'));
}

async function listDir(dir) {
  const dirents = await fs.readdir(dir, { withFileTypes: true });
  const entries = await Promise.all(
    dirents.map(async (d) => {
      const full = path.join(dir, d.name);
      let stat = null;
      try {
        stat = await fs.stat(full); // follows symlinks
      } catch {
        // broken symlink or permission denied
      }
      return {
        name: d.name,
        path: full,
        isDir: stat ? stat.isDirectory() : d.isDirectory(),
        isLink: d.isSymbolicLink(),
        size: stat ? stat.size : 0,
        mtime: stat ? stat.mtimeMs : 0,
        hidden: d.name.startsWith('.'),
      };
    })
  );
  return { path: dir, parent: path.dirname(dir) === dir ? null : path.dirname(dir), entries };
}

async function exists(p) {
  try {
    await fs.lstat(p);
    return true;
  } catch {
    return false;
  }
}

async function move(src, dest) {
  try {
    await fs.rename(src, dest);
  } catch (err) {
    if (err.code !== 'EXDEV') throw err;
    // Cross-device move: copy then remove
    await fs.cp(src, dest, { recursive: true, force: true, preserveTimestamps: true });
    await fs.rm(src, { recursive: true, force: true });
  }
}

// ---------- folder sync ----------

const syncPlans = new Map();
let syncPlanSeq = 0;
let activeSync = null;

function isInside(child, parent) {
  const rel = path.relative(parent, child);
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}

async function lstatOrNull(p) {
  try {
    return await fs.lstat(p);
  } catch {
    return null;
  }
}

/**
 * Compares `source` with `target` recursively and lists what a one-way sync would do:
 * new (missing in target), update (size or mtime differ), replace (file/folder/link type differs)
 * and, when `deleteExtra` is set, delete (only in target). Symlinks are compared, never followed.
 */
async function buildSyncPlan(source, target, deleteExtra) {
  const actions = [];
  const errors = [];
  let unchanged = 0;

  async function walk(rel) {
    const srcDir = path.join(source, rel);
    const dstDir = path.join(target, rel);
    let srcNames;
    try {
      srcNames = await fs.readdir(srcDir);
    } catch (err) {
      errors.push({ rel: rel || '.', message: err.message });
      return;
    }
    let dstNames = [];
    try {
      dstNames = await fs.readdir(dstDir);
    } catch {
      // target folder missing; everything below is new
    }
    const srcSet = new Set(srcNames);
    const dstSet = new Set(dstNames);

    for (const name of srcNames) {
      const r = path.join(rel, name);
      const s = await lstatOrNull(path.join(srcDir, name));
      if (!s) continue;
      const d = dstSet.has(name) ? await lstatOrNull(path.join(dstDir, name)) : null;
      const isDir = s.isDirectory();
      const size = isDir ? 0 : s.size;

      if (!d) {
        actions.push({ type: 'new', rel: r, isDir, size });
      } else if (isDir && d.isDirectory()) {
        await walk(r);
      } else if (isDir !== d.isDirectory() || s.isSymbolicLink() !== d.isSymbolicLink()) {
        actions.push({ type: 'replace', rel: r, isDir, size });
      } else if (s.isSymbolicLink()) {
        const [a, b] = await Promise.all([fs.readlink(path.join(srcDir, name)), fs.readlink(path.join(dstDir, name))]);
        if (a !== b) actions.push({ type: 'replace', rel: r, isDir: false, size });
        else unchanged++;
      } else if (s.size !== d.size || Math.abs(s.mtimeMs - d.mtimeMs) > 2000) {
        // 2s tolerance covers filesystems with coarse timestamps (FAT, some network shares)
        actions.push({ type: 'update', rel: r, isDir: false, size, targetNewer: d.mtimeMs > s.mtimeMs + 2000 });
      } else {
        unchanged++;
      }
    }

    if (deleteExtra) {
      for (const name of dstNames) {
        if (srcSet.has(name)) continue;
        const d = await lstatOrNull(path.join(dstDir, name));
        actions.push({ type: 'delete', rel: path.join(rel, name), isDir: !!d && d.isDirectory(), size: d && !d.isDirectory() ? d.size : 0 });
      }
    }
  }

  await walk('');
  return { actions, errors, unchanged };
}

async function runSyncAction(action, source, target) {
  const src = path.join(source, action.rel);
  const dst = path.join(target, action.rel);
  const copyOpts = { recursive: true, force: true, preserveTimestamps: true, verbatimSymlinks: true };
  switch (action.type) {
    case 'new':
      await fs.mkdir(path.dirname(dst), { recursive: true });
      await fs.cp(src, dst, copyOpts);
      break;
    case 'update':
      await fs.cp(src, dst, copyOpts);
      break;
    case 'replace':
      await fs.rm(dst, { recursive: true, force: true });
      await fs.cp(src, dst, copyOpts);
      break;
    case 'delete':
      await shell.trashItem(dst);
      break;
  }
}

function registerSyncIpc() {
  ipcMain.handle('sync:plan', async (_e, source, target, deleteExtra) => {
    source = path.resolve(source);
    target = path.resolve(target);
    if (isInside(target, source) || isInside(source, target)) {
      throw new Error('Source and target must be separate folders, and neither can be inside the other');
    }
    const plan = await buildSyncPlan(source, target, deleteExtra);
    const id = ++syncPlanSeq;
    syncPlans.clear(); // only the latest comparison can be run
    syncPlans.set(id, { source, target, actions: plan.actions });
    return { id, ...plan };
  });

  ipcMain.handle('sync:run', async (e, id) => {
    const plan = syncPlans.get(id);
    if (!plan) throw new Error('This comparison is out of date; compare again');
    syncPlans.delete(id);
    const job = { cancelled: false };
    activeSync = job;
    const errors = [];
    let done = 0;
    const total = plan.actions.length;
    try {
      for (const action of plan.actions) {
        if (job.cancelled) break;
        e.sender.send('sync:progress', { done, total, current: action.rel });
        try {
          await runSyncAction(action, plan.source, plan.target);
        } catch (err) {
          errors.push({ rel: action.rel, message: err.message });
        }
        done++;
      }
      e.sender.send('sync:progress', { done, total, current: '' });
    } finally {
      activeSync = null;
    }
    return { done, total, errors, cancelled: job.cancelled };
  });

  ipcMain.handle('sync:cancel', () => {
    if (activeSync) activeSync.cancelled = true;
  });
}

function registerIpc() {
  registerSyncIpc();
  ipcMain.handle('fs:list', (_e, dir) => {
    if (dir === '~' || dir.startsWith('~/')) dir = path.join(os.homedir(), dir.slice(1));
    return listDir(path.resolve(dir));
  });
  ipcMain.handle('app:version', () => app.getVersion());
  ipcMain.handle('fs:home', () => os.homedir());
  ipcMain.handle('fs:defaultFavorites', async () => {
    const candidates = [
      { name: 'Home', path: os.homedir() },
      { name: 'Desktop', path: app.getPath('desktop') },
      { name: 'Documents', path: app.getPath('documents') },
      { name: 'Downloads', path: app.getPath('downloads') },
    ];
    const present = await Promise.all(candidates.map((c) => exists(c.path)));
    return candidates.filter((_c, i) => present[i]);
  });
  ipcMain.handle('fs:sep', () => path.sep);
  ipcMain.handle('fs:join', (_e, ...parts) => path.join(...parts));
  ipcMain.handle('fs:exists', (_e, p) => exists(p));
  ipcMain.handle('fs:isDir', async (_e, p) => {
    try {
      return (await fs.stat(p)).isDirectory();
    } catch {
      return false;
    }
  });

  ipcMain.handle('fs:copy', async (_e, src, destDir) => {
    const dest = path.join(destDir, path.basename(src));
    if (path.resolve(src) === path.resolve(dest)) throw new Error('Source and destination are the same');
    if (dest.startsWith(path.resolve(src) + path.sep)) throw new Error('Cannot copy a folder into itself');
    await fs.cp(src, dest, { recursive: true, force: true, preserveTimestamps: true });
  });

  ipcMain.handle('fs:move', async (_e, src, destDir) => {
    const dest = path.join(destDir, path.basename(src));
    if (path.resolve(src) === path.resolve(dest)) return;
    if (dest.startsWith(path.resolve(src) + path.sep)) throw new Error('Cannot move a folder into itself');
    if (await exists(dest)) await fs.rm(dest, { recursive: true, force: true });
    await move(src, dest);
  });

  ipcMain.handle('fs:rename', async (_e, src, newName) => {
    if (!newName || newName.includes('/') || newName.includes(path.sep)) throw new Error('Invalid name');
    const dest = path.join(path.dirname(src), newName);
    if (await exists(dest)) throw new Error(`"${newName}" already exists`);
    await fs.rename(src, dest);
  });

  ipcMain.handle('fs:mkdir', async (_e, dir, name) => {
    if (!name || name.includes('/') || name.includes(path.sep)) throw new Error('Invalid name');
    await fs.mkdir(path.join(dir, name));
  });

  ipcMain.handle('fs:trash', (_e, p) => shell.trashItem(p));

  ipcMain.handle('shell:open', async (_e, p) => {
    const err = await shell.openPath(p);
    if (err) throw new Error(err);
  });
  ipcMain.handle('shell:reveal', (_e, p) => shell.showItemInFolder(p));
  ipcMain.handle('clipboard:writeText', (_e, text) => clipboard.writeText(text));

  // Shows a native context menu built from [{ id, label, enabled, accelerator } | { type: 'separator' }]
  // at the mouse (or at `pos` = { x, y }) and resolves with the chosen item's id, or null if dismissed.
  ipcMain.handle(
    'menu:popup',
    (e, items, pos) =>
      new Promise((resolve) => {
        const template = items.map((item) =>
          item.type === 'separator'
            ? { type: 'separator' }
            : {
                label: item.label,
                enabled: item.enabled !== false,
                accelerator: item.accelerator,
                registerAccelerator: false, // display only; the renderer handles the keys
                click: () => resolve(item.id),
              }
        );
        Menu.buildFromTemplate(template).popup({
          window: BrowserWindow.fromWebContents(e.sender),
          ...(pos && { x: Math.round(pos.x), y: Math.round(pos.y) }),
          // The close callback can fire before click on some platforms, so let click win
          callback: () => setTimeout(() => resolve(null), 100),
        });
      })
  );
}

app.whenReady().then(() => {
  Menu.setApplicationMenu(null);
  registerIpc();
  createWindow();
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
