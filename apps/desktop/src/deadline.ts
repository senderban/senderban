/**
 * How long a quit waits for the IMAP sessions to log out. imapflow bounds a dead socket at 300 s (SOCKET_TIMEOUT),
 * so with the network down a quit or a "Restart now" would hang for minutes. 4 s covers a normal LOGOUT round trip
 * (well under 1 s) with room for a slow link; the process exit closes whatever is left.
 */
export const SHUTDOWN_DEADLINE_MS = 4_000;

/** Waits for `work`, but no longer than `ms`. Never rejects; the timer is always cleared. */
export async function settleWithin(
  work: Promise<unknown>,
  ms: number,
): Promise<"done" | "timeout"> {
  let timer: NodeJS.Timeout | undefined;
  const expired = new Promise<"timeout">((resolve) => {
    timer = setTimeout(() => {
      resolve("timeout");
    }, ms);
  });
  try {
    return await Promise.race([
      work.then(
        () => "done" as const,
        () => "done" as const,
      ),
      expired,
    ]);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * The whole quit, start to `app.exit`: the IMAP leg has `SHUTDOWN_DEADLINE_MS`, and this cap also covers the wait for a
 * start that is still running (`engine.recover()` with the network down), which has no deadline of its own.
 */
export const SHUTDOWN_CAP_MS = SHUTDOWN_DEADLINE_MS + 2_000;

export interface StopThenCloseDeps {
  /** Logs out the IMAP sessions; may hang on a dead socket. */
  readonly stop: () => Promise<unknown>;
  readonly closeStore: () => void;
  readonly log: (event: "quit-deadline", fields: { ms: number }) => void;
  readonly ms: number;
}

/** Stops the sessions for at most `ms`, then closes the store either way; a session still open is cut by the process exit. */
export async function stopThenClose(deps: StopThenCloseDeps): Promise<void> {
  const stopped = await settleWithin(deps.stop(), deps.ms);
  if (stopped === "timeout") deps.log("quit-deadline", { ms: deps.ms });
  deps.closeStore();
}
