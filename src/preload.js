'use strict';

const { contextBridge, ipcRenderer } = require('electron');

/**
 * The control window renders plain HTML with no Node access; everything it can
 * do is listed here. The 17track window gets no preload at all — it is just a
 * web page, driven from the main process.
 */
contextBridge.exposeInMainWorld('agent', {
  getConfig: () => ipcRenderer.invoke('config:get'),
  saveConfig: (patch) => ipcRenderer.invoke('config:save', patch),
  start: () => ipcRenderer.invoke('agent:start'),
  stop: () => ipcRenderer.invoke('agent:stop'),
  test: () => ipcRenderer.invoke('agent:test'),
  showBrowser: () => ipcRenderer.invoke('browser:show'),
  hmaMapping: () => ipcRenderer.invoke('hma:mapping'),
  hmaOpen: () => ipcRenderer.invoke('hma:open'),
  onLog: (handler) => ipcRenderer.on('agent:log', (_event, line) => handler(line)),
  onState: (handler) => ipcRenderer.on('agent:state', (_event, state) => handler(state)),
});
