import { describe, expect, it } from "vitest";
import { PROVIDERS, SUPPORT_LEVELS } from "../src/registry.js";

describe("provider registry", () => {
  it("has unique ids and valid levels", () => {
    const ids = PROVIDERS.map((p) => p.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const p of PROVIDERS) expect(SUPPORT_LEVELS).toContain(p.level);
  });

  it("claims no measured evidence before any live test", () => {
    expect(PROVIDERS.every((p) => p.evidence === "documented")).toBe(true);
  });
});
