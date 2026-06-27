const { contextBridge, ipcRenderer } = require('electron');

const subscriptions = {
  log: 'proc-log',
  state: 'proc-state',
};

function subscribe(channelName, callback) {
  const channel = subscriptions[channelName];

  if (!channel || typeof callback !== 'function') {
    return () => {};
  }

  const listener = (event, message) => callback(message);
  ipcRenderer.on(channel, listener);

  return () => {
    ipcRenderer.removeListener(channel, listener);
  };
}

contextBridge.exposeInMainWorld('api', {
  selectFolder: () => ipcRenderer.invoke('proc-pick-dir'),
  start: (options) => ipcRenderer.invoke('proc-start', options),
  stop: () => ipcRenderer.invoke('proc-stop'),
  clearProcessedHistory: () => ipcRenderer.invoke('proc-clear-history'),
  getState: () => ipcRenderer.invoke('proc-get-state'),
  onLog: (callback) => subscribe('log', callback),
  onState: (callback) => subscribe('state', callback),
});
