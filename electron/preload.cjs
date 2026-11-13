'use strict';

const { contextBridge, ipcRenderer } = require('electron');

// Keep the renderer sandboxed; expose only inert metadata and a native
// folder/file picker for the setup screen's tick data path.
contextBridge.exposeInMainWorld('desktop', {
  versions: {
    electron: process.versions.electron,
    chrome: process.versions.chrome,
    node: process.versions.node,
  },
  pickTickData: (currentPath) => ipcRenderer.invoke('bt:pick-tick-data', currentPath),
});
