import { describe, expect, it, vi } from "vitest";
import {
  blockPending,
  blockableDomain,
  canRejectSender,
  isOwnMailbox,
} from "../../src/notify/block-action.js";
import type { BlockActionDeps } from "../../src/notify/block-action.js";
import type { BlockEntry } from "../../src/blocklist.js";
import { PendingBlocks } from "../../src/notify/pending.js";
import type { SyncOutcome, VerifyOutcome } from "../../src/sync/engine.js";

const ID = "0b1f2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d";

function setup(
  options: {
    outcome?: SyncOutcome;
    check?: VerifyOutcome;
    sender?: string;
    existing?: BlockEntry[];
    ownDomains?: string[];
    ownAddresses?: string[];
  } = {},
) {
  const outcome = options.outcome ?? { accountId: "a", status: "applied", applied: 1, failed: 0 };
  const check = options.check ?? { accountId: "a", status: "verified" };
  const pending = new PendingBlocks({ newId: () => ID });
  const existing: BlockEntry[] = options.existing ?? [];
  const add = vi.fn((input: unknown) => {
    const wanted = input as BlockEntry;
    const same = existing.find((e) => e.match === wanted.match && e.value === wanted.value);
    return same === undefined
      ? { ok: true as const, entry: wanted, added: true }
      : { ok: true as const, entry: same, added: false };
  });
  const list = vi.fn(() => existing);
  const sync = vi.fn(() => Promise.resolve(outcome));
  const verify = vi.fn(() => Promise.resolve(check));
  const requestSync = vi.fn();
  const deps: BlockActionDeps = {
    pending,
    store: { add, list },
    engine: { sync, requestSync, verify },
    own: {
      domains: new Set(options.ownDomains ?? []),
      addresses: new Set(options.ownAddresses ?? []),
    },
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

describe("blockPending action", () => {
  it("files into Junk unless Trash is chosen", async () => {
    const junk = setup();
    await blockPending(junk.deps, ID, "address");
    expect(junk.add).toHaveBeenCalledWith(expect.objectContaining({ action: "junk" }));

    const trash = setup();
    await blockPending(trash.deps, ID, "domain", "trash");
    expect(trash.add).toHaveBeenCalledWith(
      expect.objectContaining({ action: "trash", match: "subdomains", value: "news.example.com" }),
    );
  });
});

describe("blockPending when a rule already exists", () => {
  const entry = (match: BlockEntry["match"], value: string, action: BlockEntry["action"]) => ({
    id: "22222222-2222-4222-8222-222222222222",
    match,
    value,
    action,
    createdAt: "2026-10-24T00:00:00.000Z",
  });

  it("says where mail really goes when the same target is on the other action", async () => {
    const { deps, sync } = setup({
      existing: [entry("exactAddress", "spam@news.example.com", "junk")],
    });
    const result = await blockPending(deps, ID, "address", "trash");
    expect(result).toEqual({
      status: "already-blocked",
      target: "spam@news.example.com",
      action: "junk",
    });
    expect(sync).not.toHaveBeenCalled();
  });

  it("does not report Trash for an address under a domain that is already on Junk", async () => {
    const { deps, add } = setup({ existing: [entry("subdomains", "example.com", "junk")] });
    const result = await blockPending(deps, ID, "address", "trash");
    expect(result).toEqual({ status: "already-blocked", target: "example.com", action: "junk" });
    expect(add).not.toHaveBeenCalled();
  });

  it("lets a Junk choice through even when Trash covers it, because Junk is written first", async () => {
    const { deps } = setup({ existing: [entry("subdomains", "example.com", "trash")] });
    const result = await blockPending(deps, ID, "address", "junk");
    expect(result).toMatchObject({ status: "blocked", action: "junk" });
  });

  it("stores a refused address as a reject entry", async () => {
    const { deps, add } = setup();
    const result = await blockPending(deps, ID, "address", "reject");
    expect(result).toMatchObject({ status: "blocked", action: "reject" });
    expect(add).toHaveBeenCalledWith(expect.objectContaining({ action: "reject" }));
  });

  it("never stores a whole domain as a reject entry, whatever the caller passes", async () => {
    const { deps, add } = setup();
    const result = await blockPending(deps, ID, "domain", "reject");
    expect(result).toMatchObject({ status: "refused" });
    expect(add).not.toHaveBeenCalled();
  });

  it("does not report Trash for an address that is already refused, because its backup rule is Junk", async () => {
    const { deps, add } = setup({
      existing: [entry("exactAddress", "spam@news.example.com", "reject")],
    });
    const result = await blockPending(deps, ID, "address", "trash");
    expect(result).toEqual({
      status: "already-blocked",
      target: "spam@news.example.com",
      action: "reject",
    });
    expect(add).not.toHaveBeenCalled();
  });

  it("never refuses an address on the person's own mail domain: a forged From would bounce real mail", async () => {
    const { deps, add } = setup({
      sender: "colleague@example.com",
      ownDomains: ["example.com"],
    });
    const result = await blockPending(deps, ID, "address", "reject");
    expect(result).toMatchObject({ status: "refused" });
    expect(add).not.toHaveBeenCalled();
  });

  it("treats a subdomain of an own domain as own, and a lookalike domain as someone else", () => {
    const own = { domains: new Set(["example.com"]), addresses: new Set<string>() };
    expect(canRejectSender("a@mail.example.com", own)).toBe(false);
    expect(canRejectSender("a@example.com", own)).toBe(false);
    expect(canRejectSender("a@notexample.com", own)).toBe(true);
    expect(canRejectSender("a@example.com.evil.example", own)).toBe(true);
  });

  it("reads Gmail's other spellings of the person's own inbox as the person's own", () => {
    // `own.addresses` holds the mailbox key (what `collectOwnMail` stores): the dotless, tagless gmail.com form.
    const own = { domains: new Set<string>(), addresses: new Set(["me@gmail.com"]) };
    for (const forged of [
      "m.e@gmail.com",
      "me+x@gmail.com",
      "me@googlemail.com",
      "M.E@Gmail.com",
    ]) {
      expect(canRejectSender(forged, own)).toBe(false);
    }
    expect(canRejectSender("me2@gmail.com", own)).toBe(true);
    // A non-Gmail address with a dot is a different address: only exact matches count there.
    const other = { domains: new Set<string>(), addresses: new Set(["me@example.com"]) };
    expect(canRejectSender("m.e@example.com", other)).toBe(true);
  });

  it("never refuses the person's own address, even on a freemail domain, but not the rest of that domain", () => {
    const own = { domains: new Set<string>(), addresses: new Set(["me@gmail.com"]) };
    expect(canRejectSender("me@gmail.com", own)).toBe(false);
    expect(canRejectSender("ME@Gmail.com", own)).toBe(false);
    expect(canRejectSender("someone@gmail.com", own)).toBe(true);
  });

  it("refuses an address the blacklist cannot take as a single entry", () => {
    const none = { domains: new Set<string>(), addresses: new Set<string>() };
    for (const sender of [
      "*@gmail.com",
      "o'brien@example.com",
      "a/b@example.com",
      "a%20b@example.com",
      "@example.com",
    ]) {
      expect(canRejectSender(sender, none)).toBe(false);
    }
    expect(canRejectSender("ok+tag@example.com", none)).toBe(true);
  });

  it("still lets an own-domain address go to Junk", async () => {
    const { deps } = setup({ sender: "colleague@example.com", ownDomains: ["example.com"] });
    const result = await blockPending(deps, ID, "address", "junk");
    expect(result).toMatchObject({ status: "blocked", action: "junk" });
  });

  it("ignores an unrelated Junk rule", async () => {
    const { deps } = setup({ existing: [entry("subdomains", "other.org", "junk")] });
    const result = await blockPending(deps, ID, "address", "trash");
    expect(result).toMatchObject({ status: "blocked", action: "trash" });
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
      accountId: "a",
      otherAccounts: 1,
    });
  });

  it("says that only the clicked account was read back when others were merely queued", async () => {
    const { deps } = setup();
    const result = await blockPending({ ...deps, accountIds: ["a", "b", "c"] }, ID, "address");
    expect(result).toMatchObject({ status: "blocked", verified: true, otherAccounts: 2 });
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

describe("isOwnMailbox", () => {
  const own = { addresses: new Set(["me@gmail.com"]), domains: new Set(["mycompany.com"]) };
  it("is the person's own mailbox by its key (dots, plus tag, googlemail), and not a domain or a stranger", () => {
    expect(isOwnMailbox("me@gmail.com", own)).toBe(true);
    expect(isOwnMailbox("M.E+news@googlemail.com", own)).toBe(true);
    expect(isOwnMailbox("boss@mycompany.com", own)).toBe(false);
    expect(isOwnMailbox("you@gmail.com", own)).toBe(false);
  });
});
