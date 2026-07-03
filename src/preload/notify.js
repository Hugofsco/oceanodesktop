'use strict';
// Bridges the notifications renderer to main. Renderer owns display + timing; main owns the window.
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('notif', {
  onAdd: (cb) => ipcRenderer.on('notify:add', (_e, item) => cb(item)),
  dismiss: (id) => ipcRenderer.send('notify:dismiss', id),   // drop from main's backing list
  action: (id) => ipcRenderer.send('notify:action', id),     // click → open the full client
  resize: (h) => ipcRenderer.send('notify:resize', h),       // tell main the content height
});
