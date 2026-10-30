import type { BlockAction } from "@senderban/core";

/**
 * What the list can honestly say about the running lanes. It is built once per list read, so a list of 5,000 entries costs one read
 * of each MXroute lane's state, not 5,000.
 */
export interface LaneView {
  /** At least one lane writes folder rules (an IMAP account's Sieve lane). */
  readonly hasFolderLane: boolean;
  readonly folderBehind: boolean;
  readonly mxrouteBehind: boolean;
  readonly gmailBehind: boolean;
  /** Addresses a running MXroute lane holds; null when a lane's state could not be read. */
  readonly refused: ReadonlySet<string> | null;
}

/** Builds the view. A lane that failed and was removed since is not behind: nothing is left to wait for. */
export function laneViewOf(input: {
  readonly entries: readonly { readonly action: BlockAction }[];
  readonly running: readonly string[];
  readonly failed: Iterable<string>;
  readonly mxroute: ReadonlySet<string>;
  readonly gmail: ReadonlySet<string>;
  readonly refused: () => ReadonlySet<string> | null;
}): LaneView {
  const behind = [...input.failed].filter((id) => input.running.includes(id));
  const isFolderLane = (id: string) => !input.mxroute.has(id) && !input.gmail.has(id);
  return {
    hasFolderLane: input.running.some(isFolderLane),
    folderBehind: behind.some(isFolderLane),
    mxrouteBehind: behind.some((id) => input.mxroute.has(id)),
    gmailBehind: behind.some((id) => input.gmail.has(id)),
    refused: input.entries.some((e) => e.action === "reject") ? input.refused() : new Set(),
  };
}

export interface Applied {
  /** "unknown": a lane that should carry this entry failed its last sync, so the rule may be missing there. */
  readonly applied: "yes" | "no" | "unknown";
  /** True only when a running MXroute lane holds the address, which is what makes "refused at the server" true. */
  readonly atServer: boolean;
}

/** What one list entry really has behind it (never claim more than the last sync reported). */
export function appliedFor(
  entry: { readonly value: string; readonly action: BlockAction },
  own: boolean,
  gmail: "trash" | "no" | null,
  view: LaneView,
): Applied {
  if (own) return { applied: "no", atServer: false };
  const onGmail = gmail === "trash";
  const refusal = entry.action === "reject";
  const atServer = refusal && view.refused?.has(entry.value) === true;
  if (
    view.folderBehind ||
    (onGmail && view.gmailBehind) ||
    (refusal && (view.mxrouteBehind || view.refused === null))
  ) {
    return { applied: "unknown", atServer };
  }
  return { applied: view.hasFolderLane || onGmail ? "yes" : "no", atServer };
}
