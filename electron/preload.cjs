'use strict';

const { contextBridge } = require('electron');

// Keep the renderer sandboxed; expose only inert metadata for now.
contextBridge.exposeInMainWorld('desktop', {
  versions: {
    electron: process.versions.electron,
    chrome: process.versions.chrome,
    node: process.versions.node,
  },
});
