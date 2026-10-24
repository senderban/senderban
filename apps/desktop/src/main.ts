import { app } from "electron";

// Windows toast actions need an AppUserModelID and a Start Menu shortcut (Electron notifications
// tutorial). Placeholder id: confirm before the first installer ships.
const APP_USER_MODEL_ID = "com.senderban.desktop";

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.setAppUserModelId(APP_USER_MODEL_ID);

  // Tray app: no window yet, and closing the last window must not quit the process.
  app.on("window-all-closed", () => {
    // intentionally empty
  });

  void app.whenReady().then(() => {
    // Phase 5: tray, account watchers, notification with [Block sender] action.
  });
}
