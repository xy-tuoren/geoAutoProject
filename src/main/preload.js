const { contextBridge, ipcRenderer, webUtils } = require('electron')

contextBridge.exposeInMainWorld('automation', {
  defaultOutputDirectory: () => ipcRenderer.invoke('app:default-output-directory'),
  selectDirectory: () => ipcRenderer.invoke('dialog:select-directory'),
  selectQuestions: () => ipcRenderer.invoke('dialog:select-questions'),
  listDevices: () => ipcRenderer.invoke('automation:devices'),
  listEntries: () => ipcRenderer.invoke('automation:entries'),
  importQuestions: payload => ipcRenderer.invoke('questions:import', payload),
  getPathForFile: file => webUtils.getPathForFile(file),
  start: payload => ipcRenderer.invoke('automation:start', payload),
  retryFailed: payload => ipcRenderer.invoke('automation:retry-failed', payload),
  stop: () => ipcRenderer.invoke('automation:stop'),
  copyText: text => ipcRenderer.invoke('clipboard:write', text),
  exportLog: text => ipcRenderer.invoke('log:export', text),
  getUpdateState: () => ipcRenderer.invoke('update:state'),
  checkForUpdate: () => ipcRenderer.invoke('update:check'),
  downloadUpdate: () => ipcRenderer.invoke('update:download'),
  installUpdate: () => ipcRenderer.invoke('update:install'),
  onLog: callback => ipcRenderer.on('automation:log', (_event, text) => callback(text)),
  onFinished: callback => ipcRenderer.on('automation:finished', (_event, result) => callback(result)),
  onUpdateState: callback => ipcRenderer.on('update:state', (_event, value) => callback(value)),
})
