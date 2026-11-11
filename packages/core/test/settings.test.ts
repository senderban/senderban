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

describe("checkUpdates", () => {
  it("is required on a save, so a payload without it never turns the check on", () => {
    const rest: Partial<typeof DEFAULT_SETTINGS> = { ...DEFAULT_SETTINGS };
    delete rest.checkUpdates;
    expect(SettingsSchema.safeParse(rest).success).toBe(false);
  });

  it("defaults to on in a file written before 0.3", () => {
    const rest: Partial<typeof DEFAULT_SETTINGS> = { ...DEFAULT_SETTINGS };
    delete rest.checkUpdates;
    const parsed = SettingsFileSchema.safeParse({ version: 1, settings: rest });
    expect(parsed.success && parsed.data.settings.checkUpdates).toBe(true);
  });
});
