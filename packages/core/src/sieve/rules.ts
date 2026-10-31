import { createHash } from "node:crypto";
import { AdapterError } from "../adapter.js";
import { checkEntry, folderAction, type Blocklist } from "../blocklist.js";
import { SPAM_LIMITS, type SpamRule } from "../spam-filter.js";
import { parseRequireBlock, quote, stripComments } from "./syntax.js";

export const RULES_MARKER = "# senderban-managed v1";
export const MAIN_MARKER = "# senderban-managed";

/** Script names we create; lowercase so they are valid on every ManageSieve server. */
export const SCRIPT_NAME = /^[a-z0-9][a-z0-9-]{0,62}$/;
const FOLDER_NAME = /^[\p{L}\p{N} ._-]{1,64}$/u;

export interface RenderOptions {
  readonly junkFolder: string;
  readonly trashFolder: string;
  /** The mailbox's spam filter. It goes last, so that a blocked sender keeps the action of its entry. */
  readonly spam?: SpamRule | null;
}

/** Where the server states its score (`watcher.ts` reads the same line). */
const SPAM_HEADER = "X-Spam-Score";

export const DEFAULT_RENDER_OPTIONS: RenderOptions = { junkFolder: "Junk", trashFolder: "Trash" };

export const normalizeNewlines = (script: string): string => script.replace(/\r\n/g, "\n");

/** Hash of the script as we would have written it; CRLF/LF differences do not count as drift. */
export const scriptSha256 = (script: string): string =>
  createHash("sha256").update(normalizeNewlines(script), "utf8").digest("hex");

const bytes = (s: string): number => Buffer.byteLength(s, "utf8");
export const scriptBytes = (script: string): number => bytes(normalizeNewlines(script));

function stringList(values: Iterable<string>): string {
  return `[\n    ${[...values].map(quote).join(",\n    ")}\n  ]`;
}

/**
 * The whole rules script, derived from the list: one `if anyof` per action, sorted so the same
 * list always yields the same bytes. Each key matches the From header and the envelope sender.
 */
export function renderRules(list: Blocklist, options: RenderOptions): string {
  if (!FOLDER_NAME.test(options.junkFolder) || !FOLDER_NAME.test(options.trashFolder)) {
    throw new AdapterError("REJECTED", "folder name not allowed");
  }
  const folders = { junk: options.junkFolder, trash: options.trashFolder } as const;

  const spam = options.spam ?? null;
  const out = ['require ["fileinto", "mailbox", "envelope"];', RULES_MARKER];
  // Junk first, then Trash (each rule stops). A `reject` entry is filed like Junk: the server refusal is the
  // MXroute lane's job and this rule is only the backup for a message that still gets through.
  for (const action of ["junk", "trash"] as const) {
    const addresses = new Set<string>();
    const domains = new Set<string>();
    const patterns = new Set<string>();
    for (const raw of list) {
      if (folderAction(raw.action) !== action) continue;
      const checked = checkEntry(raw);
      if (!checked.ok) {
        throw new AdapterError("REJECTED", `entry ${raw.id} refused: ${checked.reason}`);
      }
      const { match, value } = checked.entry;
      if (match === "exactAddress") addresses.add(value);
      else {
        domains.add(value);
        if (match === "subdomains") patterns.add(`*.${value}`);
      }
    }

    const tests: string[] = [];
    // The From header can be forged and the envelope sender is what the sending server claimed,
    // so every key is tested against both.
    for (const test of ["address", "envelope"]) {
      if (addresses.size > 0) {
        tests.push(`${test} :is "from" ${stringList([...addresses].sort())}`);
      }
      if (domains.size > 0) {
        tests.push(`${test} :domain :is "from" ${stringList([...domains].sort())}`);
      }
      if (patterns.size > 0) {
        tests.push(`${test} :domain :matches "from" ${stringList([...patterns].sort())}`);
      }
    }
    if (tests.length === 0) continue;

    out.push(
      `if anyof (\n  ${tests.join(",\n  ")}\n) {`,
      `  fileinto :create ${quote(folders[action])};`,
      "  stop;",
      "}",
    );
  }
  if (spam !== null) out.push(...spamRuleLines(spam, folders[spam.action]));
  return `${out.join("\n")}\n`;
}

/**
 * The scores at or over `limit`, as Sieve `:matches` patterns: digits, then at most one `*` at the end. Two digits in a row cannot be a
 * score under 10, so `12*` takes 12, 12.3 and 120. Never `?`: Pigeonhole 2.4.5 matched `1? *` on `1.6 (+)` and `?.6 *` on `4.9 (++++)`, so
 * a `?` before a `*` does not hold one character there (measured 2026-10-31).
 */
