import { describe, expect, it, vi } from "vitest";
import { REOPEN_MANAGE_ARG, relaunchArgs, reopenAfterStart, restartApp } from "../src/restart.js";

function deps(quitting: boolean) {
  const calls: string[] = [];
  const mark = (name: string) => () => {
    calls.push(name);
  };
  return {
    calls,
    value: {
      isQuitting: () => quitting,
      log: vi.fn(mark("log")),
      releaseLock: mark("releaseLock"),
      isOpen: vi.fn(() => {
        calls.push("isOpen");
        return true;
      }),
      relaunch: vi.fn(mark("relaunch")),
      quit: mark("quit"),
    },
  };
}

describe("restartApp", () => {
  it("frees the lock and registers the new start before the quit begins", () => {
    const { calls, value } = deps(false);
    expect(restartApp(value, { by: "bar", waitedMs: 0 })).toBe(true);
    expect(calls).toEqual(["log", "releaseLock", "isOpen", "relaunch", "quit"]);
    expect(value.relaunch).toHaveBeenCalledWith(true);
    expect(value.log).toHaveBeenCalledWith("restart", { by: "bar", waitedMs: 0 });
  });

  it("does nothing while a quit is already running (a second click must not queue a second start)", () => {
    const { calls, value } = deps(true);
    expect(restartApp(value, { by: "auto", waitedMs: 2000 })).toBe(false);
    expect(calls).toEqual([]);
  });
});

describe("relaunchArgs", () => {
  it("keeps this process's arguments without the executable and adds the reopen flag", () => {
    expect(relaunchArgs(["C:/app/electron.exe", "C:/app", "--user-data-dir=C:/p"], true)).toEqual([
      "C:/app",
      "--user-data-dir=C:/p",
      REOPEN_MANAGE_ARG,
    ]);
  });

  it("carries the flag once, however many restarts came before", () => {
    const once = relaunchArgs(["exe", REOPEN_MANAGE_ARG], true);
    expect(relaunchArgs(["exe", ...once], true)).toEqual([REOPEN_MANAGE_ARG]);
  });

  it("drops the flag when the window was closed before the restart", () => {
    expect(relaunchArgs(["exe", "C:/app", REOPEN_MANAGE_ARG], false)).toEqual(["C:/app"]);
  });
});

describe("reopenAfterStart", () => {
  const target = () => ({ showAfterRestart: vi.fn(), show: vi.fn() });
  const settle = () => new Promise((resolve) => setImmediate(resolve));

  it("says Senderban restarted only once start worked, and not before", async () => {
    const window = target();
    let finish: (value: unknown) => void = () => undefined;
    const started = new Promise((resolve) => {
      finish = resolve;
    });
    reopenAfterStart(["exe", REOPEN_MANAGE_ARG], started, () => window);
    await settle();
    expect(window.showAfterRestart).not.toHaveBeenCalled();
    finish(undefined);
    await settle();
    expect(window.showAfterRestart).toHaveBeenCalledOnce();
    expect(window.show).not.toHaveBeenCalled();
  });

  it("opens the window without the notice when start failed", async () => {
    const window = target();
    reopenAfterStart(["exe", REOPEN_MANAGE_ARG], Promise.reject(new Error("no")), () => window);
    await settle();
    expect(window.show).toHaveBeenCalledOnce();
    expect(window.showAfterRestart).not.toHaveBeenCalled();
  });

  it("opens nothing for a start without the flag", async () => {
    const window = target();
    reopenAfterStart(["exe", "C:/app"], Promise.resolve(), () => window);
    await settle();
    expect(window.show).not.toHaveBeenCalled();
    expect(window.showAfterRestart).not.toHaveBeenCalled();
  });
});
