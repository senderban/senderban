// Sandboxed preload: the popup page gets exactly these calls and nothing else of Electron or Node.
const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("senderban", {
  init: () => ipcRenderer.invoke("popup:init"),
  onView: (callback) => {
    ipcRenderer.on("popup:view", (_event, view) => {
      callback(view);
    });
  },
  choose: (scope) => ipcRenderer.invoke("popup:choose", scope),
  hover: (value) => {
    ipcRenderer.send("popup:hover", value === true);
  },
  openSettings: () => {
    ipcRenderer.send("popup:open-settings");
  },
  close: () => {
    ipcRenderer.send("popup:close");
  },
});
