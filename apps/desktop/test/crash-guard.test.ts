import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  CRASH_LINES_MAX,
  CRASH_QUIT_DELAY_MS,
  CRASH_RESTART_MIN_MS,
  REJECTION_LINES_MAX,
  crashFields,
  createCrashStamp,
  installCrashGuard,
} from "../src/crash-guard.js";

describe("crashFields", () => {
  it("keeps the name, the message and the places, and nothing that names a person", () => {
    const error = new TypeError(
      "cannot read C:\\Users\\someone\\AppData\\x.json for me.too@own.example",
    );
    error.stack = [
      "TypeError: cannot read for me.too@own.example",
      "    at AccountWatcher.drain (file:///C:/Users/some%20one/app/dist/watcher.js:10:5)",
      "    at C:\\Users\\someone\\app\\dist\\main.js:200:11",
      "    at node:internal/process/task_queues:104:5",
      "    at async Promise.all (index 0)",
    ].join("\n");
    const fields = crashFields(error);
    expect(fields).toEqual({
      name: "TypeError",
      // Where an unquoted path ends is not known (a folder may have spaces), so the rest of the line goes with it.
      detail: "cannot read [path]",
      at: "watcher.js:10:5 < main.js:200:11 < task_queues:104:5",
    });
  });

  it.each([
    [String.raw`open 'C:\Users\Jane Doe\AppData\x.json' failed`, "open '[path]' failed"],
    [String.raw`rename '\\fileserver\home\jane.doe\x.json'`, "rename '[path]'"],
    ["open '/c/Users/Jane Doe/x.json'", "open '[path]'"],
    ["open file:///C:/Users/Jane%20Doe/x.json", "open [path]"],
    ['refused "jane doe"@example.com', "refused [address]"],
    ["refused <jane.doe@example.com>", "refused <[address]>"],
    ["GET /u?login=jane%40example.com", "GET [address]"],
    // Not a folder: the address of a server stays.
    ["GET https://example.com/a failed", "GET https://example.com/a failed"],
    ["connect ETIMEDOUT 192.0.2.1:993", "connect ETIMEDOUT 192.0.2.1:993"],
  ])("%s", (message, detail) => {
    expect(crashFields(new Error(message)).detail).toBe(detail);
  });

  it("drops a message that quotes what could not be parsed, and cleans the name", () => {
    let parse: unknown;
    try {
      JSON.parse("EXAMPLESECRETTOKEN");
    } catch (error) {
      parse = error;
    }
    expect((parse as Error).message).toContain("EXAMPLESECRETTOKEN");
    expect(crashFields(parse)).toMatchObject({ name: "SyntaxError", detail: "" });
    const zod = new Error("EXAMPLESECRETTOKEN");
    zod.name = "ZodError";
    expect(crashFields(zod).detail).toBe("");
    const named = new Error("x");
    named.name = String.raw`C:\Users\Jane`;
    expect(crashFields(named).name).toBe("[path]");
  });

  it("keeps a code that is a word, and survives fields that are not text", () => {
    expect(crashFields(Object.assign(new Error("x"), { code: "ENOENT" })).code).toBe("ENOENT");
    expect(
      crashFields(Object.assign(new Error("x"), { code: "a@own.example" })).code,
    ).toBeUndefined();
    const odd = Object.assign(new Error("x"), {
      message: undefined,
      name: 7,
      stack: null,
      code: 5,
    });
    expect(crashFields(odd)).toEqual({ name: "", detail: "", at: "" });
    const hostile = new Error("x");
    for (const key of ["name", "message", "stack", "code"]) {
      Object.defineProperty(hostile, key, {
        get: () => {
          throw new Error("no");
        },
      });
    }
    expect(crashFields(hostile)).toEqual({ name: "", detail: "", at: "" });
  });

  it("bounds what it keeps, and takes anything that was thrown", () => {
    expect(crashFields(new Error("x".repeat(5_000))).detail).toHaveLength(200);
    expect(crashFields("secret@own.example")).toEqual({ name: "string", detail: "", at: "" });
    expect(crashFields(null)).toEqual({ name: "object", detail: "", at: "" });
    const bare = new Error("no stack");
    delete bare.stack;
    expect(crashFields(bare).at).toBe("");
  });
});

const NOW = Date.UTC(2026, 0, 5, 10);
function setup(
  uptimeMs: number,
  { last = null, stamped = true }: { last?: number | null; stamped?: boolean } = {},
) {
  const handlers = new Map<string, (reason: unknown) => void>();
  const deps = {
    process: {
      on: (event: string, listener: (reason: unknown) => void) => handlers.set(event, listener),
    },
    log: vi.fn<(event: string, fields?: object) => void>(),
    uptimeMs: () => uptimeMs,
    lastRestartAt: () => last,
    stampRestart: vi.fn<(at: number) => boolean>(() => stamped),
    now: () => NOW,
    restart: vi.fn<() => void>(),
    giveUp: vi.fn(),
  };
  installCrashGuard(deps);
  return {
    ...deps,
    crash: (e: unknown) => handlers.get("uncaughtException")?.(e),
    reject: (e: unknown) => handlers.get("unhandledRejection")?.(e),
  };
}

