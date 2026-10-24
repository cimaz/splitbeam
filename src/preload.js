const { contextBridge, ipcRenderer } = require('electron');

const invoke = (channel) => (...args) => ipcRenderer.invoke(channel, ...args);

contextBridge.exposeInMainWorld('api', {
  list: invoke('fs:list'),
  version: invoke('app:version'),
  home: invoke('fs:home'),
  defaultFavorites: invoke('fs:defaultFavorites'),
  sep: invoke('fs:sep'),
  join: invoke('fs:join'),
  exists: invoke('fs:exists'),
  isDir: invoke('fs:isDir'),
  copy: invoke('fs:copy'),
  move: invoke('fs:move'),
  rename: invoke('fs:rename'),
  mkdir: invoke('fs:mkdir'),
  trash: invoke('fs:trash'),
  open: invoke('shell:open'),
  reveal: invoke('shell:reveal'),
  copyText: invoke('clipboard:writeText'),
  popupMenu: invoke('menu:popup'),
  pickFile: invoke('dialog:openFile'),
  sftpConnect: invoke('sftp:connect'),
  sftpDisconnect: invoke('sftp:disconnect'),
  sftpTrustHost: invoke('sftp:trustHost'),
  sftpConnected: invoke('sftp:connected'),
  onSftpStatus: (callback) => {
    const listener = (_e, status) => callback(status);
    ipcRenderer.on('sftp:status', listener);
    return () => ipcRenderer.removeListener('sftp:status', listener);
  },
  syncPlan: invoke('sync:plan'),
  syncRun: invoke('sync:run'),
  syncCancel: invoke('sync:cancel'),
  onSyncProgress: (callback) => {
    const listener = (_e, progress) => callback(progress);
    ipcRenderer.on('sync:progress', listener);
    return () => ipcRenderer.removeListener('sync:progress', listener);
  },
});
