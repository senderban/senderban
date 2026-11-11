import { PendingBlocks } from "@senderban/core";
import { describe, expect, it } from "vitest";
import { restoreClicked } from "../src/restore-click.js";

const ID = "0f8fad5b-d9cb-469f-a165-70867728950e";
const HOUR = 3_600_000;
const restore = { accountId: "main", sender: "news@example.com", issuedAt: 9 * 3_600 };

describe("restoreClicked", () => {
  it("puts a click's block back for an account this run still has", () => {
    const pending = new PendingBlocks({ now: () => 10 * HOUR });
    expect(restoreClicked(pending, ["main"], ID, restore)).toBe("restored");
    expect(pending.consume(ID)).toEqual({
      status: "ok",
      block: { accountId: "main", sender: "news@example.com" },
    });
  });

  it("says none for a click with no tail, and leaves the table alone", () => {
    const pending = new PendingBlocks({ now: () => 10 * HOUR });
    expect(restoreClicked(pending, ["main"], ID, undefined)).toBe("none");
    expect(pending.size).toBe(0);
  });

  it("answers an account the person removed as it would for a toast of this run: unknown, nothing claimable", () => {
    const pending = new PendingBlocks({ now: () => 10 * HOUR });
    expect(restoreClicked(pending, ["other"], ID, restore)).toBe("no-account");
    expect(pending.consume(ID)).toEqual({ status: "unknown" });
  });

  it("says refused when the table will not take it back (issued after this run began)", () => {
    const pending = new PendingBlocks({ now: () => 10 * HOUR });
    const late = { ...restore, issuedAt: 11 * 3_600 };
    expect(restoreClicked(pending, ["main"], ID, late)).toBe("refused");
    expect(pending.size).toBe(0);
  });
});
