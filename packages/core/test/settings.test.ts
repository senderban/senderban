import { describe, expect, it } from "vitest";
import { ACTIONS } from "../src/blocklist.js";
import {
  DEFAULT_ACTIONS,
  DEFAULT_SETTINGS,
  SettingsFileSchema,
  SettingsSchema,
} from "../src/settings.js";

describe("SettingsSchema", () => {
  it("takes its own defaults", () => {
    expect(SettingsSchema.safeParse(DEFAULT_SETTINGS).success).toBe(true);
  });

  it("never lets a default action be the one that keeps no copy (ADR 0008)", () => {
    expect(ACTIONS).toContain("reject");
    expect(DEFAULT_ACTIONS).not.toContain("reject");
    expect(SettingsSchema.safeParse({ ...DEFAULT_SETTINGS, defaultAction: "reject" }).success).toBe(
      false,
    );
  });

  it("refuses an unknown key", () => {
    expect(SettingsSchema.safeParse({ ...DEFAULT_SETTINGS, x: 1 }).success).toBe(false);
  });

  it("refuses a file of another version", () => {
    const file = { version: 2, settings: DEFAULT_SETTINGS };
    expect(SettingsFileSchema.safeParse(file).success).toBe(false);
  });
});
