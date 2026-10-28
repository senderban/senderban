import { describe, expect, it, vi } from "vitest";
import { restartApp } from "../src/restart.js";

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
