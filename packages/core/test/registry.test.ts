import { describe, expect, it } from "vitest";
import { PRESET_SERVERS } from "../src/mail-server.js";
import { PROVIDERS, SUPPORT_LEVELS } from "../src/registry.js";

describe("provider registry", () => {
  it("has unique ids and valid levels", () => {
    const ids = PROVIDERS.map((p) => p.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const p of PROVIDERS) expect(SUPPORT_LEVELS).toContain(p.level);
  });

  it("claims measured evidence only for providers the adapter has run against live", () => {
    const measured = PROVIDERS.filter((p) => p.evidence === "measured").map((p) => p.id);
    expect(measured).toEqual(["mxroute"]);
  });

  it("never lists a preset as measured: only Dovecot ran that code", () => {
    for (const id of PRESET_SERVERS) {
      expect(PROVIDERS.find((p) => p.id === id)?.evidence).toBe("dovecot");
    }
  });
});
