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

/** The window as a restarted process opens it. */
export interface ReopenTarget {
  showAfterRestart(): void;
  show(): void;
}

/**
 * A start asked for from the open window opens it again once start settles, so the page reads the accounts it is about to show. Only
 * a start that worked says "Senderban restarted"; a failed one opens the window without it. Nothing opens before start settles.
 */
export function reopenAfterStart(
  argv: readonly string[],
  started: Promise<unknown>,
  target: () => ReopenTarget | null,
): void {
  if (!argv.includes(REOPEN_MANAGE_ARG)) return;
  started.then(
    () => target()?.showAfterRestart(),
    () => target()?.show(),
  );
}

/** Who asked for a restart and, for `auto`, the time since the add that armed the timer (unit: milliseconds; `bar` is 0). */
export interface RestartWhy {
  readonly by: "auto" | "bar";
  readonly waitedMs: number;
}

/** Why a restart after an add did not happen: watching was paused, or a step outlasted the wait. The restart bar stays. */
export type NoRestart = "paused" | "busy-timeout";

/** What `restartApp` needs from Electron and the log, so the order of the calls can be tested without Electron. */
export interface RestartDeps {
  /** True once the quit sequence has started (`before-quit` ran): a second request does nothing. */
  readonly isQuitting: () => boolean;
  readonly log: (event: "restart", fields: RestartWhy) => void;
  /** Frees the single-instance lock, so the new process does not find the old one still holding it and quit silently. */
  readonly releaseLock: () => void;
  /** Whether the window is open now: read before the quit closes it, so the new process knows to open it again. */
  readonly isOpen: () => boolean;
  /** Registers the start of a new process for when this one exits, with the window flag; it does not quit. */
  readonly relaunch: (reopen: boolean) => void;
  /** Starts the normal quit (`before-quit` runs the shutdown, then the process exits). */
  readonly quit: () => void;
}

/**
 * Quits the way the tray's Quit does, then starts Senderban again. An account added or signed in is picked up at start, so the
 * window calls this on its own after an add, and its restart bar calls it. Returns false when a quit is already running.
 */
export function restartApp(deps: RestartDeps, why: RestartWhy): boolean {
  if (deps.isQuitting()) return false;
  deps.log("restart", why);
  deps.releaseLock();
  deps.relaunch(deps.isOpen());
  deps.quit();
  return true;
}
