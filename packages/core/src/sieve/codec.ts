import { AdapterError } from "../adapter.js";

/**
 * ManageSieve server responses (RFC 5804 §4). Pure parsing over bytes so it can be tested without
 * a socket; the transport lives in managesieve.ts.
 */

// PROVISIONAL bound (bytes): one response, so one script plus its framing. RFC 5804 caps a quoted
// string at 1024 octets but not a literal; replaced by the measured server script limit (S4).
export const MAX_RESPONSE_BYTES = 4 * 1024 * 1024;

export type Token =
  | { readonly kind: "string"; readonly value: string }
  | { readonly kind: "atom"; readonly value: string };

export type Status = "OK" | "NO" | "BYE";

export interface Response {
  readonly status: Status;
  /** Response code without parentheses, e.g. `QUOTA/MAXSIZE`; null when absent. */
  readonly code: string | null;
  readonly text: string | null;
  /** Data lines that came before the status line (capabilities, script names, script body). */
  readonly data: readonly (readonly Token[])[];
}

export interface Parsed {
  readonly response: Response;
  readonly consumed: number;
}

const CR = 0x0d;
const LF = 0x0a;
const SP = 0x20;
const DQUOTE = 0x22;
const BACKSLASH = 0x5c;
const LBRACE = 0x7b;
const RBRACE = 0x7d;
const LPAREN = 0x28;
const RPAREN = 0x29;
const PLUS = 0x2b;
const ZERO = 0x30;
const NINE = 0x39;

const protocolError = (detail: string): AdapterError =>
  new AdapterError("TRANSIENT", `ManageSieve protocol error: ${detail}`);

interface Read<T> {
  readonly value: T;
  readonly end: number;
}

/** Quoted string or server-to-client literal at `pos`; null when more bytes are needed. */
function readString(buf: Buffer, pos: number): Read<string> | null {
  const first = buf[pos];
  if (first === undefined) return null;

  if (first === DQUOTE) {
    const bytes: number[] = [];
    for (let i = pos + 1; ; i += 1) {
      const c = buf[i];
      if (c === undefined) return null;
      if (c === DQUOTE) return { value: Buffer.from(bytes).toString("utf8"), end: i + 1 };
      if (c === CR || c === LF) throw protocolError("line break inside quoted string");
      if (c === BACKSLASH) {
        const escaped = buf[i + 1];
        if (escaped === undefined) return null;
        bytes.push(escaped);
        i += 1;
      } else {
        bytes.push(c);
      }
    }
  }

  if (first === LBRACE) {
    let i = pos + 1;
    let length = 0;
    let digits = 0;
    for (;;) {
      const c = buf[i];
      if (c === undefined) return null;
      if (c < ZERO || c > NINE) break;
      length = length * 10 + (c - ZERO);
      digits += 1;
      if (digits > 10 || length > MAX_RESPONSE_BYTES) throw protocolError("literal too large");
      i += 1;
    }
    const closing = buf[i];
    if (digits === 0) throw protocolError("malformed literal");
    if (closing === undefined) return null;
    if (closing === PLUS) throw protocolError("non-synchronising literal from server");
    if (closing !== RBRACE) throw protocolError("malformed literal");
    const cr = buf[i + 1];
    const lf = buf[i + 2];
    if (cr === undefined || lf === undefined) return null;
    if (cr !== CR || lf !== LF) throw protocolError("malformed literal");
    const start = i + 3;
    if (buf.length < start + length) return null;
    return { value: buf.toString("utf8", start, start + length), end: start + length };
  }

  throw protocolError("expected a string");
}

/** Atom (letters, digits, `-`, `_`, `/`, `.`) at `pos`; stops at space or line end. */
function readAtom(buf: Buffer, pos: number): Read<string> | null {
  let i = pos;
  for (;;) {
    const c = buf[i];
    if (c === undefined) return null;
    if (c === SP || c === CR || c === LF) break;
    i += 1;
  }
  return { value: buf.toString("latin1", pos, i), end: i };
}

function expectCrlf(buf: Buffer, pos: number): number | null {
  const cr = buf[pos];
  const lf = buf[pos + 1];
  if (cr === undefined || (cr === CR && lf === undefined)) return null;
  if (cr !== CR || lf !== LF) throw protocolError("expected end of line");
  return pos + 2;
}

const STATUS = /^(ok|no|bye)$/i;

interface StatusLine {
  readonly status: Status;
  readonly code: string | null;
  readonly text: string | null;
  readonly end: number;
}

/** Parses `OK|NO|BYE [SP "(" code ")"] [SP string] CRLF` after the status word. */
function readStatusRest(buf: Buffer, pos: number, status: Status): StatusLine | null {
  let i = pos;
  let code: string | null = null;
  let text: string | null = null;

  if (buf[i] === SP && buf[i + 1] === LPAREN) {
    let j = i + 2;
    let inQuote = false;
    for (;;) {
      const c = buf[j];
      if (c === undefined) return null;
      if (c === CR || c === LF) throw protocolError("unterminated response code");
      if (inQuote) {
        if (c === BACKSLASH) j += 1;
        else if (c === DQUOTE) inQuote = false;
      } else if (c === DQUOTE) {
        inQuote = true;
      } else if (c === RPAREN) {
        break;
      }
      j += 1;
    }
    code = buf.toString("utf8", i + 2, j);
    i = j + 1;
  }

  if (buf[i] === SP) {
    const str = readString(buf, i + 1);
    if (str === null) return null;
    text = str.value;
    i = str.end;
  } else if (buf[i] === undefined) {
    return null;
  }

  const end = expectCrlf(buf, i);
  return end === null ? null : { status, code, text, end };
}

/**
 * Parses one complete response (zero or more data lines, then the status line) from the start of
 * `buf`. Returns null while the response is incomplete; throws on anything malformed.
 */
export function parseResponse(buf: Buffer): Parsed | null {
  if (buf.length > MAX_RESPONSE_BYTES) throw protocolError("response too large");
  const data: Token[][] = [];
  let pos = 0;

  for (;;) {
    if (buf[pos] === undefined) return null;

    const word = readAtom(buf, pos);
    if (word === null) return null;
    if (buf[pos] !== DQUOTE && buf[pos] !== LBRACE && STATUS.test(word.value)) {
      const status = word.value.toUpperCase() as Status;
      const line = readStatusRest(buf, word.end, status);
      if (line === null) return null;
      return {
        response: { status, code: line.code, text: line.text, data },
        consumed: line.end,
      };
    }

    const tokens: Token[] = [];
    for (;;) {
      const c = buf[pos];
      if (c === undefined) return null;
      if (c === CR || c === LF) {
        const end = expectCrlf(buf, pos);
        if (end === null) return null;
        pos = end;
        break;
      }
      if (c === SP) {
        pos += 1;
      } else if (c === DQUOTE || c === LBRACE) {
        const str = readString(buf, pos);
        if (str === null) return null;
        tokens.push({ kind: "string", value: str.value });
        pos = str.end;
      } else {
        const atom = readAtom(buf, pos);
        if (atom === null) return null;
        tokens.push({ kind: "atom", value: atom.value });
        pos = atom.end;
      }
    }
    data.push(tokens);
  }
}

/** Capability lines (`"NAME" ["value"]`) into a name → value map; names uppercased. */
export function capabilitiesOf(response: Response): ReadonlyMap<string, string> {
  const caps = new Map<string, string>();
  for (const line of response.data) {
    const [name, value] = line;
    if (name?.kind === "string") caps.set(name.value.toUpperCase(), value?.value ?? "");
  }
  return caps;
}
