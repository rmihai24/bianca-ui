const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('biancaAPI', {
  executeCommand: (command) => ipcRenderer.invoke('execute-command', command),
  speak: (text) => ipcRenderer.invoke('speak', text)
});
