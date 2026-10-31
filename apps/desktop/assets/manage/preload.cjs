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
  cleanAdd: (input) => ipcRenderer.invoke("manage:clean-add", input),
  accountDetect: (address) => ipcRenderer.invoke("manage:account-detect", { address }),
  accountRemove: (accountId) => ipcRenderer.invoke("manage:account-remove", accountId),
  googleState: () => ipcRenderer.invoke("manage:google-state"),
  googleSaveClient: (input) => ipcRenderer.invoke("manage:google-save-client", input),
  googleSignIn: (request) => ipcRenderer.invoke("manage:google-sign-in", request),
  googleCancel: () => ipcRenderer.invoke("manage:google-cancel"),
  googleRemove: (accountId) => ipcRenderer.invoke("manage:google-remove", accountId),
  microsoftState: () => ipcRenderer.invoke("manage:microsoft-state"),
  microsoftSignIn: (request) => ipcRenderer.invoke("manage:microsoft-sign-in", request),
  microsoftRemove: (accountId) => ipcRenderer.invoke("manage:microsoft-remove", accountId),
  restart: () => ipcRenderer.invoke("manage:restart"),
  status: () => ipcRenderer.invoke("manage:status"),
  pause: (value) => ipcRenderer.invoke("manage:pause", value),
  saveSpamFilter: (request) => ipcRenderer.invoke("manage:spam-filter", request),
  quiet: () => ipcRenderer.invoke("manage:quiet"),
  quietRemove: (value) => ipcRenderer.invoke("manage:quiet-remove", value),
  settings: () => ipcRenderer.invoke("manage:settings"),
  saveSettings: (value) => ipcRenderer.invoke("manage:settings-save", value),
  /** The list changed behind the page's back (a popup blocked something): ask for it again. */
  onChanged: (callback) => {
    ipcRenderer.on("manage:changed", () => {
      callback();
    });
  },
  /** A watcher changed state: ask for the status again. */
  onStatus: (callback) => {
    ipcRenderer.on("manage:status-changed", () => {
      callback();
    });
  },
});
