const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("stealth", {
  detectFolder:    ()       => ipcRenderer.invoke("detect-folder"),
  onDetectProgress: (cb)    =>
    ipcRenderer.on("detect-progress", (_event, msg) => cb(msg)),
  browseFolder:    ()       => ipcRenderer.invoke("browse-folder"),
  lookupEmail:     (data)   => ipcRenderer.invoke("lookup-email", data),
  apiLogin:        (creds)  => ipcRenderer.invoke("api-login", creds),
  apiSignup:       (data)   => ipcRenderer.invoke("api-signup", data),
  installEdge:     (opts)   => ipcRenderer.invoke("install-edge", opts),
  openDashboard:   ()       => ipcRenderer.invoke("open-dashboard"),
  onInstallProgress: (cb)   =>
    ipcRenderer.on("install-progress", (_event, data) => cb(data)),
});
