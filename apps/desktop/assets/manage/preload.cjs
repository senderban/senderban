// Sandboxed preload: the manage page gets exactly these calls and nothing else of Electron or Node.
const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("senderban", {
  init: () => ipcRenderer.invoke("manage:init"),
  unblock: (id) => ipcRenderer.invoke("manage:unblock", id),
  saveSeconds: (seconds) => ipcRenderer.invoke("manage:save-seconds", seconds),
  /** The list changed behind the page's back (a popup blocked something): ask for it again. */
  onChanged: (callback) => {
    ipcRenderer.on("manage:changed", () => {
      callback();
    });
  },
});
