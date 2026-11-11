import type { ActivationRestore, PendingBlocks } from "@senderban/core";

/** Why a click's tail did or did not put its block back in the table; a fixed word for the log, never the input. */
export type RestoreOutcome =
  /** The click carried no verified tail (a warm toast, an older toast, no key on this machine). */
  | "none"
  /** The tail names an account this run no longer has. */
  | "no-account"
  /** The table refused it: an id it holds, a time after this run began, or older than the TTL. */
  | "refused"
  | "restored";

/**
 * A click on a toast that an earlier run announced: the button carries the sender and the account (see `PendingBlocks.restore`), and
 * `parseActivation` only hands the tail over when its signature held. Only for an account that is still in `accountIds`, the list the
 * removal paths splice: the engine keeps a lane until the restart, so it would still say yes for an account the person removed.
 */
export function restoreClicked(
  pending: PendingBlocks,
  accountIds: readonly string[],
  id: string,
  restore: ActivationRestore | undefined,
): RestoreOutcome {
  if (restore === undefined) return "none";
  if (!accountIds.includes(restore.accountId)) return "no-account";
  const taken = pending.restore(
    id,
    { accountId: restore.accountId, sender: restore.sender },
    restore.issuedAt * 1000,
  );
  return taken ? "restored" : "refused";
}
