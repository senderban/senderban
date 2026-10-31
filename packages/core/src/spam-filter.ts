import { z } from "zod";
import type { BlockAction } from "./blocklist.js";
import { ACCOUNT_ID } from "./sync/engine.js";

// The spam filter of one mailbox (ADR 0017). The server moves mail at or over a limit, with Senderban closed too, so it costs one
// script write per change and nothing per mail. It moves one mail and blocks no sender: a From can be forged, so a score must never put
// a sender on the block list.

/**
 * The limits a person picks from: SpamAssassin points, whole numbers because a Sieve numeric comparison stops at the decimal point.
 * 5 is its default `required_score`, which its docs call quite aggressive; 8-10 is what they give an ISP; 15 is their floor for
 * deleting mail unseen. Below 5 is not offered: the server itself does not call that spam.
 */
export const SPAM_LIMITS = [5, 10, 15] as const;
export type SpamLimit = (typeof SPAM_LIMITS)[number];

/** `ask` writes no rule: the mail stays, and its notification says it is over the limit. */
export const SPAM_FILTER_ACTIONS = ["junk", "trash", "ask"] as const;

const SpamLimitSchema = z.union([z.literal(5), z.literal(10), z.literal(15)]);

export const SpamFilterSchema = z.strictObject({
  limit: SpamLimitSchema,
  action: z.enum(SPAM_FILTER_ACTIONS),
});
export type SpamFilter = z.infer<typeof SpamFilterSchema>;

/** What the page sends. Null turns the filter off. */
export const SpamFilterRequestSchema = z.strictObject({
  accountId: z.string().regex(ACCOUNT_ID),
  filter: SpamFilterSchema.nullable(),
});

/** What the mailbox's Sieve script holds: a filter that moves mail. */
export const SpamRuleSchema = z.strictObject({
  limit: SpamLimitSchema,
  action: z.enum(["junk", "trash"] satisfies BlockAction[]),
});
export type SpamRule = z.infer<typeof SpamRuleSchema>;

/** The rule a filter puts on the server, or null: `ask` and an unset filter put none. */
export function spamRule(filter: SpamFilter | null): SpamRule | null {
  if (filter === null || filter.action === "ask") return null;
  return { limit: filter.limit, action: filter.action };
}

/** True when this mail's notification should say it is over the limit. A high score picks no action: its From may be forged. */
export function overSpamLimit(filter: SpamFilter | null, score: number | null): boolean {
  return filter?.action === "ask" && score !== null && score >= filter.limit;
}
