import { afterEach, describe, expect, it, vi } from "vitest";
import { SHUTDOWN_DEADLINE_MS, settleWithin, stopThenClose } from "../src/deadline.js";

afterEach(() => {
  vi.useRealTimers();
});

describe("settleWithin", () => {
  it("returns done as soon as the work settles, before the deadline", async () => {
    vi.useFakeTimers();
    expect(await settleWithin(Promise.resolve(1), SHUTDOWN_DEADLINE_MS)).toBe("done");
    expect(vi.getTimerCount()).toBe(0);
  });

  it("counts a rejected piece of work as done (the quit must not stop on it)", async () => {
    vi.useFakeTimers();
    expect(await settleWithin(Promise.reject(new Error("x")), SHUTDOWN_DEADLINE_MS)).toBe("done");
    expect(vi.getTimerCount()).toBe(0);
  });

  it("gives up at the deadline when the work hangs, as a dead socket does", async () => {
    vi.useFakeTimers();
    const result = settleWithin(new Promise(() => undefined), SHUTDOWN_DEADLINE_MS);
    await vi.advanceTimersByTimeAsync(SHUTDOWN_DEADLINE_MS);
    expect(await result).toBe("timeout");
    expect(vi.getTimerCount()).toBe(0);
  });
});

describe("stopThenClose", () => {
  function deps(stop: () => Promise<unknown>) {
    const calls: string[] = [];
    return {
      calls,
      value: {
        stop,
        closeStore: () => {
          calls.push("closeStore");
        },
        log: vi.fn((event: string) => {
          calls.push(event);
        }),
        ms: SHUTDOWN_DEADLINE_MS,
      },
    };
  }

  it("closes the store after a clean stop and logs nothing", async () => {
    const { calls, value } = deps(() => Promise.resolve());
    await stopThenClose(value);
    expect(calls).toEqual(["closeStore"]);
  });

  it("logs the deadline and still closes the store when a stop hangs", async () => {
    vi.useFakeTimers();
    const { calls, value } = deps(() => new Promise(() => undefined));
    const done = stopThenClose(value);
    await vi.advanceTimersByTimeAsync(SHUTDOWN_DEADLINE_MS);
    await done;
    expect(calls).toEqual(["quit-deadline", "closeStore"]);
    expect(value.log).toHaveBeenCalledWith("quit-deadline", { ms: SHUTDOWN_DEADLINE_MS });
  });
});
