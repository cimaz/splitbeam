const { app, BrowserWindow, ipcMain, shell, Menu } = require('electron');
const path = require('path');
const fs = require('fs/promises');
const os = require('os');

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

function registerIpc() {
  ipcMain.handle('fs:list', (_e, dir) => {
    if (dir === '~' || dir.startsWith('~/')) dir = path.join(os.homedir(), dir.slice(1));
    return listDir(path.resolve(dir));
  });
  ipcMain.handle('fs:home', () => os.homedir());
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
