const { contextBridge, ipcRenderer } = require("electron");
const subscribe = (channel, callback) => {
  const listener = (_event, payload) => callback(payload);
  ipcRenderer.on(channel, listener);
  return () => ipcRenderer.removeListener(channel, listener);
};
contextBridge.exposeInMainWorld("alpha", {
  snapshot: () => ipcRenderer.invoke("alpha:snapshot"),
  action: (type, payload) => ipcRenderer.invoke("alpha:action", type, payload),
  terminalInput: (id, data) => ipcRenderer.send("alpha:input", id, data),
  terminalResize: (id, cols, rows) =>
    ipcRenderer.send("alpha:resize", id, cols, rows),
  onState: (callback) => subscribe("alpha:state", callback),
  onTerminal: (callback) => subscribe("alpha:terminal", callback),
});
