const { contextBridge, ipcRenderer } = require('electron');

const invoke = (channel) => (...args) => ipcRenderer.invoke(channel, ...args);

contextBridge.exposeInMainWorld('api', {
  list: invoke('fs:list'),
  home: invoke('fs:home'),
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
});
