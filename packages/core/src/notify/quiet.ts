import { z } from "zod";
import { ADDRESS_LIMITS, parseAddress, validateDomain } from "../address.js";
import { blockableDomain } from "./block-action.js";
import type { BlockScope, OwnMail } from "./block-action.js";
import type { PendingBlocks } from "./pending.js";

// "Don't ask again" (ADR 0016): senders the person does not want a notification for. It only keeps a toast from being shown. It moves no
// mail and writes no rule, so it needs no provider and no permission, and a forged From costs a notification, nothing else.
//
// Scale budget: unit = announced mail. One lookup per label of the sender's domain in a Set in memory, no I/O and no provider call. A
// click is one atomic write. QUIET_MAX bounds memory, the file and the page's list.

/** Entries on the list. A person adds these one click at a time, so this is years of clicks. Unit: entries. */
export const QUIET_MAX = 2_000;
/** Bound of one entry: the longest address we take. Unit: UTF-16 units. */
export const QUIET_ENTRY_MAX = ADDRESS_LIMITS.totalMax;
/** The value of the choice on a toast. Not a `BlockAction`: nothing happens to mail. */
export const QUIET_CHOICE = "quiet";

/** A validated lowercase address, or a domain. */
export const QuietEntrySchema = z
  .string()
  .min(1)
  .max(QUIET_ENTRY_MAX)
  .refine((value) =>
    value.includes("@")
      ? parseAddress(value).ok && value === value.toLowerCase()
      : validateDomain(value) === null,
  );

export const QuietFileSchema = z.strictObject({
  version: z.literal(1),
  entries: z.array(QuietEntrySchema).max(QUIET_MAX),
});

/** True when the list holds this address, its domain or a parent of its domain: a domain entry takes in subdomains, as a block does. */
export function isQuiet(sender: string, entries: ReadonlySet<string>): boolean {
  if (entries.has(sender)) return true;
  let domain = sender.slice(sender.lastIndexOf("@") + 1);
  for (;;) {
    if (entries.has(domain)) return true;
    const dot = domain.indexOf(".");
    if (dot === -1) return false;
    domain = domain.slice(dot + 1);
  }
}

export type QuietTarget =
  | { readonly status: "ok"; readonly value: string }
  /** The toast already ran, or its id is gone: `PendingBlocks` says which. */
  | { readonly status: "duplicate" | "unknown" }
  /** A domain that must not be offered (a provider's, or the person's own): the click is held to what a toast may show. */
  | { readonly status: "not-offered" };

/** What a click on a toast puts on the list. Goes through the pending table, as a block does: the id is the only link to a sender. */
export function quietTarget(
  pending: PendingBlocks,
  id: string,
  scope: BlockScope,
  own: OwnMail,
): QuietTarget {
  const claimed = pending.consume(id);
  if (claimed.status !== "ok") return { status: claimed.status };
  const { sender } = claimed.block;
  if (scope === "address") return { status: "ok", value: sender };
  const domain = blockableDomain(sender, own);
  return domain === null ? { status: "not-offered" } : { status: "ok", value: domain };
}
