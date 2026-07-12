const { contextBridge, ipcRenderer } = require('electron')

contextBridge.exposeInMainWorld('automation', {
  defaultOutputDirectory: () => ipcRenderer.invoke('app:default-output-directory'),
  selectDirectory: () => ipcRenderer.invoke('dialog:select-directory'),
  selectQuestions: () => ipcRenderer.invoke('dialog:select-questions'),
  listDevices: () => ipcRenderer.invoke('automation:devices'),
  importQuestions: payload => ipcRenderer.invoke('questions:import', payload),
  start: payload => ipcRenderer.invoke('automation:start', payload),
  stop: () => ipcRenderer.invoke('automation:stop'),
  onLog: callback => ipcRenderer.on('automation:log', (_event, text) => callback(text)),
  onFinished: callback => ipcRenderer.on('automation:finished', (_event, result) => callback(result)),
})
