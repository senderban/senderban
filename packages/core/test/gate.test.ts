import { describe, expect, it } from "vitest";
import { MAX_GATE_SIZE, createGate, unlimited } from "../src/gate.js";
import { MAX_ACCOUNTS } from "../src/sync/engine.js";

const tick = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

describe("createGate", () => {
  it("never runs more than `max` jobs at once and runs all of them", async () => {
    const gate = createGate(3);
    let running = 0;
    let peak = 0;
    const jobs = Array.from({ length: 20 }, () =>
      gate(async () => {
        running += 1;
        peak = Math.max(peak, running);
        await tick(2);
        running -= 1;
      }),
    );
    await Promise.all(jobs);
    expect(peak).toBe(3);
    expect(running).toBe(0);
  });

  it("starts waiting jobs first in first out", async () => {
    const gate = createGate(1);
    const order: number[] = [];
    await Promise.all(
      [0, 1, 2, 3].map((i) =>
        gate(async () => {
          order.push(i);
          await tick(1);
        }),
      ),
    );
    expect(order).toEqual([0, 1, 2, 3]);
  });

  it("frees the slot when a job throws, and passes the error on", async () => {
    const gate = createGate(1);
    await expect(gate(() => Promise.reject(new Error("boom")))).rejects.toThrow("boom");
    await expect(gate(() => Promise.resolve("next"))).resolves.toBe("next");
  });

  it("rejects a size outside 1..MAX_GATE_SIZE", () => {
    for (const bad of [0, -1, 1.5, Number.NaN, MAX_GATE_SIZE + 1]) {
      expect(() => createGate(bad)).toThrow(RangeError);
    }
    expect(() => createGate(MAX_GATE_SIZE)).not.toThrow();
  });

  it("keeps its upper bound equal to the account cap", () => {
    expect(MAX_GATE_SIZE).toBe(MAX_ACCOUNTS);
  });

  it("`unlimited` runs everything at once", async () => {
    let running = 0;
    let peak = 0;
    await Promise.all(
      Array.from({ length: 10 }, () =>
        unlimited(async () => {
          running += 1;
          peak = Math.max(peak, running);
          await tick(2);
          running -= 1;
        }),
      ),
    );
    expect(peak).toBe(10);
  });
});
