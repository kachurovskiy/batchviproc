const {contextBridge, ipcRenderer} = require('electron');

contextBridge.exposeInMainWorld(
  "api", {
    ipcRendererOn: (name, param) => {
      ipcRenderer.on(name, param);
    },
    ipcRendererSend: (name, param) => {
      ipcRenderer.send(name, param);
    },
  });
