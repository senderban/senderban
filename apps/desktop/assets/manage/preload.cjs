// Sandboxed preload: the manage page gets exactly these calls and nothing else of Electron or Node.
const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("senderban", {
  init: () => ipcRenderer.invoke("manage:init"),
  unblock: (id) => ipcRenderer.invoke("manage:unblock", id),
  mxrouteList: () => ipcRenderer.invoke("manage:mxroute-list"),
  mxrouteSave: (input) => ipcRenderer.invoke("manage:mxroute-save", input),
  mxrouteRemove: (key) => ipcRenderer.invoke("manage:mxroute-remove", key),
  mxrouteEnable: (input) => ipcRenderer.invoke("manage:mxroute-enable", input),
  accountAdd: (input) => ipcRenderer.invoke("manage:account-add", input),
  accountRemove: (accountId) => ipcRenderer.invoke("manage:account-remove", accountId),
  googleState: () => ipcRenderer.invoke("manage:google-state"),
  googleSaveClient: (input) => ipcRenderer.invoke("manage:google-save-client", input),
  googleSignIn: (request) => ipcRenderer.invoke("manage:google-sign-in", request),
  googleCancel: () => ipcRenderer.invoke("manage:google-cancel"),
  googleRemove: (accountId) => ipcRenderer.invoke("manage:google-remove", accountId),
  restart: () => ipcRenderer.invoke("manage:restart"),
  /** The list changed behind the page's back (a popup blocked something): ask for it again. */
  onChanged: (callback) => {
    ipcRenderer.on("manage:changed", () => {
      callback();
    });
  },
});
