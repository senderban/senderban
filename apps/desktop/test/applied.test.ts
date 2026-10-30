import { describe, expect, it, vi } from "vitest";
import { appliedFor, laneViewOf } from "../src/applied.js";
import type { LaneView } from "../src/applied.js";

const VALUE = "spam@attacker.example";
const view = (over: Partial<LaneView> = {}): LaneView => ({
  hasFolderLane: true,
  folderBehind: false,
  mxrouteBehind: false,
  gmailBehind: false,
  missing: false,
  refused: new Set(),
  ...over,
});
const junk = { value: VALUE, action: "junk", match: "exactAddress" } as const;
const reject = { value: VALUE, action: "reject", match: "exactAddress" } as const;

describe("laneViewOf", () => {
  const input = {
    entries: [junk],
    running: ["a", "a.mxroute", "g.gmail"],
    failed: [] as string[],
    mxroute: new Set(["a.mxroute"]),
    gmail: new Set(["g.gmail"]),
    settled: new Set(["g.gmail"]),
    skipped: false,
    refused: () => new Set([VALUE]),
  };

  it("sorts a failed lane by what it writes", () => {
    expect(laneViewOf({ ...input, failed: ["a"] }).folderBehind).toBe(true);
    expect(laneViewOf({ ...input, failed: ["a.mxroute"] })).toMatchObject({
      folderBehind: false,
      mxrouteBehind: true,
    });
  });

  it("holds a Gmail lane behind until its round says nothing is left to send", () => {
    expect(laneViewOf(input).gmailBehind).toBe(false);
    expect(laneViewOf({ ...input, settled: new Set() }).gmailBehind).toBe(true);
    expect(laneViewOf({ ...input, failed: ["g.gmail"] }).folderBehind).toBe(false);
  });

  it("carries a Gmail account that has no lane this session", () => {
    expect(laneViewOf({ ...input, skipped: true }).missing).toBe(true);
  });

  it("forgets a lane that failed and was removed", () => {
    expect(laneViewOf({ ...input, failed: ["gone"] }).folderBehind).toBe(false);
  });

  it("reads the MXroute states only for a list with a refusal", () => {
    const refused = vi.fn(() => new Set([VALUE]));
    expect(laneViewOf({ ...input, refused }).refused).toEqual(new Set());
    expect(refused).not.toHaveBeenCalled();
    expect(laneViewOf({ ...input, entries: [reject], refused }).refused).toEqual(new Set([VALUE]));
  });

  it("knows no folder lane on a Gmail-only device", () => {
    expect(laneViewOf({ ...input, running: ["g.gmail"] }).hasFolderLane).toBe(false);
  });
});

describe("appliedFor", () => {
  it("says yes for an entry whose lanes all worked", () => {
    expect(appliedFor(junk, false, null, view())).toEqual({ applied: "yes", atServer: false });
  });

  it("never says yes while a folder lane is behind", () => {
    expect(appliedFor(junk, false, null, view({ folderBehind: true })).applied).toBe("unknown");
  });

  it("asks a Gmail lane only about what a Gmail filter carries", () => {
    const behind = view({ gmailBehind: true });
    expect(appliedFor(junk, false, "trash", behind).applied).toBe("unknown");
    expect(appliedFor(junk, false, "no", behind).applied).toBe("yes");
  });

  it("calls a refusal real only when a running lane holds the address", () => {
    const held = view({ refused: new Set([VALUE]) });
    expect(appliedFor(reject, false, null, held)).toEqual({ applied: "yes", atServer: true });
    expect(appliedFor(reject, false, null, view())).toEqual({ applied: "yes", atServer: false });
  });

  it("does not trust a refusal over a lane that is behind or unreadable", () => {
    const behind = view({ refused: new Set([VALUE]), mxrouteBehind: true });
    expect(appliedFor(reject, false, null, behind)).toEqual({ applied: "unknown", atServer: true });
    expect(appliedFor(reject, false, null, view({ refused: null }))).toEqual({
      applied: "unknown",
      atServer: false,
    });
    // A Junk entry never reaches MXroute, so that lane has nothing to say about it.
    expect(appliedFor(junk, false, null, view({ mxrouteBehind: true })).applied).toBe("yes");
  });

  it("never says yes for a single address while a Gmail account has no lane", () => {
    const missing = view({ missing: true });
    expect(appliedFor(junk, false, null, missing).applied).toBe("unknown");
    const domain = { ...junk, value: "attacker.example", match: "subdomains" } as const;
    expect(appliedFor(domain, false, null, missing).applied).toBe("yes");
  });

  it("says no when no lane carries the entry", () => {
    expect(appliedFor(junk, false, "no", view({ hasFolderLane: false })).applied).toBe("no");
    expect(appliedFor(junk, false, "trash", view({ hasFolderLane: false })).applied).toBe("yes");
  });

  it("says no for the person's own mail, whatever the lanes did", () => {
    const held = view({ refused: new Set([VALUE]) });
    expect(appliedFor(reject, true, null, held)).toEqual({ applied: "no", atServer: false });
  });
});
