import { describe, expect, it, vi } from "vitest";
import { isEntryId, unblock } from "../../src/notify/unblock.js";
import type { UnblockDeps } from "../../src/notify/unblock.js";
import type { SyncOutcome, VerifyOutcome } from "../../src/sync/engine.js";

const ID = "0b1f2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d";

function setup(
  options: {
    removed?: boolean;
    sync?: (id: string) => Promise<SyncOutcome>;
    verify?: (id: string) => Promise<VerifyOutcome>;
  } = {},
) {
  const remove = vi.fn(() => options.removed ?? true);
  const applied = (id: string): Promise<SyncOutcome> =>
    Promise.resolve({ accountId: id, status: "applied", applied: 1, failed: 0 });
  const verified = (id: string): Promise<VerifyOutcome> =>
    Promise.resolve({ accountId: id, status: "verified" });
  const sync = vi.fn(options.sync ?? applied);
  const verify = vi.fn(options.verify ?? verified);
  const deps: UnblockDeps = { store: { remove }, engine: { sync, verify }, accountIds: ["a", "b"] };
  return { deps, remove, sync, verify };
}

describe("unblock", () => {
  it("removes the entry, then syncs and reads back every account", async () => {
    const { deps, remove, sync, verify } = setup();
    const result = await unblock(deps, ID);
    expect(remove).toHaveBeenCalledExactlyOnceWith(ID);
    expect(sync.mock.calls).toEqual([["a"], ["b"]]);
    expect(verify.mock.calls).toEqual([["a"], ["b"]]);
    expect(result).toEqual({
      status: "unblocked",
      accounts: [
        { accountId: "a", confirmed: true, detail: "read back from the provider" },
        { accountId: "b", confirmed: true, detail: "read back from the provider" },
      ],
    });
  });

  it("an id that is not on the list touches no provider", async () => {
    const { deps, sync, verify } = setup({ removed: false });
    expect(await unblock(deps, ID)).toEqual({ status: "unknown" });
    expect(sync).not.toHaveBeenCalled();
    expect(verify).not.toHaveBeenCalled();
  });

  it("a value that is not a UUID never reaches the store", async () => {
    const { deps, remove } = setup();
    expect(await unblock(deps, "1 OR 1=1")).toEqual({ status: "unknown" });
    expect(remove).not.toHaveBeenCalled();
  });

  it("a failed sync is reported for that account only and is not read back", async () => {
    const { deps, verify } = setup({
      sync: (id) =>
        Promise.resolve(
          id === "a"
            ? { accountId: id, status: "failed", code: "AUTH_REQUIRED", message: "bad login" }
            : { accountId: id, status: "unchanged" },
        ),
    });
    const result = await unblock(deps, ID);
    if (result.status !== "unblocked") throw new Error("expected unblocked");
    expect(result.accounts[0]).toMatchObject({ accountId: "a", confirmed: false });
    expect(result.accounts[0]?.detail).toContain("AUTH_REQUIRED");
    expect(result.accounts[1]).toMatchObject({ accountId: "b", confirmed: true });
    expect(verify.mock.calls).toEqual([["b"]]);
  });

  it("a read-back that differs or fails is not confirmed", async () => {
    const drifted = setup({
      verify: (id) =>
        Promise.resolve({ accountId: id, status: "drifted", detail: "rule still there" }),
    });
    const result = await unblock(drifted.deps, ID);
    if (result.status !== "unblocked") throw new Error("expected unblocked");
    expect(result.accounts.every((a) => !a.confirmed)).toBe(true);
    expect(result.accounts[0]?.detail).toContain("rule still there");
  });

  it("accounts run in parallel: a slow one does not hold up the other", async () => {
    const order: string[] = [];
    const { deps } = setup({
      sync: async (id) => {
        if (id === "a") await new Promise((r) => setTimeout(r, 30));
        order.push(id);
        return { accountId: id, status: "applied", applied: 1, failed: 0 };
      },
    });
    await unblock(deps, ID);
    expect(order).toEqual(["b", "a"]);
  });
});

describe("isEntryId", () => {
  it("accepts a UUID and nothing else", () => {
    expect(isEntryId(ID)).toBe(true);
    expect(isEntryId("")).toBe(false);
    expect(isEntryId(42)).toBe(false);
    expect(isEntryId(undefined)).toBe(false);
  });
});
