import { describe, expect, it, vi } from "vitest";
import { REOPEN_MANAGE_ARG, relaunchArgs, restartApp } from "../src/restart.js";

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
      relaunch: mark("relaunch"),
      quit: mark("quit"),
    },
  };
}

describe("restartApp", () => {
  it("frees the lock and registers the new start before the quit begins", () => {
    const { calls, value } = deps(false);
    expect(restartApp(value)).toBe(true);
    expect(calls).toEqual(["log", "releaseLock", "relaunch", "quit"]);
    expect(value.log).toHaveBeenCalledWith("restart");
  });

  it("does nothing while a quit is already running (a second click must not queue a second start)", () => {
    const { calls, value } = deps(true);
    expect(restartApp(value)).toBe(false);
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
