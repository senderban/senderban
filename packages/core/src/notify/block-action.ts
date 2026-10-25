import { randomUUID } from "node:crypto";
import { validateDomain } from "../address.js";
import type { BlockAction, BlockEntry } from "../blocklist.js";
import { isCountrySuffix, isFreemail } from "../freemail.js";
import type { Store } from "../store/store.js";
import type { SyncEngine, SyncOutcome } from "../sync/engine.js";
import type { PendingBlocks } from "./pending.js";

/** What the person chose in the popup: this mailbox, or the sender's whole domain (subdomains included). */
export const BLOCK_SCOPES = ["address", "domain"] as const;
export type BlockScope = (typeof BLOCK_SCOPES)[number];

/**
 * The domain a popup may offer to block for this sender, or null when it must not (a freemail
 * provider, or a shape the block list would refuse). Hiding the button is only a courtesy: the list
 * enforces the same rule.
 */
export function blockableDomain(sender: string): string | null {
  const domain = sender.slice(sender.lastIndexOf("@") + 1);
  if (validateDomain(domain) !== null || isFreemail(domain) || isCountrySuffix(domain)) return null;
  return domain;
}

export interface BlockActionDeps {
  readonly pending: PendingBlocks;
  readonly store: Pick<Store, "add" | "list">;
  readonly engine: Pick<SyncEngine, "sync" | "requestSync" | "verify">;
  /** Every account on this device: the list is global, so each one must pick the new entry up. */
  readonly accountIds: readonly string[];
  readonly now?: () => Date;
  readonly newId?: () => string;
}

/** What a choice led to. `detail` is shown to the person, so it carries no password or full server reply. */
export type BlockResult =
  | { readonly status: "duplicate" }
  | { readonly status: "unknown" }
  /** The target is already blocked, or covered by a rule that wins; `action` is where its mail really goes. */
  | { readonly status: "already-blocked"; readonly target: string; readonly action: BlockAction }
  | { readonly status: "refused"; readonly detail: string }
  /** The rule was written; `verified` says whether reading it back from the provider confirmed it. */
  | {
      readonly status: "blocked";
      readonly target: string;
      readonly action: BlockAction;
      readonly verified: boolean;
      readonly detail: string;
    }
  | { readonly status: "not-applied"; readonly target: string; readonly detail: string };

/** True when `entry` would match mail from `sender` (an address) or from every sender of `domain`. */
function covers(entry: BlockEntry, match: "exactAddress" | "subdomains", value: string): boolean {
  if (entry.match === "exactAddress") return match === "exactAddress" && entry.value === value;
  const domain = match === "exactAddress" ? value.slice(value.lastIndexOf("@") + 1) : value;
  if (domain === entry.value) return true;
  return entry.match === "subdomains" && domain.endsWith(`.${entry.value}`);
}

function describeSync(outcome: SyncOutcome): string | null {
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

/**
 * A click in the popup: look the sender up by notification id, add the chosen entry to the list,
 * write the rule to the clicked account at once and to the others through the debounce, then read
 * the clicked account back. The id is consumed exactly once, so a double click blocks once.
 * `action` is where the mail goes: Junk (default) or Trash. Both keep the mail, so both are reversible.
 */
export async function blockPending(
  deps: BlockActionDeps,
  id: string,
  scope: BlockScope,
  action: BlockAction = "junk",
): Promise<BlockResult> {
  const claimed = deps.pending.consume(id);
  if (claimed.status !== "ok") return { status: claimed.status };

  const { accountId, sender } = claimed.block;
  const target = scope === "domain" ? blockableDomain(sender) : sender;
  if (target === null) {
    return { status: "refused", detail: "this domain cannot be blocked as a whole" };
  }

  const match = scope === "domain" ? "subdomains" : "exactAddress";
  // Junk rules are written first and each one stops, so Junk wins wherever both would match. Say so
  // instead of reporting a Trash rule that never fires.
  if (action === "trash") {
    const winner = deps.store.list().find((e) => e.action === "junk" && covers(e, match, target));
    if (winner !== undefined) {
      return { status: "already-blocked", target: winner.value, action: "junk" };
    }
  }

  const added = deps.store.add({
    id: (deps.newId ?? randomUUID)(),
    match,
    value: target,
    action,
    createdAt: (deps.now?.() ?? new Date()).toISOString(),
  });
  if (!added.ok) return { status: "refused", detail: added.reason };
  if (!added.added && added.entry.action !== action) {
    return { status: "already-blocked", target, action: added.entry.action };
  }

  const outcome = await deps.engine.sync(accountId);
  for (const other of deps.accountIds) if (other !== accountId) deps.engine.requestSync(other);

  const problem = describeSync(outcome);
  if (problem !== null) return { status: "not-applied", target, detail: problem };

  const check = await deps.engine.verify(accountId);
  switch (check.status) {
    case "verified":
      return {
        status: "blocked",
        target,
        action,
        verified: true,
        detail: "read back from the provider",
      };
    case "drifted":
      return {
        status: "blocked",
        target,
        action,
        verified: false,
        detail: `read-back differs: ${check.detail}`,
      };
    case "failed":
      return {
        status: "blocked",
        target,
        action,
        verified: false,
        detail: `rule written, read-back failed: ${check.code}`,
      };
  }
}
