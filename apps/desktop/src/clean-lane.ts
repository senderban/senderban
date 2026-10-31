import {
  AdapterError,
  SWEEP_ALL_GAP_MS,
  initialCleanState,
  type GapReason,
  type ImapCleanAdapter,
  type OpaqueState,
} from "@senderban/core";

/** What the engine gets for a cleaning lane: a gate of its own, so a slow search does not hold up clicks on other accounts. */
export function cleanLane(
  id: string,
  adapter: ImapCleanAdapter,
): {
  readonly id: string;
  readonly initialState: OpaqueState;
  readonly adapter: ImapCleanAdapter;
  readonly cleanGate: true;
} {
  return { id, initialState: initialCleanState(), adapter, cleanGate: true };
}

export interface CleanGapOptions {
  readonly sweepAll: ImapCleanAdapter["sweepAll"];
  readonly requestSync: () => void;
  readonly log: (fields: {
    readonly reason: GapReason;
    readonly failed: number;
    readonly error: string;
  }) => void;
  readonly now?: () => number;
}

/**
 * Mail went past a lane unseen: ask for a sweep, then for a round. A state that could not be saved leaves the request in memory, and
 * a round runs it only while the saved row parses; a row that does not parse fails that round, and its notice tells the person. The
 * failing save is logged once per sweep limit with a count: its gaps come at a sender's wish.
 */
export function cleanGapListener(options: CleanGapOptions): (reason: GapReason) => void {
  const now = options.now ?? Date.now;
  let failed = 0;
  let loggedAt = Number.NEGATIVE_INFINITY;
  return (reason) => {
    // Renumbering voids the saved pass. A burst or an unreadable mail repeats at a sender's wish, so those keep the hourly limit.
    try {
      options.sweepAll(reason === "renumbered");
    } catch (error) {
      failed += 1;
      if (now() - loggedAt >= SWEEP_ALL_GAP_MS) {
        const kind = error instanceof AdapterError ? error.code : "store";
        options.log({ reason, failed, error: kind });
        loggedAt = now();
        failed = 0;
      }
    }
    options.requestSync();
  };
}
