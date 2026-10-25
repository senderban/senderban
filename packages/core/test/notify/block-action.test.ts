import { describe, expect, it, vi } from "vitest";
import { blockPending, blockableDomain } from "../../src/notify/block-action.js";
import type { BlockActionDeps } from "../../src/notify/block-action.js";
import { PendingBlocks } from "../../src/notify/pending.js";
import type { SyncOutcome, VerifyOutcome } from "../../src/sync/engine.js";

const ID = "0b1f2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d";

function setup(
  options: {
    outcome?: SyncOutcome;
    check?: VerifyOutcome;
    sender?: string;
  } = {},
) {
  const outcome = options.outcome ?? { accountId: "a", status: "applied", applied: 1, failed: 0 };
  const check = options.check ?? { accountId: "a", status: "verified" };
  const pending = new PendingBlocks({ newId: () => ID });
  const add = vi.fn((input: unknown) => ({
    ok: true as const,
    entry: input as never,
    added: true,
  }));
  const sync = vi.fn(() => Promise.resolve(outcome));
  const verify = vi.fn(() => Promise.resolve(check));
  const requestSync = vi.fn();
  const deps: BlockActionDeps = {
    pending,
    store: { add },
    engine: { sync, requestSync, verify },
    accountIds: ["a", "b"],
    newId: () => "11111111-1111-4111-8111-111111111111",
    now: () => new Date("2026-10-25T00:00:00Z"),
  };
  pending.add({ accountId: "a", sender: options.sender ?? "spam@news.example.com" });
  return { deps, add, sync, verify, requestSync };
}

describe("blockableDomain", () => {
  it("offers the sender's own domain, and nothing for a freemail provider", () => {
    expect(blockableDomain("spam@news.example.com")).toBe("news.example.com");
    expect(blockableDomain("someone@gmail.com")).toBeNull();
    expect(blockableDomain("someone@mail.gmail.com")).toBeNull();
  });

  it("offers nothing for a country public suffix or a country freemail variant", () => {
    for (const sender of [
      "news@co.uk",
      "a@com.tr",
      "a@org.uk",
      "a@ac.jp",
      "x@hotmail.co.uk",
      "x@yahoo.co.jp",
    ]) {
      expect(blockableDomain(sender)).toBeNull();
    }
    expect(blockableDomain("a@shop.co.uk")).toBe("shop.co.uk");
  });
});

describe("blockPending", () => {
  it("scope address: exact-address junk entry, synced to the clicked account, then the others", async () => {
    const { deps, add, sync, requestSync, verify } = setup();
    const result = await blockPending(deps, ID, "address");
    expect(add).toHaveBeenCalledExactlyOnceWith({
      id: "11111111-1111-4111-8111-111111111111",
      match: "exactAddress",
      value: "spam@news.example.com",
      action: "junk",
      createdAt: "2026-10-25T00:00:00.000Z",
    });
    expect(sync).toHaveBeenCalledExactlyOnceWith("a");
    expect(requestSync.mock.calls).toEqual([["b"]]);
    expect(verify).toHaveBeenCalledExactlyOnceWith("a");
    expect(result).toMatchObject({
      status: "blocked",
      target: "spam@news.example.com",
      verified: true,
    });
  });

  it("scope domain: a subdomains entry for the sender's domain", async () => {
    const { deps, add } = setup();
    const result = await blockPending(deps, ID, "domain");
    expect(add.mock.calls[0]?.[0]).toMatchObject({
      match: "subdomains",
      value: "news.example.com",
    });
    expect(result).toMatchObject({ status: "blocked", target: "news.example.com" });
  });

  it("refuses a domain block for a freemail sender and writes nothing", async () => {
    const { deps, add, sync } = setup({ sender: "someone@gmail.com" });
    const result = await blockPending(deps, ID, "domain");
    expect(result.status).toBe("refused");
    expect(add).not.toHaveBeenCalled();
    expect(sync).not.toHaveBeenCalled();
  });

  it("one click delivered twice blocks once, even when both arrive before the first finishes", async () => {
    const { deps, add, sync } = setup();
    const results = await Promise.all([
      blockPending(deps, ID, "address"),
      blockPending(deps, ID, "address"),
    ]);
    expect(results.map((r) => r.status).sort()).toEqual(["blocked", "duplicate"]);
    expect(add).toHaveBeenCalledTimes(1);
    expect(sync).toHaveBeenCalledTimes(1);
  });

  it("reports an unknown id (expired or app restarted) without touching the list", async () => {
    const { deps, add } = setup();
    const result = await blockPending(deps, "00000000-0000-4000-8000-000000000000", "address");
    expect(result.status).toBe("unknown");
    expect(add).not.toHaveBeenCalled();
  });

  it("reports a failed rule write instead of claiming success, and does not read back", async () => {
    const { deps, verify } = setup({
      outcome: { accountId: "a", status: "failed", code: "AUTH_REQUIRED", message: "bad login" },
    });
    const result = await blockPending(deps, ID, "address");
    expect(result).toMatchObject({ status: "not-applied" });
    expect(result).toHaveProperty("detail", expect.stringContaining("AUTH_REQUIRED"));
    expect(verify).not.toHaveBeenCalled();
  });

  it("a written rule whose read-back differs or fails is blocked but not verified", async () => {
    const drifted = setup({
      check: { accountId: "a", status: "drifted", detail: "include missing" },
    });
    expect(await blockPending(drifted.deps, ID, "address")).toMatchObject({
      status: "blocked",
      verified: false,
    });
    const failed = setup({
      check: { accountId: "a", status: "failed", code: "TRANSIENT", message: "timeout" },
    });
    expect(await blockPending(failed.deps, ID, "address")).toMatchObject({
      status: "blocked",
      verified: false,
    });
  });

  it("reports a refused entry and does not sync", async () => {
    const { deps, add, sync } = setup();
    add.mockReturnValueOnce({ ok: false, reason: "block list is full" } as never);
    const result = await blockPending(deps, ID, "address");
    expect(result).toEqual({ status: "refused", detail: "block list is full" });
    expect(sync).not.toHaveBeenCalled();
  });
});
