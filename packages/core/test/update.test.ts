import { describe, expect, it } from "vitest";
import {
  LatestReleaseSchema,
  UPDATE_FIRST_DELAY_MS,
  UPDATE_INTERVAL_MS,
  UpdateStateSchema,
  isNewerVersion,
  nextCheckDelay,
} from "../src/update.js";

describe("isNewerVersion", () => {
  it.each([
    ["0.3.0", "0.2.9", true],
    ["0.10.0", "0.9.9", true],
    ["1.0.0", "0.99.99", true],
    ["0.2.0", "0.2.0", false],
    ["0.2.0", "0.3.0", false],
    ["0.3.0-beta", "0.2.0", false],
    ["v0.3.0", "0.2.0", false],
    ["", "0.2.0", false],
  ])("%s over %s: %s", (candidate, current, expected) => {
    expect(isNewerVersion(candidate, current)).toBe(expected);
  });
});

describe("LatestReleaseSchema", () => {
  it("keeps only the version, without the v", () => {
    expect(LatestReleaseSchema.parse({ tag_name: "v0.3.0", body: "notes", assets: [] })).toEqual({
      tag_name: "0.3.0",
    });
  });

  it.each([
    ["a pre-release tag", { tag_name: "v0.3.0-rc.1" }],
    ["a name, not a version", { tag_name: "latest" }],
    ["a tag past 32 characters", { tag_name: `v0.3.0${"0".repeat(40)}` }],
    ["no tag", { name: "Senderban 0.3.0" }],
    ["markup", { tag_name: "<b>0.3.0</b>" }],
  ])("refuses %s", (_name, value) => {
    expect(LatestReleaseSchema.safeParse(value).success).toBe(false);
  });
});

describe("UpdateStateSchema", () => {
  it("refuses a key that is not ours and an etag past 256 characters", () => {
    const state = { version: 1, checkedAt: 0, etag: null, latest: null, notified: null };
    expect(UpdateStateSchema.safeParse(state).success).toBe(true);
    expect(UpdateStateSchema.safeParse({ ...state, url: "https://example.com" }).success).toBe(
      false,
    );
    expect(UpdateStateSchema.safeParse({ ...state, etag: "x".repeat(257) }).success).toBe(false);
  });
});

describe("nextCheckDelay", () => {
  const now = 10 * UPDATE_INTERVAL_MS;
  it("waits the first delay when a check is due, and never asks twice a day", () => {
    expect(nextCheckDelay(0, now)).toBe(UPDATE_FIRST_DELAY_MS);
    expect(nextCheckDelay(now - 1000, now)).toBe(UPDATE_INTERVAL_MS - 1000);
    expect(nextCheckDelay(now, now)).toBe(UPDATE_INTERVAL_MS);
  });

  it("does not trust a clock set back: at most one interval", () => {
    expect(nextCheckDelay(now + 5 * UPDATE_INTERVAL_MS, now)).toBe(UPDATE_INTERVAL_MS);
  });
});
