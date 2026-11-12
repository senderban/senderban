import { z } from "zod";
import { ADDRESS_LIMITS, parseAddress, validateDomain } from "./address.js";
import { isCountrySuffix, isFreemail } from "./freemail.js";

/** `exactAddress` = one mailbox; `exactDomain` = that domain only; `subdomains` = domain and everything under it. */
export const MATCH_KINDS = ["exactAddress", "exactDomain", "subdomains"] as const;
export type MatchKind = (typeof MATCH_KINDS)[number];

/**
 * Junk and Trash keep the mail, so they are reversible (architecture K7: no permanent delete / discard).
 * `reject` is the ONE exception, decided in ADR 0008: the sender is put on the provider's server-side blacklist
 * (MXroute) and the mail is refused at the door (the sender gets a 550) and kept nowhere, until Unblock. The
 * Sieve lane keeps a Junk rule for it as the backup when the server lets a message through. It is never the
 * default, only single addresses, and never an address on the person's own mail domains.
 */
export const ACTIONS = ["junk", "trash", "reject"] as const;
export type BlockAction = (typeof ACTIONS)[number];

/** The folder a Sieve rule files the mail into: `reject` is Junk there, so the backup is always reversible. */
export function folderAction(action: BlockAction): "junk" | "trash" {
  return action === "trash" ? "trash" : "junk";
}

// PROVISIONAL bound (entries): replaced by a measured value once the Gmail filter length loop (G1)
// and the Sieve script size check (S4) have run.
export const MAX_ENTRIES = 5000;

/**
 * The clicked mailbox's name, as the app labels it: an address with a provider tag, `me@example.com (Outlook)`. Unit: Unicode code
 * points, the unit SQLite's length() counts (SQLite core functions, "length"), so the column's CHECK (db.ts) holds the same
 * numbers: an address (254) plus the longest tag, " (MXroute)" or " (Outlook)" (10), within 16.
 */
export const SOURCE_MIN = 3;
export const SOURCE_MAX = ADDRESS_LIMITS.totalMax + 16;
const codePoints = (value: string): number => Array.from(value).length;
/** No control or format characters (bidi): it is drawn as text. The UTF-16 cap first bounds the work of counting. */
export const SourceSchema = z
  .string()
  .max(SOURCE_MAX * 2)
  .regex(/^[^\p{Cc}\p{Cf}]+$/u)
  .refine((value) => codePoints(value) >= SOURCE_MIN && codePoints(value) <= SOURCE_MAX);

export const BlockEntrySchema = z.strictObject({
  id: z.uuid(),
  match: z.enum(MATCH_KINDS),
  value: z.string().min(3).max(ADDRESS_LIMITS.totalMax),
  action: z.enum(ACTIONS),
  createdAt: z.iso.datetime(),
  /** Shown on the list only. Absent on entries made before 0.3. */
  source: SourceSchema.optional(),
});
export type BlockEntry = z.infer<typeof BlockEntrySchema>;

export const BlocklistSchema = z.array(BlockEntrySchema).max(MAX_ENTRIES);
export type Blocklist = z.infer<typeof BlocklistSchema>;

export type EntryCheck =
  | { readonly ok: true; readonly entry: BlockEntry }
  | { readonly ok: false; readonly reason: string };

/** Schema check plus the semantic rules: value shape matches `match`, domains pass the freemail guard, value is normalised. */
export function checkEntry(input: unknown): EntryCheck {
  const parsed = BlockEntrySchema.safeParse(input);
  if (!parsed.success) return { ok: false, reason: "schema validation failed" };
  const entry = parsed.data;

  if (entry.match === "exactAddress") {
    const address = parseAddress(entry.value);
    if (!address.ok) return { ok: false, reason: address.reason };
    return { ok: true, entry: { ...entry, value: address.value.address } };
  }

  const domain = entry.value.toLowerCase();
  const domainError = validateDomain(domain);
  if (domainError !== null) return { ok: false, reason: domainError };
  if (isFreemail(domain))
    return { ok: false, reason: "freemail domains cannot be blocked as a domain" };
  if (isCountrySuffix(domain))
    return { ok: false, reason: "a country public suffix cannot be blocked as a domain" };
  return { ok: true, entry: { ...entry, value: domain } };
}
