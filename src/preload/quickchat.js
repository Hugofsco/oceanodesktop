'use strict';
// Bridges the quick-chat renderer to the main process (which does the actual Oceano I/O).
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('qc', {
  send: (text) => ipcRenderer.send('qc:send', text),
  stop: () => ipcRenderer.send('qc:stop'),
  openClient: () => ipcRenderer.send('open-client'),
  onAuth: (cb) => ipcRenderer.on('qc:auth', (_e, d) => cb(d)),
  onToken: (cb) => ipcRenderer.on('qc:token', (_e, t) => cb(t)),
  onEvent: (cb) => ipcRenderer.on('qc:event', (_e, ev) => cb(ev)),
  onDone: (cb) => ipcRenderer.on('qc:done', () => cb()),
  onError: (cb) => ipcRenderer.on('qc:error', (_e, d) => cb(d)),
});
