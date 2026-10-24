/**
 * Just enough Sieve lexing (RFC 5228 §2) to find the leading `require` block of a script we do
 * not own and to ignore comments when looking for our `include`. Anything it cannot read is
 * reported as `null`; callers refuse to edit a script they cannot parse.
 */

const IDENT_CHAR = /[A-Za-z0-9_]/;

/** Index after whitespace and comments starting at `pos`, or null for an unterminated comment. */
function skipTrivia(s: string, start: number): number | null {
  let pos = start;
  for (;;) {
    const c = s[pos];
    if (c === " " || c === "\t" || c === "\r" || c === "\n") {
      pos += 1;
    } else if (c === "#") {
      const eol = s.indexOf("\n", pos);
      pos = eol === -1 ? s.length : eol + 1;
    } else if (c === "/" && s[pos + 1] === "*") {
      const close = s.indexOf("*/", pos + 2);
      if (close === -1) return null;
      pos = close + 2;
    } else {
      return pos;
    }
  }
}

/** Reads a quoted string at `pos` (`s[pos]` must be `"`); a backslash escapes the next octet. */
function readQuoted(s: string, pos: number): { value: string; end: number } | null {
  let value = "";
  let i = pos + 1;
  while (i < s.length) {
    const c = s.charAt(i);
    if (c === "\\") {
      const next = s[i + 1];
      if (next === undefined) return null;
      value += next;
      i += 2;
    } else if (c === '"') {
      return { value, end: i + 1 };
    } else {
      value += c;
      i += 1;
    }
  }
  return null;
}

export interface RequireBlock {
  /** Offset just after the last leading `require ...;`, 0 when the script has none. */
  readonly end: number;
  readonly extensions: ReadonlySet<string>;
}

/** Parses the leading `require` commands. Null when one of them is malformed or uses `text:`. */
export function parseRequireBlock(script: string): RequireBlock | null {
  const extensions = new Set<string>();
  let end = 0;
  let pos = 0;
  for (;;) {
    const start = skipTrivia(script, pos);
    if (start === null) return null;
    const isRequire =
      script.slice(start, start + 7).toLowerCase() === "require" &&
      !IDENT_CHAR.test(script[start + 7] ?? "");
    if (!isRequire) return { end, extensions };

    let cur = skipTrivia(script, start + 7);
    if (cur === null) return null;
    if (script[cur] === "[") {
      cur += 1;
      for (;;) {
        const itemStart = skipTrivia(script, cur);
        if (itemStart === null || script[itemStart] !== '"') return null;
        const item = readQuoted(script, itemStart);
        if (item === null) return null;
        extensions.add(item.value.toLowerCase());
        const after = skipTrivia(script, item.end);
        if (after === null) return null;
        if (script[after] === ",") {
          cur = after + 1;
        } else if (script[after] === "]") {
          cur = after + 1;
          break;
        } else {
          return null;
        }
      }
    } else if (script[cur] === '"') {
      const item = readQuoted(script, cur);
      if (item === null) return null;
      extensions.add(item.value.toLowerCase());
      cur = item.end;
    } else {
      return null;
    }
    const semi = skipTrivia(script, cur);
    if (semi === null || script[semi] !== ";") return null;
    end = semi + 1;
    pos = end;
  }
}

/** Replaces comments with spaces (keeps offsets); string contents are left alone. Null if malformed. */
export function stripComments(script: string): string | null {
  let out = "";
  let i = 0;
  while (i < script.length) {
    const c = script.charAt(i);
    if (c === '"') {
      const q = readQuoted(script, i);
      if (q === null) return null;
      out += script.slice(i, q.end);
      i = q.end;
    } else if (c === "#") {
      const eol = script.indexOf("\n", i);
      const stop = eol === -1 ? script.length : eol;
      out += " ".repeat(stop - i);
      i = stop;
    } else if (c === "/" && script[i + 1] === "*") {
      const close = script.indexOf("*/", i + 2);
      if (close === -1) return null;
      out += script.slice(i, close + 2).replace(/[^\n]/g, " ");
      i = close + 2;
    } else {
      out += c;
      i += 1;
    }
  }
  return out;
}

/** Sieve quoted string; values are validated upstream, the escaping is defence in depth. */
export function quote(value: string): string {
  // eslint-disable-next-line no-control-regex -- rejecting control octets is the point
  if (/[\u0000-\u001f\u007f]/.test(value))
    throw new RangeError("control character in Sieve string");
  return `"${value.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}
