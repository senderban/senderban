import { AdapterError, SWEEP_ALL_GAP_MS } from "@senderban/core";
import type { GapReason, ImapCleanAdapter } from "@senderban/core";
import { describe, expect, it, vi } from "vitest";
import { cleanGapListener, cleanLane } from "../src/clean-lane.js";

const setup = (sweepAll: (force?: boolean) => void = vi.fn()) => {
  const clock = { now: 0 };
  const requestSync = vi.fn();
  const log = vi.fn();
  const listen = cleanGapListener({ sweepAll, requestSync, log, now: () => clock.now });
  return { clock, requestSync, log, listen };
};

describe("cleanLane", () => {
  it("puts a cleaning lane on the cleaning gate", () => {
    const adapter = {} as ImapCleanAdapter;
    expect(cleanLane("a", adapter)).toMatchObject({ id: "a", adapter, cleanGate: true });
  });
});

describe("cleanGapListener", () => {
  it.each<[GapReason, boolean]>([
    ["renumbered", true],
    ["burst", false],
    ["unreadable", false],
  ])("forces the sweep only for a renumbered mailbox: %s", (reason, force) => {
    const sweepAll = vi.fn();
    const { requestSync, log, listen } = setup(sweepAll);
    listen(reason);
    expect(sweepAll).toHaveBeenCalledWith(force);
    expect(requestSync).toHaveBeenCalledTimes(1);
    expect(log).not.toHaveBeenCalled();
  });

  it("still asks for the round when the state could not be saved, because that round is what tells the person", () => {
    const { requestSync, log, listen } = setup(() => {
      throw new Error("disk full at /private/path");
    });
    listen("burst");
    expect(requestSync).toHaveBeenCalledTimes(1);
    expect(log).toHaveBeenCalledWith({ reason: "burst", failed: 1, error: "store" });
  });

  it("names the code of a refused state, never a message", () => {
    const { log, listen } = setup(() => {
      throw new AdapterError("REJECTED", "cleaning state failed validation");
    });
    listen("unreadable");
    expect(log).toHaveBeenCalledWith({ reason: "unreadable", failed: 1, error: "REJECTED" });
  });

  it("logs a failing save once per limit, with the gaps since", () => {
    const { clock, requestSync, log, listen } = setup(() => {
      throw new Error("no");
    });
    for (let gap = 0; gap < 60; gap += 1) listen("burst");
    expect(log).toHaveBeenCalledTimes(1);
    clock.now += SWEEP_ALL_GAP_MS;
    listen("burst");
    expect(log).toHaveBeenCalledTimes(2);
    expect(log).toHaveBeenLastCalledWith({ reason: "burst", failed: 60, error: "store" });
    expect(requestSync).toHaveBeenCalledTimes(61);
  });
});
