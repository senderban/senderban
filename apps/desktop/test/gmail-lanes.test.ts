import { describe, expect, it, vi } from "vitest";
import { AdapterError, GmailBudgets, gmailLaneId, initialGmailState } from "@senderban/core";
import type { AccountConfig, BlockEntry, OAuthClient, OpaqueState } from "@senderban/core";
import { FakeGmail } from "../../../packages/core/test/gmail/fake-gmail.js";
import {
  ACCESS_TOKEN_MARGIN_MS,
  buildGmailLanes,
  createAccessTokenSource,
  gmailLogTag,
  gmailMissNote,
  gmailSkippedNote,
} from "../src/gmail-lanes.js";
import type { GmailSkipped } from "../src/gmail-lanes.js";

const SECOND = 1_000;

const clock = (start = Date.UTC(2026, 9, 27, 12, 0, 0)) => {
  const state = { t: start };
  return { now: () => state.t, advance: (ms: number) => (state.t += ms) };
};

function fakeOAuth(token = "ya29.fake-access-token", expiresInSeconds = 3_599) {
  const refresh = vi.fn<
    (refreshToken: string) => Promise<{ accessToken: string; expiresInSeconds: number }>
  >(() => Promise.resolve({ accessToken: token, expiresInSeconds }));
  return { oauth: { refresh } as unknown as OAuthClient, refresh };
}

describe("createAccessTokenSource", () => {
  it("renews once for any number of calls at the same time, then serves the cache until a minute before the end", async () => {
    const c = clock();
    const { oauth, refresh } = fakeOAuth();
    const refreshToken = vi.fn(() => Promise.resolve("1//the-refresh-token"));
    const token = createAccessTokenSource({ oauth, refreshToken, now: c.now });
    const got = await Promise.all([token(), token(), token(), token()]);
    expect(new Set(got).size).toBe(1);
    expect(refresh).toHaveBeenCalledTimes(1);
    expect(refreshToken).toHaveBeenCalledTimes(1);
    c.advance(3_599 * SECOND - ACCESS_TOKEN_MARGIN_MS - 1);
    await token();
    expect(refresh).toHaveBeenCalledTimes(1);
    c.advance(1);
    await token();
    // The exact moment the cache ends is already too late to use it.
    expect(refresh).toHaveBeenCalledTimes(2);
  });

  it("does not keep a failure: the next call asks again, and every waiter of the failed renewal sees the failure", async () => {
    const c = clock();
    const refresh = vi
      .fn<(t: string) => Promise<{ accessToken: string; expiresInSeconds: number }>>()
      .mockRejectedValueOnce(new Error("offline"))
      .mockResolvedValue({ accessToken: "ya29.second", expiresInSeconds: 3_599 });
    const token = createAccessTokenSource({
      oauth: { refresh } as unknown as OAuthClient,
      refreshToken: () => Promise.resolve("1//t"),
      now: c.now,
    });
    const settled = await Promise.allSettled([token(), token()]);
    expect(settled.map((s) => s.status)).toEqual(["rejected", "rejected"]);
    expect(refresh).toHaveBeenCalledTimes(1);
    await expect(token()).resolves.toBe("ya29.second");
  });

  it("does not cache a token that Google gives for less than the margin", async () => {
    const c = clock();
    const { oauth, refresh } = fakeOAuth("ya29.short", 30);
    const token = createAccessTokenSource({
      oauth,
      refreshToken: () => Promise.resolve("1//t"),
      now: c.now,
    });
    await token();
    await token();
    expect(refresh).toHaveBeenCalledTimes(2);
  });
});

const gmailAccount = (id: string, email: string, gmail: Record<string, unknown> = {}) =>
  ({
    id,
    gmail: { email, refreshCipher: "Y2lwaGVy", ...gmail },
  }) as unknown as AccountConfig;
const imapAccount = { id: "imap1", imap: { user: "me@example.com" } } as unknown as AccountConfig;

function deps(
  accounts: AccountConfig[],
  over: Partial<Parameters<typeof buildGmailLanes>[0]> = {},
) {
  const logs: { event: string; fields: unknown }[] = [];
  const saved: { laneId: string; state: OpaqueState }[] = [];
  const c = clock();
  const { oauth, refresh } = fakeOAuth();
  const budgets = new GmailBudgets({ now: c.now });
  const built: Parameters<typeof buildGmailLanes>[0] = {
    accounts,
    oauth,
    budgets,
    saveState: (laneId, state) => saved.push({ laneId, state }),
    decrypt: () => Promise.resolve("1//the-refresh-token"),
    log: (event, fields) => logs.push({ event, fields }),
    now: c.now,
    ...over,
  };
  return { built, logs, saved, refresh, budgets, c };
}

const entry = (value: string): BlockEntry => ({
  id: crypto.randomUUID(),
  match: "exactAddress",
  value,
  action: "trash",
  createdAt: "2026-10-27T12:00:00.000Z",
});

