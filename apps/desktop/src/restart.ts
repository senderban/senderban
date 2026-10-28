/** What `restartApp` needs from Electron and the log, so the order of the calls can be tested without Electron. */
export interface RestartDeps {
  /** True once the quit sequence has started (`before-quit` ran): a second request does nothing. */
  readonly isQuitting: () => boolean;
  readonly log: (event: "restart") => void;
  /** Frees the single-instance lock, so the new process does not find the old one still holding it and quit silently. */
  readonly releaseLock: () => void;
  /** Registers the start of a new process for when this one exits; it does not quit. */
  readonly relaunch: () => void;
  /** Starts the normal quit (`before-quit` runs the shutdown, then the process exits). */
  readonly quit: () => void;
}

/**
 * Quits the way the tray's Quit does, then starts Senderban again. A Gmail sign-in is picked up at start, so this is the
 * "Restart now" button under Gmail accounts. Returns false when a quit is already running.
 */
export function restartApp(deps: RestartDeps): boolean {
  if (deps.isQuitting()) return false;
  deps.log("restart");
  deps.releaseLock();
  deps.relaunch();
  deps.quit();
  return true;
}
