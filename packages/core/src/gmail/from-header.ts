import { parseAddress } from "../address.js";

/**
 * Longest `From` header value the parser reads. Unit: characters (UTF-16 code units, what `String.length` counts). RFC 5322
 * §2.1.1 caps a line at 998 characters; a longer value is padding or an attack, and bounding it bounds the scan below.
 */
export const FROM_HEADER_MAX_CHARS = 998;

/** The one fixed word logged and returned when the sender cannot be read; never a part of the header itself. */
export const FROM_UNPARSABLE = "from-unparsable" as const;

export type FromResult =
  | { readonly ok: true; readonly address: string }
  | { readonly ok: false; readonly reason: typeof FROM_UNPARSABLE };

const UNPARSABLE: FromResult = { ok: false, reason: FROM_UNPARSABLE };

/** One header as the Gmail API returns it (`payload.headers[]`). */
export interface RawHeader {
  readonly name: string;
  readonly value: string;
}

// RFC 5322 §2.2.3 unfolding: CRLF directly before whitespace is not part of the value.
const FOLD = /\r?\n(?=[ \t])/gu;
const CONTROL = /\p{Cc}/u;

/**
 * The sender address of a Gmail message, from the raw `From` header text (ADR 0009 point 5, security review FLAG-1).
 *
 * Exactly one `From` header holding exactly one mailbox is accepted: `addr`, `<addr>` or `Name <addr>` / `"Name" <addr>`.
 * The address is the one inside the angle brackets (or the whole value when there are none), then `parseAddress`. The
 * display name is read only to find where it ends, never as an address: `"boss@co.com" <x@spam.example>` is
 * `x@spam.example`. Two headers, a list (`,`), a group (`:` `;`), a comment (`(`), a backslash outside quotes, unbalanced quotes or brackets, text after
 * the `>` and any control character are not read: a wrong sender here would put a Block button on someone else's address.
 */
export function parseFromHeaders(headers: readonly RawHeader[]): FromResult {
  let value: string | undefined;
  for (const header of headers) {
    if (header.name.toLowerCase() !== "from") continue;
    if (value !== undefined) return UNPARSABLE;
    value = header.value;
  }
  if (value === undefined) return UNPARSABLE;
  return parseFromValue(value);
}

export function parseFromValue(raw: string): FromResult {
  if (raw.length > FROM_HEADER_MAX_CHARS) return UNPARSABLE;
  const text = raw.replace(FOLD, " ");
  if (CONTROL.test(text)) return UNPARSABLE;

  let inQuote = false;
  let open = -1;
  let close = -1;
  for (let i = 0; i < text.length; i += 1) {
    const c = text[i];
    if (c === "\\" && !inQuote) {
      // Outside a quoted string a backslash is nothing a current mailbox contains (RFC 5322 allows it only as obsolete
      // quoted-pair syntax); a reader that takes `\<` as an escape would see a different address than we do.
      return UNPARSABLE;
    }
    if (inQuote) {
      if (c === "\\") i += 1;
      else if (c === '"') inQuote = false;
      continue;
    }
    if (c === '"') {
      // A quote inside the angle brackets is not an addr-spec.
      if (open !== -1 && close === -1) return UNPARSABLE;
      inQuote = true;
    } else if (c === "<") {
      if (open !== -1) return UNPARSABLE;
      open = i;
    } else if (c === ">") {
      if (open === -1 || close !== -1) return UNPARSABLE;
      close = i;
    } else if (c === "," || c === ";" || c === "(" || c === ")") {
      return UNPARSABLE;
    } else if (c === ":" && (open === -1 || close !== -1)) {
      // `:` is legal nowhere in a mailbox outside the brackets, and inside them it is not an addr-spec.
      return UNPARSABLE;
    }
  }
  if (inQuote) return UNPARSABLE;
  if ((open === -1) !== (close === -1)) return UNPARSABLE;

  let spec: string;
  if (open === -1) {
    spec = text.trim();
  } else {
    if (text.slice(close + 1).trim() !== "") return UNPARSABLE;
    spec = text.slice(open + 1, close);
  }
  // No space inside the addr-spec itself (`parseAddress` rejects it too; this keeps "a b@x" from being trimmed into a match).
  if (spec === "" || /\s/u.test(spec)) return UNPARSABLE;

  const parsed = parseAddress(spec);
  return parsed.ok ? { ok: true, address: parsed.value.address } : UNPARSABLE;
}
