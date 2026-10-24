import { z } from "zod";
import type { Store } from "../store/store.js";
import type { SyncEngine, SyncOutcome, VerifyOutcome } from "../sync/engine.js";

/** What happened on one account after the entry left the list. */
export interface AccountUnblock {
  readonly accountId: string;
  /** The provider no longer has the rule: the sync applied (or had nothing to change) and the read-back agreed. */
  readonly confirmed: boolean;
  /** Safe to show: no password, no full server reply. */
  readonly detail: string;
}

export type UnblockResult =
  | { readonly status: "unknown" }
  | { readonly status: "unblocked"; readonly accounts: readonly AccountUnblock[] };

export interface UnblockDeps {
  readonly store: Pick<Store, "remove">;
  readonly engine: Pick<SyncEngine, "sync" | "verify">;
  /** Every account on this device: the list is global, so each one must drop the rule. */
  readonly accountIds: readonly string[];
}

const EntryIdSchema = z.uuid();

/** Whether a value coming from outside (a renderer) can be an entry id at all. */
export function isEntryId(value: unknown): value is string {
  return EntryIdSchema.safeParse(value).success;
}

function syncProblem(outcome: SyncOutcome): string | null {
  switch (outcome.status) {
    case "unchanged":
    case "applied":
      return null;
    case "partial":
      return `${String(outcome.failed)} change(s) failed`;
    case "failed":
      return `${outcome.code}: ${outcome.message}`;
  }
}

function verifyProblem(check: VerifyOutcome): string | null {
  switch (check.status) {
    case "verified":
      return null;
    case "drifted":
      return `read-back differs: ${check.detail}`;
    case "failed":
      return `read-back failed: ${check.code}`;
  }
}

async function dropOn(deps: UnblockDeps, accountId: string): Promise<AccountUnblock> {
  const problem = syncProblem(await deps.engine.sync(accountId));
  if (problem !== null)
    return { accountId, confirmed: false, detail: `rule not removed: ${problem}` };
  const unconfirmed = verifyProblem(await deps.engine.verify(accountId));
  if (unconfirmed !== null) return { accountId, confirmed: false, detail: unconfirmed };
  return { accountId, confirmed: true, detail: "read back from the provider" };
}

/**
 * Takes one entry off the block list and makes every account follow at once (not through the
 * debounce: a person who pressed Unblock expects mail to flow now). Accounts run in parallel, each
 * on its own lane, so one that hangs does not hold up the others. An id that is not on the list
 * returns `unknown` and touches no provider.
 */
export async function unblock(deps: UnblockDeps, entryId: string): Promise<UnblockResult> {
  if (!isEntryId(entryId) || !deps.store.remove(entryId)) return { status: "unknown" };
  const accounts = await Promise.all(deps.accountIds.map((id) => dropOn(deps, id)));
  return { status: "unblocked", accounts };
}
