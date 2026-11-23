import { readFileSync, statSync, writeFileSync } from "node:fs";
import { CrashStampSchema } from "@senderban/core";
import type { Log } from "./log.js";

// What happens when something nobody caught reaches the top. Node's docs (process, "Warning: Using 'uncaughtException' correctly", read
// for Node 24) say it is not safe to go on after one; without a handler Electron shows a dialog and goes on. So: one log line, the normal
// quit, and a new start, at most one in CRASH_RESTART_MIN_MS: a fault that comes back at every start must not sign in to every account in a
// loop. The time of the last one is kept on disk, so the first crash of a young run (sign-in, no network yet) is started again too.

/** Two restarts after a crash are at least this far apart. Unit: milliseconds. Bounds restarts to 6 an hour, and logins with them. */
export const CRASH_RESTART_MIN_MS = 600_000;
/**
 * The wait before the quit. Unit: milliseconds. The quit starts on a later turn, outside the stack that just failed. Measured on Electron
 * 45.3.0 (2026-11-22): an exception thrown from a timer, then `quit`, then the new start 0.9 s later.
 */
export const CRASH_QUIT_DELAY_MS = 50;
/** Log lines about unhandled rejections in one run, at most. They change nothing else, and one per mail must not fill the log. */
export const REJECTION_LINES_MAX = 50;
/** Log lines about crashes in one run, at most: the quit that the first one starts can take a while, and a timer can throw again. */
export const CRASH_LINES_MAX = 20;
/** Stack frames kept in the log line. */
const FRAMES_MAX = 5;
const MESSAGE_MAX = 200;
/** `error.code` of Node, Electron and SQLite: a word, never text. */
const CODE = /^[A-Z][A-Z0-9_]{0,39}$/u;
/** Errors whose message quotes what they could not read: a file or an answer with a password, a token or a subject in it. */
const QUOTING = new Set(["SyntaxError", "ZodError", "$ZodError"]);

/** With a quoted local part (`"a b"@example.com`) or percent-encoded (`a%40example.com`) too. */
const ADDRESS = /(?:"[^"\r\n]*"|[^\s<>"']+)(?:@|%40)[^\s<>"']+/giu;
/**
 * A folder of this PC or a share holds the Windows user name, which may have spaces: everything up to a quote or the end of the line goes.
 * Drive (`C:\`, `C:/`, `file:///C:/`), share (`\\\\server`), and the forms Git Bash and other systems use (`/c/Users`, `/home`).
 */
const FOLDER =
  /(?:file:\/\/\/)?(?:(?<![A-Za-z])[A-Za-z]:[\\/]|\\\\|(?<![A-Za-z0-9])\/(?:[A-Za-z]\/)?(?:Users|home)\/)[^"'<>|\r\n]*/gu;
const clean = (text: string): string =>
  text
    .slice(0, MESSAGE_MAX * 4)
    .replace(FOLDER, "[path]")
    .replace(ADDRESS, "[address]")
    .slice(0, MESSAGE_MAX);
/** `at fn (file:///C:/Users/me/app/x.js:1:2)` -> `x.js:1:2`: a path holds the Windows user name. */
const FRAME_PLACE = /([^\\/()\s]+:\d+:\d+)\)?$/u;

export type CrashFields = {
  readonly name: string;
  readonly code?: string;
  readonly detail: string;
  readonly at: string;
};

/** An error as the log may carry it: no address, no folder, bounded. Never the stack as it came: its first line is the message. */
export function crashFields(error: unknown): CrashFields {
  if (!(error instanceof Error)) return { name: typeof error, detail: "", at: "" };
  // Anything can be assigned to these; a throw in here would end the process with no line at all.
  const text = (key: "name" | "message" | "stack" | "code"): string => {
    try {
      const value: unknown = Reflect.get(error, key);
      return typeof value === "string" ? value : "";
    } catch {
      return "";
    }
  };
  const name = text("name");
  const code = text("code");
  const frames = text("stack")
    .split("\n")
    .filter((line) => /^\s+at /u.test(line))
    .slice(0, FRAMES_MAX)
    .flatMap((line) => FRAME_PLACE.exec(line.trim())?.[1] ?? []);
  return {
    name: clean(name),
    ...(CODE.test(code) ? { code } : {}),
    detail: QUOTING.has(name) ? "" : clean(text("message")),
    at: frames.join(" < "),
  };
}

/** `{"at":1234567890123}`; anything bigger is not ours. Unit: bytes. */
const STAMP_MAX_BYTES = 256;

/** The time of the last restart after a crash, on disk. Both answer instead of throwing: they run inside the crash handler. */
export function createCrashStamp(
  path: string,
): Pick<CrashGuardDeps, "lastRestartAt" | "stampRestart"> {
  return {
    lastRestartAt: () => {
      try {
        if (statSync(path).size > STAMP_MAX_BYTES) return null;
        const parsed = CrashStampSchema.safeParse(JSON.parse(readFileSync(path, "utf8")));
        return parsed.success ? parsed.data.at : null;
      } catch {
        return null;
      }
    },
    stampRestart: (at) => {
      try {
        writeFileSync(path, JSON.stringify({ at }));
        return true;
      } catch {
        return false;
      }
    },
  };
}

export interface CrashGuardDeps {
  readonly process: {
    on(
      event: "uncaughtException" | "unhandledRejection",
      listener: (reason: unknown) => void,
    ): unknown;
  };
  readonly log: Log;
  /** How long this process has run. Milliseconds. */
  readonly uptimeMs: () => number;
  /** When a crash last started Senderban again, from an earlier run; epoch milliseconds, null when unknown. */
  readonly lastRestartAt: () => number | null;
  /** Keeps the time of a restart for the next run. False: it could not be kept. */
  readonly stampRestart: (at: number) => boolean;
  /** Quits the normal way and starts again. */
  readonly restart: () => void;
  /** Says it and ends: no new start. */
  readonly giveUp: () => void;
  readonly now?: () => number;
}

export function installCrashGuard(deps: CrashGuardDeps): void {
  const now = deps.now ?? Date.now;
  let crashes = 0;
  let rejections = 0;
  /** Without a stamp for the next run only this run's age can break a loop. A time ahead of the clock is no reason to stay down. */
  const mayRestart = (uptimeMs: number): boolean => {
    const at = now();
    const last = deps.lastRestartAt();
    if (last !== null && last <= at && at - last < CRASH_RESTART_MIN_MS) return false;
    return deps.stampRestart(at) || uptimeMs >= CRASH_RESTART_MIN_MS;
  };
  deps.process.on("uncaughtException", (error) => {
    crashes += 1;
    const uptimeMs = deps.uptimeMs();
    if (crashes <= CRASH_LINES_MAX) {
      deps.log("crash", {
        ...crashFields(error),
        upS: Math.round(uptimeMs / 1000),
        again: crashes > 1,
      });
    }
    // A second one while the first is being handled: the quit that is running has its own cap.
    if (crashes > 1) return;
    setTimeout(mayRestart(uptimeMs) ? deps.restart : deps.giveUp, CRASH_QUIT_DELAY_MS);
  });
  deps.process.on("unhandledRejection", (reason) => {
    rejections += 1;
    if (rejections <= REJECTION_LINES_MAX) deps.log("unhandled-rejection", crashFields(reason));
  });
}
