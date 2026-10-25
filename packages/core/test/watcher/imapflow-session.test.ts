import { describe, expect, it } from "vitest";
import {
  FETCH_LIMIT,
  FETCH_SCAN_MAX,
  fetchStartUid,
  keepNewest,
} from "../../src/watcher/imapflow-session.js";

function counting(total: number, pulled: { n: number }): AsyncIterable<number> {
  return {
    [Symbol.asyncIterator]() {
      let i = 0;
      return {
        next(): Promise<IteratorResult<number>> {
          if (i >= total) return Promise.resolve({ done: true, value: undefined });
          i += 1;
          pulled.n += 1;
          return Promise.resolve({ done: false, value: i });
        },
      };
    },
  };
}

describe("fetchStartUid", () => {
  it("starts right after the cursor when the gap is small", () => {
    expect(fetchStartUid(990, 1_000)).toBe(991);
  });

  it("does not ask for more than the newest FETCH_LIMIT slots after weeks offline", () => {
    expect(fetchStartUid(10, 50_000)).toBe(50_000 - FETCH_LIMIT);
  });

  it("never goes below the first UID", () => {
    expect(fetchStartUid(0, 5)).toBe(1);
  });
});

describe("keepNewest", () => {
  it("keeps only the newest rows of a long stream and stops pulling at the scan cap", async () => {
    const pulled = { n: 0 };
    const kept = await keepNewest(counting(10_000, pulled), FETCH_LIMIT, FETCH_SCAN_MAX);
    expect(kept).toHaveLength(FETCH_LIMIT);
    expect(kept.at(-1)).toBe(FETCH_SCAN_MAX);
    expect(pulled.n).toBe(FETCH_SCAN_MAX);
  });

  it("returns everything when the stream is shorter than the limit", async () => {
    const kept = await keepNewest(counting(3, { n: 0 }), FETCH_LIMIT, FETCH_SCAN_MAX);
    expect(kept).toEqual([1, 2, 3]);
  });
});
