const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("native", {
  on: (channel, cb) => ipcRenderer.on(channel, (_e, data) => cb(data)),
  close: () => ipcRenderer.send("app-close"),
  minimize: () => ipcRenderer.send("app-minimize"),
  maximize: () => ipcRenderer.send("app-maximize")
});
