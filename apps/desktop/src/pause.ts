import type { WatcherState } from "@senderban/core";

/** The part of an `AccountWatcher` a pause uses. */
export interface PausableWatcher {
  readonly current: WatcherState;
  stop(): Promise<void>;
  resume(): void;
}

/** The part of the Gmail watchers a pause uses. */
export interface PausableGmailWatchers {
  stop(): void;
  resume(): void;
}

export interface PauseResult {
  readonly watchers: number;
  /** IMAP accounts left alone because their password was refused. */
  readonly halted: number;
}

/**
 * Stops or resumes watching. Every state changes in one synchronous step and only the logouts are waited for, so a Resume that
 * arrives during a Pause finds every watcher already stopped and the later click decides the end state. A halted account stays
 * halted either way: only a sign-in or a restart may send a refused password again (ADR 0003).
 */
export async function applyPause(
  value: boolean,
  watchers: readonly PausableWatcher[],
  gmail: PausableGmailWatchers,
): Promise<PauseResult> {
  const result: PauseResult = {
    watchers: watchers.length,
    halted: watchers.filter((w) => w.current === "halted").length,
  };
  if (value) {
    gmail.stop();
    await Promise.allSettled(watchers.map((w) => w.stop()));
  } else {
    gmail.resume();
    for (const watcher of watchers) watcher.resume();
  }
  return result;
}