describe("buildGmailLanes", () => {
  it("makes one lane for each signed-in Gmail account and none for an IMAP account", () => {
    const { built, logs } = deps([
      imapAccount,
      gmailAccount("g1", "me@gmail.com"),
      gmailAccount("g2", "you@gmail.com"),
    ]);
    const { lanes } = buildGmailLanes(built);
    expect(lanes.map((l) => l.laneId)).toEqual([gmailLaneId("g1"), gmailLaneId("g2")]);
    expect(lanes.map((l) => l.email)).toEqual(["me@gmail.com", "you@gmail.com"]);
    expect(logs.map((l) => l.event)).toEqual(["gmail-lane", "gmail-lane"]);
  });

  it("leaves out, with a fixed reason, an account with no token, an expired one, and every account while no client is set up", () => {
    const c = clock();
    const past = Math.floor(c.now() / 1000) - 10;
    const accounts = [
      gmailAccount("g1", "me@gmail.com", { refreshCipher: undefined }),
      gmailAccount("g2", "you@gmail.com", { accessEndsAt: past }),
      gmailAccount("g3", "ok@gmail.com", { accessEndsAt: past + 10_000 }),
    ];
    const a = deps(accounts, { now: c.now });
    const builtA = buildGmailLanes(a.built);
    expect(builtA.lanes.map((l) => l.accountId)).toEqual(["g3"]);
    expect(builtA.skipped.map((s) => [s.accountId, s.reason])).toEqual([
      ["g1", "signed-out"],
      ["g2", "expired"],
    ]);
    expect(
      a.logs
        .filter((l) => l.event === "gmail-lane-skipped")
        .map((l) => (l.fields as { reason: string }).reason),
    ).toEqual(["signed-out", "expired"]);
    const b = deps(accounts, { oauth: null });
    const builtB = buildGmailLanes(b.built);
    expect(builtB.lanes).toEqual([]);
    expect(builtB.skipped).toHaveLength(3);
    expect(b.logs.every((l) => (l.fields as { reason: string }).reason === "no-client")).toBe(true);
  });

  it("writes nothing and asks Google for nothing until a round has something to do", async () => {
    const { built, refresh } = deps([gmailAccount("g1", "me@gmail.com")]);
    const [lane] = buildGmailLanes(built).lanes;
    const plan = await lane?.adapter.plan([], initialGmailState());
    expect(plan?.changes).toEqual([]);
    expect(refresh).not.toHaveBeenCalled();
  });

  it("runs a round: saves the state under its lane id while it works, shares one budget, and logs no address, filter id or token", async () => {
    const fake = new FakeGmail();
    const a = deps([gmailAccount("g1", "me@gmail.com"), gmailAccount("g2", "you@gmail.com")], {
      fetch: fake.fetch,
    });
    const { lanes } = buildGmailLanes(a.built);
    const [first, second] = lanes;
    if (first === undefined || second === undefined) throw new Error("lanes missing");
    const list = [entry("spam@secret-sender.example")];
    const result = await first.adapter.apply(await first.adapter.plan(list, initialGmailState()));
    expect(result.applied).toBe(1);
    expect(fake.filters.size).toBe(1);
    expect(a.saved.length).toBeGreaterThan(0);
    expect(new Set(a.saved.map((s) => s.laneId))).toEqual(new Set([first.laneId]));
    // One budget for the app: what the first lane spent is gone from the all-accounts line the second lane sees.
    const spent = fake.units;
    expect(a.budgets.remaining(second.laneId).allAccountsDay).toBe(100_000 - spent);
    const text = JSON.stringify(a.logs);
    for (const leak of [
      "secret-sender",
      "me@gmail.com",
      "ya29.",
      "1//",
      "Y2lwaGVy",
      ...fake.filters.keys(),
    ]) {
      expect(text).not.toContain(leak);
    }
    expect(a.logs.some((l) => l.event === "gmail-http")).toBe(true);
    expect(a.logs.some((l) => l.event === "gmail-call")).toBe(true);
  });

  it("tags an account for the log without the address, whatever its id looks like", () => {
    for (const id of ["g1", "me@gmail.com", "Main_Account", "x".repeat(64), "has.dots"]) {
      expect(gmailLogTag(id)).toMatch(/^[a-z0-9-]{1,64}$/u);
    }
    expect(gmailLogTag("me@gmail.com")).not.toContain("gmail");
  });
});

describe("gmailMissNote", () => {
  const e = (
    value: string,
    match: BlockEntry["match"],
    action: BlockEntry["action"],
  ): BlockEntry => ({
    ...entry(value),
    match,
    action,
  });
  it("is empty for a single address sent to Trash that a Gmail filter can hold, and for a sender not in the list", () => {
    expect(gmailMissNote([e("a@spam.example", "exactAddress", "trash")], "a@spam.example")).toBe(
      "",
    );
    expect(gmailMissNote([], "a@spam.example")).toBe("");
  });
  it("says so for an address form the query contract refuses", () => {
    expect(
      gmailMissNote([e("-x@spam.example", "exactAddress", "trash")], "-x@spam.example"),
    ).toContain("address form");
  });
  it("says so for Junk (use Trash), a whole domain (single addresses only) and a refusal at the server", () => {
    expect(
      gmailMissNote([e("a@spam.example", "exactAddress", "junk")], "a@spam.example"),
    ).toContain("no Junk filter");
    expect(
      gmailMissNote([e("a@spam.example", "exactAddress", "reject")], "a@spam.example"),
    ).toContain("no Junk filter");
    expect(gmailMissNote([e("spam.example", "subdomains", "trash")], "spam.example")).toContain(
      "single addresses only",
    );
  });
});

