const { app, BrowserWindow, ipcMain, shell, Menu, clipboard, dialog, net } = require('electron');
const path = require('path');
const fs = require('fs/promises');
const os = require('os');
const remote = require('./sftp');

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
    if (remote.isRemote(source) || remote.isRemote(target)) {
      throw new Error('Sync works between local folders only; network locations are not supported yet');
    }
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

// ---------- local / remote dispatch ----------

const nameOf = (p) => (remote.isRemote(p) ? remote.basename(p) : path.basename(p));
const joinAny = (dir, name) => (remote.isRemote(dir) ? remote.join(dir, name) : path.join(dir, name));
const existsAny = (p) => (remote.isRemote(p) ? remote.exists(p) : exists(p));
const removeAny = (p) => (remote.isRemote(p) ? remote.remove(p) : fs.rm(p, { recursive: true, force: true }));

function checkName(name) {
  if (!name || name.includes('/') || name.includes(path.sep) || name === '.' || name === '..') {
    throw new Error('Invalid name');
  }
}

/** Copies or moves `src` into `destDir`, between any combination of local and SFTP locations. */
async function transfer(src, destDir, isMove) {
  const dest = joinAny(destDir, nameOf(src));

  if (!remote.isRemote(src) && !remote.isRemote(dest)) {
    if (path.resolve(src) === path.resolve(dest)) {
      if (isMove) return;
      throw new Error('Source and destination are the same');
    }
    if (dest.startsWith(path.resolve(src) + path.sep)) {
      throw new Error(`Cannot ${isMove ? 'move' : 'copy'} a folder into itself`);
    }
    if (!isMove) return fs.cp(src, dest, { recursive: true, force: true, preserveTimestamps: true });
    if (await exists(dest)) await fs.rm(dest, { recursive: true, force: true });
    return move(src, dest);
  }

  if (src === dest) {
    if (isMove) return;
    throw new Error('Source and destination are the same');
  }
  if (isMove && remote.sameSession(src, dest)) return remote.moveWithin(src, dest);

  if (isMove && (await existsAny(dest))) await removeAny(dest);
  if (remote.isRemote(src) && remote.isRemote(dest)) await remote.copyRemote(src, dest);
  else if (remote.isRemote(dest)) await remote.upload(src, dest);
  else await remote.download(src, dest);
  if (isMove) await removeAny(src);
}

// ---------- update check ----------

