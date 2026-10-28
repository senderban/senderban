import { describe, expect, it, vi } from "vitest";
import {
  AdapterError,
  GmailBudgets,
  gmailLaneId,
  gmailStateHoldsFilters,
  initialGmailState,
} from "@senderban/core";
import type { AccountConfig, BlockEntry, OAuthClient, OpaqueState } from "@senderban/core";
import { SyncEngine } from "@senderban/core";
import { Store, openDatabase } from "@senderban/core/store";
import { FakeGmail } from "../../../packages/core/test/gmail/fake-gmail.js";
import {
  ACCESS_TOKEN_MARGIN_MS,
  buildGmailLanes,
  createAccessTokenSource,
  createGmailLifecycle,
  createHeldLanes,
  gmailLogTag,
  skippedAfterDone,
  gmailMissNote,
  gmailSkippedNote,
} from "../src/gmail-lanes.js";
import type { GmailLane, GmailSkipped } from "../src/gmail-lanes.js";

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

  it("gives up on a renewal that hangs, as a TRANSIENT, and the next call starts a fresh one", async () => {
    const refresh = vi
      .fn<(t: string) => Promise<{ accessToken: string; expiresInSeconds: number }>>()
      .mockImplementationOnce(() => new Promise(() => undefined))
      .mockResolvedValue({ accessToken: "ya29.after", expiresInSeconds: 3_599 });
    const token = createAccessTokenSource({
      oauth: { refresh } as unknown as OAuthClient,
      refreshToken: () => Promise.resolve("1//t"),
      renewDeadlineMs: 20,
    });
    const hung = await Promise.allSettled([token(), token()]);
    expect(hung.map((s) => s.status)).toEqual(["rejected", "rejected"]);
    for (const s of hung) {
      expect((s as PromiseRejectedResult).reason).toMatchObject({ code: "TRANSIENT" });
    }
    expect(refresh).toHaveBeenCalledTimes(1);
    await expect(token()).resolves.toBe("ya29.after");
  });

  it("also bounds the part before the request (a refresh token that cannot be read)", async () => {
    const refresh = vi.fn();
    const token = createAccessTokenSource({
      oauth: { refresh } as unknown as OAuthClient,
      refreshToken: () => new Promise(() => undefined),
      renewDeadlineMs: 20,
    });
    await expect(token()).rejects.toMatchObject({ code: "TRANSIENT" });
    expect(refresh).not.toHaveBeenCalled();
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
    // One line for each request (the HTTP status), not two: a refusal of our own limit is the only extra event.
    expect(a.logs.filter((l) => l.event === "gmail-http")).toHaveLength(fake.calls.length);
    expect(a.logs.some((l) => l.event === "gmail-call")).toBe(false);
  });

  it("a block of the person's own address is not written to Gmail", async () => {
    const fake = new FakeGmail();
    const a = deps([gmailAccount("g1", "me@gmail.com")], {
      fetch: fake.fetch,
      isOwn: (address) => address === "me@gmail.com",
    });
    const [lane] = buildGmailLanes(a.built).lanes;
    if (lane === undefined) throw new Error("no lane");
    const plan = await lane.adapter.plan(
      [entry("me@gmail.com"), entry("spam@spam.example")],
      initialGmailState(),
    );
    expect(plan.changes.map((c) => c.entry.value)).toEqual(["spam@spam.example"]);
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
  it("says so for the person's own address, ahead of the other reasons", () => {
    const own = (a: string) => a === "me@gmail.com";
    expect(
      gmailMissNote([e("me@gmail.com", "exactAddress", "trash")], "me@gmail.com", own),
    ).toContain("your own addresses");
    expect(
      gmailMissNote([e("a@spam.example", "exactAddress", "trash")], "a@spam.example", own),
    ).toBe("");
  });
  it("says so for an address form the query contract refuses", () => {
    expect(
      gmailMissNote([e("-x@spam.example", "exactAddress", "trash")], "-x@spam.example"),
    ).toContain("address form");
  });
  it("says a Junk or a refuse-at-server address goes to Trash on Gmail, nothing for Trash, and so for a whole domain", () => {
    for (const action of ["junk", "reject"] as const) {
      expect(gmailMissNote([e("a@spam.example", "exactAddress", action)], "a@spam.example")).toBe(
        " On Gmail it goes to Trash (Gmail has no Junk filter).",
      );
    }
    expect(gmailMissNote([e("a@spam.example", "exactAddress", "trash")], "a@spam.example")).toBe(
      "",
    );
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

describe("createGmailLifecycle (removal and sign-out)", () => {
  /** One lane that has placed `count` addresses (one filter) in a fake mailbox; the state lives in a map like the store. */
  async function rig(count = 3) {
    const fake = new FakeGmail();
    const states = new Map<string, OpaqueState>();
    const { built, logs } = deps([gmailAccount("g1", "me@gmail.com")], {
      fetch: fake.fetch,
      saveState: (id, state) => {
        states.set(id, state);
      },
    });
    const { lanes } = buildGmailLanes(built);
    const lane = lanes[0] as GmailLane;
    const list = Array.from({ length: count }, (_, i) => entry(`u${String(i)}@spam.example`));
    if (count > 0) {
      const result = await lane.adapter.apply(await lane.adapter.plan(list, initialGmailState()));
      states.set(lane.laneId, result.state);
    }
    const events: string[] = [];
    const done: { accountId: string; why: string; lane: GmailLane | undefined }[] = [];
    const lifecycle = createGmailLifecycle({
      skipReasonOf: () => undefined,
      lanes: new Map([[lane.accountId, lane]]),
      store: {
        getState: (id) => states.get(id),
        setState: (id, state) => {
          states.set(id, state);
        },
      },
      onHold: (id, held) => events.push(`hold:${id}:${String(held)}`),
      onResumed: (id) => events.push(`resumed:${id}`),
      onDone: (accountId, why, l) => done.push({ accountId, why, lane: l }),
      log: (event, fields) => logs.push({ event, fields }),
    });
    return { fake, lane, lifecycle, states, events, done, list, logs };
  }

  it("deletes every filter first, saves the empty state, and holds the lane still (a failed round, not a clean one)", async () => {
    const { fake, lane, lifecycle, states, list, events } = await rig();
    expect(fake.filters.size).toBe(1);
    expect(await lifecycle.prepare("g1")).toBe("ready");
    expect(fake.filters.size).toBe(0);
    const state = states.get(lane.laneId) as OpaqueState;
    expect(gmailStateHoldsFilters(state)).toBe(false);
    expect(events).toEqual([`hold:${lane.laneId}:true`]);
    // A block or an Unblock that fans out to the lane meanwhile fails visibly: it is never "done".
    await expect(lane.adapter.plan(list, state)).rejects.toMatchObject({ code: "TRANSIENT" });
  });

  it("abort lets the lane write again and asks it to catch up; done retires it for good", async () => {
    const { lane, lifecycle, events, done, list, states } = await rig();
    await lifecycle.prepare("g1");
    lifecycle.abort("g1");
    expect(events).toEqual([
      `hold:${lane.laneId}:true`,
      `hold:${lane.laneId}:false`,
      `resumed:${lane.laneId}`,
    ]);
    const state = states.get(lane.laneId) as OpaqueState;
    expect((await lane.adapter.plan(list, state)).changes).toHaveLength(3);
    lifecycle.done("g1", "signed-out");
    expect(done).toEqual([{ accountId: "g1", why: "signed-out", lane }]);
    // Done frees the hold too (the lane is gone from the app's lists, the hold must not outlive it).
    expect(events.at(-1)).toBe(`hold:${lane.laneId}:false`);
    expect((await lane.adapter.plan(list, state)).changes).toEqual([]);
  });

  it("answers filters-left, with what is left saved, when Google does not let the filters go", async () => {
    const { fake, lane, lifecycle, states, logs } = await rig();
    fake.forcedFor.set("DELETE", [503, 503, 503]);
    expect(await lifecycle.prepare("g1")).toBe("filters-left");
    expect(fake.filters.size).toBe(1);
    expect(gmailStateHoldsFilters(states.get(lane.laneId) as OpaqueState)).toBe(true);
    // And a second try, when Google answers, finishes the job.
    expect(await lifecycle.prepare("g1")).toBe("ready");
    expect(fake.filters.size).toBe(0);
    expect(JSON.stringify(logs)).not.toContain("spam.example");
  });

  it("answers filters-left when Gmail cannot be reached at all, and logs only a fixed word", async () => {
    const { fake, lifecycle, logs } = await rig();
    fake.failNetwork = 5;
    expect(await lifecycle.prepare("g1")).toBe("filters-left");
    const failed = logs.find((l) => l.event === "gmail-uninstall-failed");
    expect(failed?.fields).toEqual({ account: "g1", code: "TRANSIENT" });
  });

  it("is ready at once for an account that never wrote a filter, and not ready for one with filters but no lane", async () => {
    const empty = await rig(0);
    expect(await empty.lifecycle.prepare("g1")).toBe("ready");
    expect(empty.fake.calls).toHaveLength(0);

    const { lane, states } = await rig();
    const done: string[] = [];
    const laneless = createGmailLifecycle({
      skipReasonOf: () => undefined,
      lanes: new Map(),
      store: { getState: (id) => states.get(id), setState: () => undefined },
      onResumed: () => undefined,
      onDone: (accountId, why, l) =>
        done.push(`${accountId}:${why}:${l === undefined ? "no-lane" : "lane"}`),
      log: () => undefined,
    });
    expect(states.has(lane.laneId)).toBe(true);
    // No reason for the missing lane (a sign-in made after the start): a restart would give it one.
    expect(await laneless.prepare("g1")).toBe("restart-cures");
    expect(await laneless.prepare("other")).toBe("ready");
    // The app is told even when there was no lane: it prunes its own lists.
    laneless.done("g1", "removed");
    expect(done).toEqual(["g1:removed:no-lane"]);
  });

  it("classify does nothing: no hold, no network", async () => {
    const { fake, lane, lifecycle, events } = await rig();
    expect(lifecycle.classify("g1")).toBe("lane");
    expect(events).toEqual([]);
    const calls = fake.calls.length;
    lifecycle.classify("g1");
    expect(fake.calls).toHaveLength(calls);
    expect(await lane.adapter.plan([], initialGmailState())).toBeDefined();
  });

  it("answers unreachable, not filters-left, when Google refuses the sign-in (an ended access): a retry cannot fix it", async () => {
    const { fake, lifecycle, logs } = await rig();
    fake.forcedFor.set("GET", [401]);
    expect(await lifecycle.prepare("g1")).toBe("unreachable");
    expect(logs.find((l) => l.event === "gmail-uninstall-failed")?.fields).toEqual({
      account: "g1",
      code: "AUTH_REQUIRED",
    });
  });

  it("waits for a round that is running before it deletes, and reads the state after it", async () => {
    const { fake, lane, lifecycle, states } = await rig(0);
    const plan = await lane.adapter.plan([entry("late@spam.example")], initialGmailState());
    let release: () => void = () => undefined;
    fake.hold = new Promise<void>((resolve) => {
      release = resolve;
    });
    const running = lane.adapter.apply(plan);
    let prepared = false;
    const preparing = lifecycle.prepare("g1").then((r) => {
      prepared = true;
      return r;
    });
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(prepared).toBe(false);
    release();
    await running;
    // The round finished and saved its filter through the checkpoint; the removal reads the state after that and deletes it.
    expect(await preparing).toBe("ready");
    expect(fake.filters.size).toBe(0);
    expect(gmailStateHoldsFilters(states.get(lane.laneId) as OpaqueState)).toBe(false);
  });
});

describe("createGmailLifecycle: accounts with no lane", () => {
  const withReason = (reason: GmailSkipped["reason"] | undefined, holds = true) => {
    const events: string[] = [];
    const states = new Map<string, OpaqueState>();
    if (holds) {
      states.set(gmailLaneId("g1"), {
        adapterId: "gmail",
        data: {
          filters: [{ id: "abc", entries: [{ id: crypto.randomUUID(), value: "a@spam.example" }] }],
          stale: [],
          intent: [],
          refused: [],
        },
      });
    }
    const lifecycle = createGmailLifecycle({
      skipReasonOf: () => reason,
      lanes: new Map(),
      store: { getState: (id) => states.get(id), setState: () => undefined },
      onHold: (id, held) => events.push(`${id}:${String(held)}`),
      onResumed: () => undefined,
      onDone: () => undefined,
      log: () => undefined,
    });
    return { lifecycle, events };
  };
  it("a restart cures what signed-out, expired and a sign-in made after the start leave behind; nothing else", async () => {
    for (const reason of ["signed-out", "expired", undefined] as const) {
      const { lifecycle } = withReason(reason);
      expect(lifecycle.classify("g1")).toBe("restart-cures");
      expect(await lifecycle.prepare("g1")).toBe("restart-cures");
    }
    for (const reason of ["lane-id", "no-client", "client-unreadable"] as const) {
      const { lifecycle } = withReason(reason);
      expect(lifecycle.classify("g1")).toBe("unreachable");
      expect(await lifecycle.prepare("g1")).toBe("unreachable");
    }
  });
  it("an account whose state is empty has nothing to delete, whatever the reason", async () => {
    const { lifecycle } = withReason("lane-id", false);
    expect(lifecycle.classify("g1")).toBe("ready");
    expect(await lifecycle.prepare("g1")).toBe("ready");
  });
});

describe("createHeldLanes", () => {
  it("holds and frees by lane, apart from anything else", () => {
    const held = createHeldLanes();
    held.hold("a", true);
    held.hold("b", true);
    held.hold("a", false);
    expect([held.has("a"), held.has("b"), held.has("c")]).toEqual([false, true, false]);
  });
});

describe("createGmailLifecycle: a round that does not end", () => {
  it("answers filters-left without deleting anything when the running round is still there after the wait", async () => {
    const uninstall = vi.fn(() => Promise.resolve(initialGmailState()));
    const lane = {
      laneId: gmailLaneId("g1"),
      accountId: "g1",
      email: "me@gmail.com",
      adapter: { suspend: () => Promise.resolve(false), uninstall },
    } as unknown as GmailLane;
    const lifecycle = createGmailLifecycle({
      skipReasonOf: () => undefined,
      lanes: new Map([["g1", lane]]),
      store: { getState: () => undefined, setState: () => undefined },
      onResumed: () => undefined,
      onDone: () => undefined,
      log: () => undefined,
    });
    expect(await lifecycle.prepare("g1")).toBe("filters-left");
    expect(uninstall).not.toHaveBeenCalled();
  });
});

describe("a removal next to a real engine round", () => {
  it("leaves the store empty even when a round was running, fails a sync meanwhile, and catches up after abort", async () => {
    const fake = new FakeGmail();
    const store = new Store(openDatabase(":memory:"));
    const { built } = deps([gmailAccount("g1", "me@gmail.com")], {
      fetch: fake.fetch,
      saveState: (id, state) => {
        store.setState(id, state);
      },
    });
    const lane = buildGmailLanes(built).lanes[0] as GmailLane;
    const engine = new SyncEngine(store, { debounceMs: 5, timeoutMs: 5_000 });
    engine.addAccount({
      id: lane.laneId,
      initialState: initialGmailState(),
      background: true,
      adapter: lane.adapter,
    });
    const resumed: string[] = [];
    const lifecycle = createGmailLifecycle({
      skipReasonOf: () => undefined,
      lanes: new Map([[lane.accountId, lane]]),
      store,
      onResumed: (id) => {
        resumed.push(id);
        // What the app does (main.ts): the lane asks the engine for a sync, which runs after the debounce.
        engine.requestSync(id);
      },
      onDone: () => undefined,
      log: () => undefined,
    });
    store.add(entry("a@spam.example"));

    let release: () => void = () => undefined;
    fake.hold = new Promise<void>((resolve) => {
      release = resolve;
    });
    const syncing = engine.sync(lane.laneId);
    // The round is really running (its first request is held in the fake) when the removal starts.
    for (let i = 0; i < 200 && fake.calls.length === 0; i += 1) {
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    expect(fake.calls.length).toBeGreaterThan(0);
    const preparing = lifecycle.prepare("g1");
    await new Promise((resolve) => setTimeout(resolve, 20));
    release();
    await syncing;
    expect(await preparing).toBe("ready");
    // The engine saved the round's state after the round; the removal's empty state is the one that stands.
    expect(fake.filters.size).toBe(0);
    expect(gmailStateHoldsFilters(store.getState(lane.laneId) as OpaqueState)).toBe(false);

    // Held still: a sync is a visible failure, not a clean round.
    expect(await engine.sync(lane.laneId)).toMatchObject({ status: "failed", code: "TRANSIENT" });
    // The removal did not finish: the lane writes the block list again.
    lifecycle.abort("g1");
    expect(resumed).toEqual([lane.laneId]);
    // No sync is called here: the lane catches up by itself.
    for (let i = 0; i < 200 && fake.filters.size === 0; i += 1) {
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    expect(fake.filters.size).toBe(1);
    engine.dispose();
    store.close();
  });
});

describe("skippedAfterDone", () => {
  const skip = (id: string, reason: GmailSkipped["reason"]): GmailSkipped => ({
    accountId: id,
    email: `${id}@gmail.com`,
    reason,
  });
  it("drops a removed account, whether or not it had a lane", () => {
    const list = [skip("a", "expired"), skip("b", "signed-out")];
    expect(skippedAfterDone(list, "a", "removed", undefined)).toEqual([skip("b", "signed-out")]);
    expect(skippedAfterDone(list, "zzz", "removed", "zzz@gmail.com")).toEqual(list);
  });
  it("names a signed-out account as signed out, by the lane's address or the earlier entry's", () => {
    expect(skippedAfterDone([], "a", "signed-out", "a@gmail.com")).toEqual([
      skip("a", "signed-out"),
    ]);
    expect(skippedAfterDone([skip("a", "expired")], "a", "signed-out", undefined)).toEqual([
      skip("a", "signed-out"),
    ]);
    expect(skippedAfterDone([], "a", "signed-out", undefined)).toEqual([]);
  });
});