describe("installCrashGuard", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("quits on a later turn, never inside the handler", () => {
    for (const uptime of [0, CRASH_RESTART_MIN_MS]) {
      const t = setup(uptime);
      t.crash(new Error("a"));
      vi.advanceTimersByTime(CRASH_QUIT_DELAY_MS - 1);
      expect(t.restart).not.toHaveBeenCalled();
      expect(t.giveUp).not.toHaveBeenCalled();
    }
  });

  it("restarts once, at any age, and keeps the time of it for the next run", () => {
    for (const uptime of [0, CRASH_RESTART_MIN_MS]) {
      const t = setup(uptime);
      t.crash(new Error("a"));
      t.crash(new Error("b"));
      vi.advanceTimersByTime(CRASH_QUIT_DELAY_MS);
      expect(t.restart).toHaveBeenCalledTimes(1);
      expect(t.stampRestart).toHaveBeenCalledExactlyOnceWith(NOW);
      expect(t.giveUp).not.toHaveBeenCalled();
      expect(t.log.mock.calls.map((c) => [c[0], (c[1] as { again: boolean }).again])).toEqual([
        ["crash", false],
        ["crash", true],
      ]);
    }
  });

  it.each([
    ["one just before", 1_000, "giveUp"],
    ["one just inside the limit", CRASH_RESTART_MIN_MS - 1, "giveUp"],
    ["one at the limit", CRASH_RESTART_MIN_MS, "restart"],
    ["a time ahead of the clock", -1, "restart"],
  ] as const)(
    "a fault at every start must not sign in to every account in a loop: %s",
    (_name, ago, expected) => {
      const t = setup(1_000, { last: NOW - ago });
      t.crash(new Error("a"));
      vi.advanceTimersByTime(CRASH_QUIT_DELAY_MS);
      expect(t.restart).toHaveBeenCalledTimes(expected === "restart" ? 1 : 0);
      expect(t.giveUp).toHaveBeenCalledTimes(expected === "giveUp" ? 1 : 0);
    },
  );

  it("with no stamp for the next run, only a run that had lasted starts again", () => {
    for (const [uptime, restarts] of [
      [CRASH_RESTART_MIN_MS - 1, 0],
      [CRASH_RESTART_MIN_MS, 1],
    ] as const) {
      const t = setup(uptime, { stamped: false });
      t.crash(new Error("a"));
      vi.advanceTimersByTime(CRASH_QUIT_DELAY_MS);
      expect(t.restart).toHaveBeenCalledTimes(restarts);
      expect(t.giveUp).toHaveBeenCalledTimes(1 - restarts);
    }
  });

  it("does not fill the log while the quit takes its time", () => {
    const t = setup(0);
    for (let i = 0; i < CRASH_LINES_MAX * 3; i += 1) t.crash(new Error("a"));
    expect(t.log).toHaveBeenCalledTimes(CRASH_LINES_MAX);
  });

  it("only logs an unhandled rejection, and not for ever", () => {
    const t = setup(CRASH_RESTART_MIN_MS);
    for (let i = 0; i < REJECTION_LINES_MAX * 2; i += 1) t.reject(new Error("x"));
    expect(t.log).toHaveBeenCalledTimes(REJECTION_LINES_MAX);
    expect(t.restart).not.toHaveBeenCalled();
  });
});

describe("createCrashStamp", () => {
  const dir = mkdtempSync(join(tmpdir(), "senderban-crash-"));
  const path = join(dir, "crash-restart.json");
  afterAll(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("gives back what it kept, and nothing for a file it cannot use", () => {
    const stamp = createCrashStamp(path);
    expect(stamp.lastRestartAt()).toBeNull();
    expect(stamp.stampRestart(NOW)).toBe(true);
    expect(stamp.lastRestartAt()).toBe(NOW);
    for (const bad of [
      "",
      "{",
      "null",
      '{"at":"1"}',
      '{"at":-1}',
      '{"at":1.5}',
      '{"at":1,"x":1}',
      `{"at":${"1".repeat(300)}}`,
    ]) {
      writeFileSync(path, bad);
      expect(stamp.lastRestartAt()).toBeNull();
    }
    expect(createCrashStamp(join(dir, "no", "such", "x.json")).stampRestart(NOW)).toBe(false);
  });
});

// main.ts imports Electron and does not load under vitest, so its wiring is pinned by text.
const main = readFileSync(join(import.meta.dirname, "../src/main.ts"), "utf8");

describe("main.ts", () => {
  it("installs the guard before anything starts, and logs pages and helper processes that die", () => {
    expect(main.indexOf("installCrashGuard({")).toBeGreaterThan(0);
    expect(main.indexOf("installCrashGuard({")).toBeLessThan(main.indexOf("app.whenReady()"));
    expect(main).toContain('app.on("render-process-gone"');
    expect(main).toContain('app.on("child-process-gone"');
  });

  it("says in the log who asked for a quit", () => {
    expect(main).toContain('log("quit", { by: quitBy });');
    for (const by of ["tray", "restart", "crash"]) expect(main).toContain(`quitBy = "${by}";`);
  });

  it("asks the list before it shows a mail of a blocked sender", () => {
    expect(main).toContain("const screened = screenBlocked(");
    expect(main).toContain('if (screened === "silent") return;');
    expect(main).toContain("ruleChecks.leak(id, entryId);");
  });

  it("ends without a dialog: nobody may be there to close it", () => {
    expect(main).not.toContain("showErrorBox");
  });

  it("takes the mark of a repair back when its round saved nothing", () => {
    expect(main).toContain("JSON.stringify(left.data) === JSON.stringify(marked.data)");
  });
});
