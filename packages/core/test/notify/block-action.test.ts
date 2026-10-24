import { describe, expect, it, vi } from "vitest";
import { handleBlockActivation } from "../../src/notify/block-action.js";
import type { BlockActionDeps } from "../../src/notify/block-action.js";
import { PendingBlocks } from "../../src/notify/pending.js";
import type { SyncOutcome } from "../../src/sync/engine.js";

const ID = "0b1f2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d";
const click = (tag: string) => ({
  type: "action",
  actionIndex: 0,
  arguments: `type=action&action=0&tag=${tag}`,
});

function setup(
  outcome: SyncOutcome = { accountId: "a", status: "applied", applied: 1, failed: 0 },
) {
  const pending = new PendingBlocks({ newId: () => ID });
  const add = vi.fn((input: unknown) => ({
    ok: true as const,
    entry: input as never,
    added: true,
  }));
  const sync = vi.fn(() => Promise.resolve(outcome));
  const requestSync = vi.fn();
  const say = vi.fn();
  const deps: BlockActionDeps = {
    pending,
    store: { add },
    engine: { sync, requestSync },
    accountIds: ["a", "b"],
    say,
    newId: () => "11111111-1111-4111-8111-111111111111",
    now: () => new Date("2026-10-25T00:00:00Z"),
  };
  pending.add({ accountId: "a", sender: "spam@example.com" });
  return { deps, add, sync, requestSync, say };
}

describe("handleBlockActivation", () => {
  it("adds an exact-address junk entry and syncs the clicked account, then the others", async () => {
    const { deps, add, sync, requestSync, say } = setup();
    await handleBlockActivation(deps, click(ID));
    expect(add).toHaveBeenCalledExactlyOnceWith({
      id: "11111111-1111-4111-8111-111111111111",
      match: "exactAddress",
      value: "spam@example.com",
      action: "junk",
      createdAt: "2026-10-25T00:00:00.000Z",
    });
    expect(sync).toHaveBeenCalledExactlyOnceWith("a");
    expect(requestSync.mock.calls).toEqual([["b"]]);
    expect(say.mock.calls[0]?.[0]).toBe("Sender blocked");
  });

  it("one click delivered twice blocks once, even when both arrive before the first finishes", async () => {
    const { deps, add, sync, say } = setup();
    const results = await Promise.all([
      handleBlockActivation(deps, click(ID)),
      handleBlockActivation(deps, click(ID)),
    ]);
    expect(results.sort()).toEqual(["blocked", "duplicate"]);
    expect(add).toHaveBeenCalledTimes(1);
    expect(sync).toHaveBeenCalledTimes(1);
    expect(say).toHaveBeenCalledTimes(1);
  });

  it("ignores a click on the toast body, another button and a foreign tag", async () => {
    const { deps, add, say } = setup();
    await handleBlockActivation(deps, { ...click(ID), type: "click" });
    await handleBlockActivation(deps, { ...click(ID), actionIndex: 1 });
    await handleBlockActivation(deps, { type: "action", actionIndex: 0, arguments: "tag=evil" });
    expect(add).not.toHaveBeenCalled();
    expect(say).not.toHaveBeenCalled();
  });

  it("tells the user when the id is unknown (expired or app restarted)", async () => {
    const { deps, add, say } = setup();
    await handleBlockActivation(deps, click("00000000-0000-4000-8000-000000000000"));
    expect(add).not.toHaveBeenCalled();
    expect(say.mock.calls[0]?.[1]).toContain("expired");
  });

  it("reports a failed rule write instead of claiming success", async () => {
    const { deps, say } = setup({
      accountId: "a",
      status: "failed",
      code: "AUTH_REQUIRED",
      message: "bad login",
    });
    await handleBlockActivation(deps, click(ID));
    expect(say.mock.calls[0]?.[0]).toBe("Block not applied");
    expect(say.mock.calls[0]?.[1]).toContain("AUTH_REQUIRED");
  });

  it("reports a refused entry and does not sync", async () => {
    const { deps, add, sync, say } = setup();
    add.mockReturnValueOnce({ ok: false, reason: "block list is full" } as never);
    await handleBlockActivation(deps, click(ID));
    expect(sync).not.toHaveBeenCalled();
    expect(say.mock.calls[0]?.[0]).toBe("Could not block");
  });
});
