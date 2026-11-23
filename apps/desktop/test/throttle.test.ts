import { describe, expect, it } from "vitest";
import { createThrottle } from "../src/mail-watchers.js";

describe("createThrottle", () => {
  it("lets one through per key and time, and then says how many it held back", () => {
    let now = 0;
    const pass = createThrottle(1_000, () => now);
    expect(pass("a")).toBe(0);
    for (let i = 0; i < 3; i += 1) expect(pass("a")).toBeNull();
    expect(pass("b")).toBe(0);
    now = 999;
    expect(pass("a")).toBeNull();
    now = 1_000;
    expect(pass("a")).toBe(4);
    now = 2_000;
    expect(pass("a")).toBe(0);
  });
});