function scorePatterns(limit: number): string[] {
  const out: string[] = [];
  for (let n = limit; n < 10; n += 1) out.push(String(n), `${String(n)}.*`, `${String(n)} *`);
  for (let n = Math.max(limit, 10); n < 100; n += 1) out.push(`${String(n)}*`);
  // The hundreds of the pairs left out above: 100 is what SpamAssassin adds for a sender on a person's own blacklist.
  for (let n = 10; n < limit; n += 1) {
    for (let digit = 0; digit < 10; digit += 1) out.push(`${String(n)}${String(digit)}*`);
  }
  return out;
}

/**
 * One test on one list, so that one line of the header has to hold all of it. Not `:value "ge"` with `i;ascii-numeric`: that comparator
 * reads a value with no leading digit as positive infinity (RFC 4790 9.1.1), so a clean mail's `-1.2` is over every limit, and a second
 * test to rule that out can be met by another line of the same header. Lists need no extension either, so no server is refused for it.
 * A sender's own `X-Spam-Score: 99` moves its own mail, and a higher score an earlier server left on forwarded mail moves that mail.
 */
function spamRuleLines(spam: SpamRule, folder: string): string[] {
  if (!SPAM_LIMITS.includes(spam.limit)) {
    throw new AdapterError("REJECTED", "spam limit not allowed");
  }
  return [
    `if header :matches ${quote(SPAM_HEADER)} ${stringList(scorePatterns(spam.limit))} {`,
    `  fileinto :create ${quote(folder)};`,
    "  stop;",
    "}",
  ];
}

/** The active script we create when the user has none: it only includes the rules script. */
export function renderMain(rulesName: string): string {
  assertScriptName(rulesName);
  return `require ["include"];\n${MAIN_MARKER}\ninclude :personal ${quote(rulesName)};\n`;
}

export function assertScriptName(name: string): void {
  if (!SCRIPT_NAME.test(name)) throw new AdapterError("REJECTED", "script name not allowed");
}

export const isOurMain = (script: string): boolean =>
  normalizeNewlines(script).split("\n").includes(MAIN_MARKER);

/** True when this rules script carries our marker: anything else of that name is not ours to delete. */
export const isOurRules = (script: string): boolean =>
  normalizeNewlines(script).split("\n").includes(RULES_MARKER);

/**
 * Whether the script (comments ignored) runs `include :personal "<rulesName>"`. `unreadable`: it could not be parsed, so
 * nobody knows, and a caller must not write as if the answer were no.
 */
export function includeState(script: string, rulesName: string): "yes" | "no" | "unreadable" {
  const code = stripComments(normalizeNewlines(script));
  if (code === null) return "unreadable";
  assertScriptName(rulesName);
  const include = new RegExp(`(^|[;{}\\s])include\\s+(:[a-z]+\\s+)*"${rulesName}"\\s*;`, "i");
  return include.test(code) ? "yes" : "no";
}

/** True only for an include that was read; for a script that could not be read, ask `includeState`. */
export const hasInclude = (script: string, rulesName: string): boolean =>
  includeState(script, rulesName) === "yes";

/**
 * Adds our `include` line to a script we do not own, right after its `require` block (a `require`
 * after any other command is invalid Sieve). Throws REJECTED when the script cannot be parsed:
 * we never guess where to write into someone else's rules.
 */
export function insertInclude(script: string, rulesName: string): string {
  assertScriptName(rulesName);
  const text = normalizeNewlines(script);
  const block = parseRequireBlock(text);
  if (block === null) {
    throw new AdapterError("REJECTED", "active script's require block could not be parsed");
  }
  const lines = [
    ...(block.extensions.has("include") ? [] : ['require "include";']),
    MAIN_MARKER,
    `include :personal ${quote(rulesName)};`,
  ];
  const before = text.slice(0, block.end);
  const after = text.slice(block.end);
  return `${before}${before === "" ? "" : "\n"}${lines.join("\n")}\n${after.replace(/^\n/, "")}`;
}

/**
 * Undoes `insertInclude`. If the script is still exactly what we produced from `original`, the
 * original comes back byte for byte (modulo newlines); otherwise only our two lines are dropped,
 * so edits the user made since are kept.
 */
export function removeInclude(script: string, rulesName: string, original: string | null): string {
  assertScriptName(rulesName);
  const text = normalizeNewlines(script);
  if (original !== null && text === insertInclude(original, rulesName)) {
    return normalizeNewlines(original);
  }
  const ours = new RegExp(`^\\s*include\\s+(:[a-z]+\\s+)*"${rulesName}"\\s*;\\s*$`, "i");
  const kept = text.split("\n").filter((line) => line !== MAIN_MARKER && !ours.test(line));
  const result = kept.join("\n");
  if (hasInclude(result, rulesName)) {
    throw new AdapterError(
      "REJECTED",
      "include line is mixed into other commands; remove it by hand",
    );
  }
  return result;
}
