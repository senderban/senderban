import { parseAddress } from "../address.js";

/**
 * Addresses in one Gmail filter, at most. Unit: addresses. A filter's `query` was accepted at 14,003 characters
 * (400 quoted addresses) and answered 500 at 28,003 (measured 2026-10-26, ADR 0009 "Measured live"); 50 addresses are
 * about 1.8 k characters, far below that wall, so a long query is never what trips a filter. PROVISIONAL until the
 * number of filters one account may hold is measured.
 */
export const GMAIL_ADDRESSES_PER_FILTER = 50;

/**
 * Local parts the Gmail lane writes. Narrower than `parseAddress` on purpose (ADR 0009 point 4, query encoding
 * contract 2): the filter's `query` is the Gmail search syntax, where a leading `-` excludes, `{ }` is OR and `*` is a
 * wildcard, so an address that starts or ends with a symbol, or holds `{ } * | ! # $ % & ' / = ? ^ ~` and the like, is
 * not handed to it. No such address is dropped silently: the lane reports it as not blocked on Gmail.
 */
const GMAIL_LOCAL_PART = /^[a-z0-9](?:[a-z0-9._+-]*[a-z0-9])?$/;

/**
 * True for a canonical address (the exact output of `parseAddress`) the Gmail lane may write. A domain that
 * `parseAddress` returns holds only letters, digits, hyphens and dots, so only the local part needs this check.
 */
export function isGmailMirrorable(address: string): boolean {
  const parsed = parseAddress(address);
  if (!parsed.ok || parsed.value.address !== address) return false;
  return GMAIL_LOCAL_PART.test(parsed.value.local);
}

/**
 * The `query` of one filter: `from:("a@x.com" OR "b@y.com")`. Every address is a double-quoted phrase, and a
 * mirrorable address holds no quote, space, parenthesis, brace, backslash or `*`, so a term cannot close its quote
 * and nothing in it is an operator (BLOCK-1, ADR 0009 query encoding contract 1). Throws, with a fixed text that does
 * not repeat the address, on an empty list, a list over the capacity, or an address the lane may not write: the caller
 * filters with `isGmailMirrorable` first, so a throw here is a bug and never a silently narrower filter.
 */
export function compileFromQuery(addresses: readonly string[]): string {
  if (addresses.length === 0) throw new RangeError("a Gmail filter needs at least one address");
  if (addresses.length > GMAIL_ADDRESSES_PER_FILTER) {
    throw new RangeError("a Gmail filter holds too many addresses");
  }
  for (const address of addresses) {
    if (!isGmailMirrorable(address)) throw new TypeError("address is not allowed in a Gmail query");
  }
  return `from:(${addresses.map((a) => `"${a}"`).join(" OR ")})`;
}
