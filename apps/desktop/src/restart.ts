/** A start with this flag was asked for from the open window, which opens again on Accounts. A bare flag: it carries no value to parse. */
export const REOPEN_MANAGE_ARG = "--reopen-manage";

/**
 * The arguments of the new process: this one's, with the reopen flag once when the window is open, and without it when the person
 * closed it. `argv[0]` is the executable, which `app.relaunch` adds itself (electronjs.org/docs/latest/api/app, `relaunch`, read
 * 2026-11-01).
 */
export function relaunchArgs(argv: readonly string[], reopen: boolean): string[] {
  const rest = argv.slice(1).filter((a) => a !== REOPEN_MANAGE_ARG);
  return reopen ? [...rest, REOPEN_MANAGE_ARG] : rest;
}

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
 * Quits the way the tray's Quit does, then starts Senderban again. An account added or signed in is picked up at start, so the
 * window calls this on its own after an add, and its restart bar calls it. Returns false when a quit is already running.
 */
export function restartApp(deps: RestartDeps): boolean {
  if (deps.isQuitting()) return false;
  deps.log("restart");
  deps.releaseLock();
  deps.relaunch();
  deps.quit();
  return true;
}
