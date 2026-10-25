import { domainToASCII } from "node:url";

// RFC 5321 §4.5.3.1: local part <= 64 octets, domain <= 255 octets, path <= 256 octets
// (254 for an address once the angle brackets are excluded). Unit: ASCII characters.
export const ADDRESS_LIMITS = {
  localMax: 64,
  domainMax: 253,
  labelMax: 63,
  totalMax: 254,
} as const;

export interface ParsedAddress {
  readonly local: string;
  readonly domain: string;
  /** `local@domain`, lowercased; the matching key. */
  readonly address: string;
}

export type ParseResult =
  | { readonly ok: true; readonly value: ParsedAddress }
  | { readonly ok: false; readonly reason: string };

const LOCAL_ATOM = /^[a-z0-9!#$%&'*+/=?^_`{|}~-]+(\.[a-z0-9!#$%&'*+/=?^_`{|}~-]+)*$/;
const LABEL = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?$/;

// Control characters, format characters (zero-width, soft hyphen, bidi marks) and any whitespace or
// separator. Inside an address they are rejected, never trimmed or folded away: IDNA mapping would
// silently delete them and the sender would read as a different, clean domain.
const HIDDEN_OR_SPACE = /[\p{Cc}\p{Cf}\p{Z}\s]/u;
const ASCII_ONLY = /^\p{ASCII}*$/u;

const fail = (reason: string): ParseResult => ({ ok: false, reason });

/**
 * True when a non-ASCII label would be shown as plain ASCII after IDNA mapping (math-bold or
 * full-width letters, a Kelvin sign, an ideographic dot...): the person would read `bank.com` for a
 * sender that is not. A real internationalised label stays punycode (`xn--...`), which the popup shows as is.
 */
function foldsToAscii(rawDomain: string): boolean {
  // IDNA turns these into a real label boundary, which would hide a fold inside the next label.
  if (/[\u3002\uFF0E\uFF61]/u.test(rawDomain)) return true;
  for (const label of rawDomain.split(".")) {
    if (ASCII_ONLY.test(label)) continue;
    if (!domainToASCII(label.toLowerCase()).startsWith("xn--")) return true;
  }
  return false;
}

/**
 * Parses a bare mailbox (`user@example.com`). Quoted local parts, comments, display names and
 * IP-literal domains are rejected on purpose: v0.1 only blocks addresses it can match exactly.
 * Matching is case-insensitive, so the local part is lowercased too.
 */
export function parseAddress(input: string): ParseResult {
  if (input.length === 0 || input.length > ADDRESS_LIMITS.totalMax * 2) {
    return fail("length out of range");
  }
  const trimmed = input.trim();
  if (HIDDEN_OR_SPACE.test(trimmed)) return fail("control, invisible or space character");
  const at = trimmed.lastIndexOf("@");
  if (at <= 0 || at === trimmed.length - 1 || trimmed.indexOf("@") !== at) {
    return fail("expected exactly one @ with text on both sides");
  }
  const rawLocal = trimmed.slice(0, at);
  const rawDomain = trimmed.slice(at + 1);
  // Checked before lowercasing: toLowerCase maps the Kelvin sign to a plain k.
  if (!ASCII_ONLY.test(rawLocal)) return fail("unsupported local part");
  if (foldsToAscii(rawDomain)) return fail("look-alike characters in the domain");
  const local = rawLocal.toLowerCase();
  const domain = domainToASCII(rawDomain.toLowerCase());

  if (local.length > ADDRESS_LIMITS.localMax) return fail("local part too long");
  if (!LOCAL_ATOM.test(local)) return fail("unsupported local part");

  const domainError = validateDomain(domain);
  if (domainError !== null) return fail(domainError);

  const address = `${local}@${domain}`;
  if (address.length > ADDRESS_LIMITS.totalMax) return fail("address too long");
  return { ok: true, value: { local, domain, address } };
}

/** Returns an error string, or null when `domain` (already ASCII/punycode, lowercase) is valid. */
export function validateDomain(domain: string): string | null {
  if (domain.length === 0 || domain.length > ADDRESS_LIMITS.domainMax) {
    return "domain length out of range";
  }
  const labels = domain.split(".");
  if (labels.length < 2) return "domain needs at least two labels";
  for (const label of labels) {
    if (label.length === 0 || label.length > ADDRESS_LIMITS.labelMax || !LABEL.test(label)) {
      return "invalid domain label";
    }
  }
  const tld = labels[labels.length - 1];
  if (tld !== undefined && /^[0-9]+$/.test(tld)) return "numeric top-level label";
  return null;
}
