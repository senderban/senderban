import { appendFileSync, mkdirSync, renameSync, statSync } from "node:fs";
import { join } from "node:path";

// Budget: a few lines per reconnect, announcement and click per account. Disk is bounded at
// 2 x LOG_MAX_BYTES (current file + one rotated copy), whatever the account count or uptime.
export const LOG_MAX_BYTES = 1_048_576;
const FIELD_MAX = 300;

// Same character class as the watcher's subject sanitiser: no control or bidi characters reach the file.
const CONTROL_AND_BIDI = /[\p{Cc}‎‏‪-‮⁦-⁩]/gu;

export type LogFields = Readonly<Record<string, string | number | boolean | null | undefined>>;
export type Log = (event: string, fields?: LogFields) => void;

/**
 * JSON-lines diagnostics in `<dir>/senderban.log`. Callers pass ids, states, codes and sender
 * domains only: never a password, a subject or a full address. Logging never throws.
 */
export function createLog(dir: string): Log {
  const file = join(dir, "senderban.log");
  try {
    mkdirSync(dir, { recursive: true });
  } catch {
    // Writing below reports nothing either; the app keeps running without a log.
  }
  return (event, fields = {}) => {
    const clean: Record<string, string | number | boolean | null> = {};
    for (const [key, value] of Object.entries(fields)) {
      if (value === undefined) continue;
      clean[key] =
        typeof value === "string"
          ? value.replace(CONTROL_AND_BIDI, " ").slice(0, FIELD_MAX)
          : value;
    }
    const line = JSON.stringify({ t: new Date().toISOString(), event, ...clean });
    console.error(`[senderban] ${line}`);
    try {
      if ((statSync(file, { throwIfNoEntry: false })?.size ?? 0) > LOG_MAX_BYTES) {
        renameSync(file, `${file}.1`);
      }
      appendFileSync(file, `${line}\n`, "utf8");
    } catch {
      // A full disk or a locked file must not take the watcher down.
    }
  };
}