// "owner/repo" from the homepage in package.json, e.g. https://github.com/cimaz/splitbeam
const GITHUB_REPO = require('../package.json').homepage.replace(/^https:\/\/github\.com\//, '').replace(/\/$/, '');

/** Compares "1.2.3" style versions (an optional leading "v" and "-prerelease" suffix are handled). */
function compareVersions(a, b) {
  const parse = (v) => {
    const [main, pre] = v.replace(/^v/, '').split('-', 2);
    return { nums: main.split('.').map((n) => parseInt(n, 10) || 0), pre: pre || '' };
  };
  const x = parse(a);
  const y = parse(b);
  for (let i = 0; i < Math.max(x.nums.length, y.nums.length); i++) {
    const d = (x.nums[i] || 0) - (y.nums[i] || 0);
    if (d) return Math.sign(d);
  }
  if (x.pre === y.pre) return 0;
  if (!x.pre) return 1; // 1.0.0 is newer than 1.0.0-beta
  if (!y.pre) return -1;
  return x.pre < y.pre ? -1 : 1;
}

/** The download that fits how this copy was installed: the AppImage, the .deb, or none (release page). */
function pickAsset(assets) {
  if (process.env.APPIMAGE) return assets.find((a) => a.name.endsWith('.AppImage'));
  if (app.isPackaged && process.platform === 'linux') return assets.find((a) => a.name.endsWith('.deb'));
  return null;
}

/** Asks GitHub for the latest published release. Resolves to null when offline or nothing is published. */
async function checkForUpdate() {
  try {
    const res = await net.fetch(`https://api.github.com/repos/${GITHUB_REPO}/releases/latest`, {
      headers: { Accept: 'application/vnd.github+json', 'User-Agent': `SplitBeam/${app.getVersion()}` },
    });
    if (!res.ok) return null; // 404 until the first release is published
    const release = await res.json();
    const latest = String(release.tag_name || '').replace(/^v/, '');
    if (!latest) return null;
    const asset = pickAsset(release.assets || []);
    return {
      current: app.getVersion(),
      latest,
      newer: compareVersions(latest, app.getVersion()) > 0,
      pageUrl: release.html_url,
      downloadUrl: asset ? asset.browser_download_url : release.html_url,
      assetName: asset ? asset.name : null,
    };
  } catch {
    return null;
  }
}

function registerSftpIpc() {
  ipcMain.handle('sftp:connect', (_e, profile, secret) => remote.connect(profile, secret));
  ipcMain.handle('sftp:disconnect', (_e, key) => remote.disconnect(key));
  ipcMain.handle('sftp:trustHost', (_e, id, fingerprint) => remote.trustHost(id, fingerprint));
  ipcMain.handle('sftp:connected', () => remote.connectedKeys());
}

function registerIpc() {
  registerSyncIpc();
  registerSftpIpc();
  ipcMain.handle('fs:list', (_e, dir) => {
    if (remote.isRemote(dir)) return remote.list(dir);
    if (dir === '~' || dir.startsWith('~/')) dir = path.join(os.homedir(), dir.slice(1));
    return listDir(path.resolve(dir));
  });
  ipcMain.handle('app:version', () => app.getVersion());
  ipcMain.handle('update:check', () => checkForUpdate());
  ipcMain.handle('update:open', (_e, url) => {
    // Only ever open this project's GitHub pages from the update bar
    if (!url.startsWith(`https://github.com/${GITHUB_REPO}/`)) throw new Error('Refusing to open an unexpected URL');
    return shell.openExternal(url);
  });
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
  ipcMain.handle('fs:join', (_e, dir, name) => joinAny(dir, name));
  ipcMain.handle('fs:exists', (_e, p) => existsAny(p));
  ipcMain.handle('fs:isDir', async (_e, p) => {
    if (remote.isRemote(p)) return remote.isDir(p);
    try {
      return (await fs.stat(p)).isDirectory();
    } catch {
      return false;
    }
  });

  ipcMain.handle('fs:copy', (_e, src, destDir) => transfer(src, destDir, false));
  ipcMain.handle('fs:move', (_e, src, destDir) => transfer(src, destDir, true));

  ipcMain.handle('fs:rename', async (_e, src, newName) => {
    checkName(newName);
    if (remote.isRemote(src)) return remote.rename(src, newName);
    const dest = path.join(path.dirname(src), newName);
    if (await exists(dest)) throw new Error(`"${newName}" already exists`);
    await fs.rename(src, dest);
  });

  ipcMain.handle('fs:mkdir', async (_e, dir, name) => {
    checkName(name);
    if (remote.isRemote(dir)) return remote.mkdir(dir, name);
    await fs.mkdir(path.join(dir, name));
  });

  // Local items go to the trash; remote ones are deleted permanently (servers have no trash)
  ipcMain.handle('fs:trash', (_e, p) => (remote.isRemote(p) ? remote.remove(p) : shell.trashItem(p)));

  ipcMain.handle('shell:open', async (_e, p) => {
    const local = remote.isRemote(p) ? await remote.downloadToTemp(p) : p;
    const err = await shell.openPath(local);
    if (err) throw new Error(err);
  });
  ipcMain.handle('shell:reveal', (_e, p) => {
    if (remote.isRemote(p)) throw new Error('Not available for network locations');
    shell.showItemInFolder(p);
  });
  ipcMain.handle('dialog:openFile', async (e, defaultPath) => {
    const { canceled, filePaths } = await dialog.showOpenDialog(BrowserWindow.fromWebContents(e.sender), {
      defaultPath: defaultPath && defaultPath.startsWith('~') ? path.join(os.homedir(), defaultPath.slice(1)) : defaultPath,
      properties: ['openFile', 'showHiddenFiles'],
    });
    return canceled ? null : filePaths[0];
  });
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
  remote.init(app.getPath('userData'), (key, connected) => {
    for (const win of BrowserWindow.getAllWindows()) win.webContents.send('sftp:status', { key, connected });
  });
  registerIpc();
  createWindow();
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('before-quit', () => {
  remote.endAll();
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
