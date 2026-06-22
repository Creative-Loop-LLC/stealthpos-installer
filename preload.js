const { contextBridge, ipcRenderer } = require("electron");

// Safe, minimal bridge between the renderer (renderer/app.js) and the privileged
// main process (main.js). The renderer never touches Node/Electron directly.
contextBridge.exposeInMainWorld("stealth", {
  detectFolder: () => ipcRenderer.invoke("detect-folder"),
  browseFolder: () => ipcRenderer.invoke("browse-folder"),
  apiLogin: (creds) => ipcRenderer.invoke("api-login", creds),
  apiSignup: (data) => ipcRenderer.invoke("api-signup", data),
  installEdge: (opts) => ipcRenderer.invoke("install-edge", opts),
  openDashboard: () => ipcRenderer.invoke("open-dashboard"),
  onInstallProgress: (cb) =>
    ipcRenderer.on("install-progress", (_event, data) => cb(data)),
});