describe("gmailSkippedNote", () => {
  const skip = (n: number, reason: GmailSkipped["reason"] = "signed-out"): GmailSkipped => ({
    accountId: `g${String(n)}`,
    email: `u${String(n)}@gmail.com`,
    reason,
  });
  it("is empty when every Gmail account has a lane, and names the account and why when one has not", () => {
    expect(gmailSkippedNote([])).toBe("");
    expect(gmailSkippedNote([skip(1, "expired")])).toBe(
      " Gmail not updated: u1@gmail.com (its access has ended).",
    );
  });
  it("names two accounts and counts the rest", () => {
    expect(gmailSkippedNote([skip(1), skip(2), skip(3), skip(4)])).toBe(
      " Gmail not updated: u1@gmail.com (it is signed out); u2@gmail.com (it is signed out) (+2 more).",
    );
  });
});

describe("a lane id that another lane already holds", () => {
  it("leaves the Gmail account out (it must not stop the app) and builds the others", () => {
    const { built, logs } = deps(
      [gmailAccount("me", "me@gmail.com"), gmailAccount("you", "you@gmail.com")],
      { reservedLaneIds: new Set([gmailLaneId("me")]) },
    );
    const result = buildGmailLanes(built);
    expect(result.lanes.map((l) => l.accountId)).toEqual(["you"]);
    expect(result.skipped).toEqual([{ accountId: "me", email: "me@gmail.com", reason: "lane-id" }]);
    expect(logs.find((l) => l.event === "gmail-lane-skipped")?.fields).toEqual({
      account: "me",
      reason: "lane-id",
    });
  });
  it("tells an unreadable client file from none", () => {
    const { built, logs } = deps([gmailAccount("g1", "me@gmail.com")], {
      oauth: null,
      noClientReason: "client-unreadable",
    });
    expect(buildGmailLanes(built).skipped[0]?.reason).toBe("client-unreadable");
    expect(logs[0]?.fields).toMatchObject({ reason: "client-unreadable" });
  });
});

describe("errors of the token path reach the engine with their class", () => {
  async function applyWith(over: Partial<Parameters<typeof buildGmailLanes>[0]>) {
    const fake = new FakeGmail();
    const { built } = deps([gmailAccount("g1", "me@gmail.com")], { fetch: fake.fetch, ...over });
    const [lane] = buildGmailLanes(built).lanes;
    if (lane === undefined) throw new Error("no lane");
    const plan = await lane.adapter.plan([entry("a@spam.example")], initialGmailState());
    return { run: () => lane.adapter.apply(plan), fake };
  }
  const refusing = (error: Error) =>
    ({
      refresh: () => Promise.reject(error),
    }) as unknown as OAuthClient;

  it("keeps AUTH_REQUIRED (a revoked sign-in is not retried as if it were passing) and QUOTA_EXCEEDED", async () => {
    for (const code of ["AUTH_REQUIRED", "QUOTA_EXCEEDED"] as const) {
      const { run, fake } = await applyWith({
        oauth: refusing(new AdapterError(code, "refused")),
      });
      if (code === "AUTH_REQUIRED") await expect(run()).rejects.toMatchObject({ code });
      else await expect(run()).resolves.toMatchObject({ applied: 0 });
      expect(fake.calls).toHaveLength(0);
    }
  });
  it("makes a decrypt that fails TRANSIENT, whatever it throws, and sends nothing", async () => {
    const { run, fake } = await applyWith({
      decrypt: () => Promise.reject(new Error("secret in this message 1//refresh")),
    });
    await expect(run()).rejects.toMatchObject({ code: "TRANSIENT" });
    const error = (await run().catch((e: unknown) => e)) as Error;
    expect(error.message).not.toContain("secret");
    expect(error.message).not.toContain("1//");
    expect(fake.calls).toHaveLength(0);
  });
  it("decrypts when a token is renewed, not when the lane is built", async () => {
    const decrypt = vi.fn(() => Promise.resolve("1//the-refresh-token"));
    const fake = new FakeGmail();
    const { built } = deps([gmailAccount("g1", "me@gmail.com")], { fetch: fake.fetch, decrypt });
    const [lane] = buildGmailLanes(built).lanes;
    expect(decrypt).not.toHaveBeenCalled();
    const plan = await lane?.adapter.plan([entry("a@spam.example")], initialGmailState());
    expect(decrypt).not.toHaveBeenCalled();
    if (plan !== undefined) await lane?.adapter.apply(plan);
    expect(decrypt).toHaveBeenCalledTimes(1);
  });
});
