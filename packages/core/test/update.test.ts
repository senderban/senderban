import { describe, expect, it } from "vitest";
import {
  LatestReleaseSchema,
  UPDATE_FIRST_DELAY_MS,
  UPDATE_INTERVAL_MS,
  UpdateStateSchema,
  isNewerVersion,
  jittered,
  startDelay,
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
    const state = { version: 1, nextAt: 0, etag: null, latest: null, notified: null };
    expect(UpdateStateSchema.safeParse(state).success).toBe(true);
    expect(UpdateStateSchema.safeParse({ ...state, url: "https://example.com" }).success).toBe(
      false,
    );
    expect(UpdateStateSchema.safeParse({ ...state, etag: "x".repeat(257) }).success).toBe(false);
  });
});

describe("startDelay", () => {
  const now = 10 * UPDATE_INTERVAL_MS;
  const none = () => 0;
  it("waits the first delay when a check is due, else until the stored time", () => {
    expect(startDelay(0, now, none)).toBe(UPDATE_FIRST_DELAY_MS);
    expect(startDelay(now + 5000, now, none)).toBe(UPDATE_FIRST_DELAY_MS);
    expect(startDelay(now + UPDATE_INTERVAL_MS - 1000, now, none)).toBe(UPDATE_INTERVAL_MS - 1000);
  });

  it("does not trust a clock set back or an edited file: at most one stretched interval", () => {
    expect(startDelay(now + 5 * UPDATE_INTERVAL_MS, now, none)).toBe(UPDATE_INTERVAL_MS * 1.25);
  });
});

describe("jittered", () => {
  it("stretches by 0 to 25 %, whatever the random source returns", () => {
    expect(jittered(1000, () => 0)).toBe(1000);
    expect(jittered(1000, () => 1)).toBe(1250);
    expect(jittered(1000, () => 7)).toBe(1250);
    expect(jittered(1000, () => -3)).toBe(1000);
  });
});
