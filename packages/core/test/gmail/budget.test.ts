import { describe, expect, it } from "vitest";
import { AdapterError } from "../../src/adapter.js";
import type { BlockEntry } from "../../src/blocklist.js";
import { GMAIL_MAX_FILTERS, GmailAdapter, initialGmailState } from "../../src/gmail/adapter.js";
import {
  GMAIL_LIMITS,
  GMAIL_UNITS,
  GMAIL_UNITS_PER_ACCOUNT_DAY,
  GMAIL_UNITS_PER_DAY_ALL,
  GMAIL_UNITS_PER_MINUTE,
  GmailBudgetError,
  GmailBudgets,
} from "../../src/gmail/budget.js";
import type { GmailLimits, GmailLogEvent } from "../../src/gmail/budget.js";
import { createGmailClient } from "../../src/gmail/client.js";
import { MAX_ACCOUNTS, SyncEngine } from "../../src/sync/engine.js";
import { openDatabase } from "../../src/store/db.js";
import { Store } from "../../src/store/store.js";
import { compileFromQuery } from "../../src/gmail/query.js";
import type { OpaqueState } from "../../src/adapter.js";
import { FakeGmail, UNITS } from "./fake-gmail.js";

const SECOND = 1_000;
const MINUTE = 60 * SECOND;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

const limits = (over: Partial<GmailLimits> = {}): GmailLimits => ({ ...GMAIL_LIMITS, ...over });

function clock(start = Date.UTC(2026, 9, 27, 12, 0, 0)) {
  const state = { t: start };
  return {
    now: () => state.t,
    advance: (ms: number) => (state.t += ms),
    set: (t: number) => (state.t = t),
  };
}

let n = 0;
const entry = (value: string): BlockEntry => ({
  id: crypto.randomUUID(),
  match: "exactAddress",
  value,
  action: "trash",
  createdAt: new Date(Date.UTC(2026, 9, 27, 12, 0, n++)).toISOString(),
});
const addrs = (count: number, prefix = "u"): string[] =>
  Array.from({ length: count }, (_, i) => `${prefix}${String(i)}@spam.example`);

function wired(budgets: GmailBudgets, key: string, now: () => number, fake = new FakeGmail()) {
  const events: GmailLogEvent[] = [];
  const raw = createGmailClient({
    getAccessToken: () => Promise.resolve(fake.token),
    fetch: fake.fetch,
    timeoutMs: 500,
  });
  const client = budgets.wrap(raw, { key, account: `acct-${key}`, log: (e) => events.push(e) });
  const adapter = new GmailAdapter({
    accountId: `${key}.gmail`,
    client,
    checkpoint: () => undefined,
    now,
    sleep: () => Promise.resolve(),
  });
  return { fake, client, adapter, events };
}

describe("named limits", () => {
  it("are whole numbers in quota units, each wider than the one before and under Google's 6,000 a minute", () => {
    expect(GMAIL_UNITS).toEqual({ list: 1, create: 5, delete: 5 });
    expect(GMAIL_UNITS_PER_MINUTE).toBe(1_100);
    expect(GMAIL_UNITS_PER_ACCOUNT_DAY).toBe(5_000);
    expect(GMAIL_UNITS_PER_DAY_ALL).toBe(100_000);
    expect(GMAIL_UNITS_PER_MINUTE).toBeLessThan(6_000);
    expect(GMAIL_UNITS_PER_MINUTE).toBeLessThan(GMAIL_UNITS_PER_ACCOUNT_DAY);
    expect(GMAIL_UNITS_PER_ACCOUNT_DAY).toBeLessThan(GMAIL_UNITS_PER_DAY_ALL);
    // One usual round (a list and 10 rewrites of a create and a delete) is 101 units: nine fit in a minute, and so does the
    // uninstall of the most filters this lane holds (a list and 200 deletes).
    const usualRound = UNITS.list + 10 * (UNITS.create + UNITS.delete);
    expect(9 * usualRound).toBeLessThanOrEqual(GMAIL_UNITS_PER_MINUTE);
    expect(UNITS.list + GMAIL_MAX_FILTERS * UNITS.delete).toBeLessThanOrEqual(
      GMAIL_UNITS_PER_MINUTE,
    );
  });

  it("refuse a limit that is not a whole number of units", () => {
    for (const bad of [0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(() => new GmailBudgets({ limits: limits({ perMinute: bad }) })).toThrow(RangeError);
      expect(() => new GmailBudgets({ limits: limits({ perAccountDay: bad }) })).toThrow(
        RangeError,
      );
      expect(() => new GmailBudgets({ limits: limits({ allAccountsDay: bad }) })).toThrow(
        RangeError,
      );
    }
  });

  it("the units of the budget are the units the counting fake charges", async () => {
    const c = clock();
    const budgets = new GmailBudgets({ now: c.now });
    const { fake, client } = wired(budgets, "a", c.now);
    const made = await client.create('from:("a@spam.example")');
    await client.list();
    await client.remove(made.id);
    expect(fake.units).toBe(UNITS.create + UNITS.list + UNITS.delete);
    expect(budgets.remaining("a").minute).toBe(GMAIL_UNITS_PER_MINUTE - fake.units);
  });
});

describe("per-minute cap", () => {
  it("refuses the call that would pass the cap, before a request leaves, and frees up a minute later", async () => {
    const c = clock();
    const budgets = new GmailBudgets({ now: c.now, limits: limits({ perMinute: 11 }) });
    const { fake, client } = wired(budgets, "a", c.now);
    await client.create('from:("a@spam.example")');
    await client.create('from:("b@spam.example")');
    const sent = fake.calls.length;
    await expect(client.create('from:("c@spam.example")')).rejects.toMatchObject({
      code: "QUOTA_EXCEEDED",
      limit: "minute",
    });
    expect(fake.calls).toHaveLength(sent);
    // A list still fits (10 + 1 = 11), a second one does not.
    await client.list();
    await expect(client.list()).rejects.toBeInstanceOf(GmailBudgetError);
    c.advance(MINUTE);
    await expect(client.list()).rejects.toBeInstanceOf(GmailBudgetError);
    c.advance(SECOND + 1);
    await client.list();
  });

  it("one account's minute is not another's", async () => {
    const c = clock();
    const budgets = new GmailBudgets({ now: c.now, limits: limits({ perMinute: 5 }) });
    const a = wired(budgets, "a", c.now);
    const b = wired(budgets, "b", c.now);
    await a.client.create('from:("a@spam.example")');
    await expect(a.client.list()).rejects.toBeInstanceOf(GmailBudgetError);
    await b.client.create('from:("b@spam.example")');
  });
});

describe("24-hour account quota", () => {
  it("counts what was spent for at least 24 hours and forgets it within 25 (hourly buckets, fake clock)", async () => {
    const c = clock();
    const budgets = new GmailBudgets({
      now: c.now,
      limits: limits({ perMinute: 1_000, perAccountDay: 10 }),
    });
    const { client } = wired(budgets, "a", c.now);
    await client.create('from:("a@spam.example")');
    await client.create('from:("b@spam.example")');
    await expect(client.list()).rejects.toMatchObject({ limit: "account-day" });
    c.advance(DAY - 1);
    await expect(client.list()).rejects.toMatchObject({ limit: "account-day" });
    c.advance(HOUR + 1);
    await client.list();
    expect(budgets.remaining("a").accountDay).toBe(9);
  });

  it("counts a charge made at the end of its bucket for the whole period (a window one bucket short would let it go early)", async () => {
    for (const [period, late] of [
      [MINUTE, SECOND - 1],
      [DAY, HOUR - 1],
    ] as const) {
      const c = clock(Date.UTC(2026, 9, 27, 12, 0, 0));
      const budgets = new GmailBudgets({
        now: c.now,
        limits: limits({
          perMinute: period === MINUTE ? 5 : 1_000,
          perAccountDay: period === DAY ? 5 : 1_000,
        }),
      });
      const { client } = wired(budgets, "a", c.now);
      c.advance(late);
      await client.create('from:("a@spam.example")');
      c.advance(period);
      await expect(client.list()).rejects.toBeInstanceOf(GmailBudgetError);
    }
  });

  it("a clock set back neither gives the units back nor locks the account for as long as it was set back", async () => {
    const c = clock();
    const budgets = new GmailBudgets({
      now: c.now,
      limits: limits({ perMinute: 1_000, perAccountDay: 5 }),
    });
    const { client } = wired(budgets, "a", c.now);
    await client.create('from:("a@spam.example")');
    c.advance(-100 * DAY);
    await expect(client.list()).rejects.toMatchObject({ limit: "account-day" });
    // The day is counted in time that passed, not in the date on the wall.
    c.advance(DAY + HOUR + 1);
    await client.list();
  });
});

describe("global daily ceiling", () => {
  it("is shared by every account, and a refused call is charged to no window", async () => {
    const c = clock();
    const budgets = new GmailBudgets({
      now: c.now,
      limits: limits({ perMinute: 1_000, perAccountDay: 1_000, allAccountsDay: 12 }),
    });
    const a = wired(budgets, "a", c.now);
    const b = wired(budgets, "b", c.now);
    await a.client.create('from:("a@spam.example")');
    await b.client.create('from:("b@spam.example")');
    await expect(b.client.create('from:("c@spam.example")')).rejects.toMatchObject({
      limit: "all-accounts-day",
    });
    // 12 - 10 = 2 left for everyone: the refused create took nothing from b's own windows.
    expect(budgets.remaining("b")).toEqual({ minute: 995, accountDay: 995, allAccountsDay: 2 });
    await a.client.list();
    await b.client.list();
    await expect(a.client.list()).rejects.toMatchObject({ limit: "all-accounts-day" });
    c.advance(DAY + HOUR + 1);
    await a.client.list();
  });

  it("refuses a charge that is not a whole number of units, which would switch a window off", () => {
    const budgets = new GmailBudgets();
    for (const bad of [Number.NaN, 0, -5, 1.5, Number.POSITIVE_INFINITY]) {
      expect(() => {
        budgets.charge("a", bad);
      }).toThrow(RangeError);
    }
    expect(budgets.remaining("a").minute).toBe(GMAIL_UNITS_PER_MINUTE);
  });

  it("holds no more accounts than the app allows", () => {
    const budgets = new GmailBudgets();
    for (let i = 0; i < MAX_ACCOUNTS; i += 1) budgets.charge(`acct${String(i)}`, 1);
    expect(() => {
      budgets.charge("one-too-many", 1);
    }).toThrow(AdapterError);
    budgets.forget("acct0");
    budgets.charge("one-too-many", 1);
  });
});

describe("log events", () => {
  it("carry fixed words and numbers only: no address, filter id, token or Google text", async () => {
    const c = clock();
    const budgets = new GmailBudgets({ now: c.now, limits: limits({ perMinute: 7 }) });
    const { fake, client, events } = wired(budgets, "a", c.now);
    const secret = "victim@secret-domain.example";
    fake.forcedFor.set("POST", [
      {
        status: 403,
        body: {
          error: {
            message: `no ${secret} ${fake.token}`,
            errors: [{ reason: "insufficientPermissions" }],
          },
        },
      },
    ]);
    await expect(client.create(`from:("${secret}")`)).rejects.toMatchObject({
      code: "AUTH_REQUIRED",
    });
    const made = await client.create('from:("x@spam.example")').catch(() => null);
    expect(made).toBeNull(); // 5 + 5 > 7: our own limit
    await client.list();
    await client.create('from:("x@spam.example")').catch(() => null);
    expect(events.map((e) => [e.event, e.op])).toEqual([
      ["gmail-call", "create"],
      ["gmail-budget", "create"],
      ["gmail-call", "list"],
      ["gmail-budget", "create"],
    ]);
    expect(events[0]).toMatchObject({ outcome: "AUTH_REQUIRED", units: 5 });
    expect(events[1]).toEqual({
      event: "gmail-budget",
      account: "acct-a",
      op: "create",
      limit: "minute",
      used: 5,
      cap: 7,
    });
    const text = JSON.stringify(events);
    for (const leak of [secret, fake.token, "spam.example", "insufficientPermissions"]) {
      expect(text).not.toContain(leak);
    }
    for (const event of events) {
      expect(
        Object.keys(event).every((k) =>
          ["event", "account", "op", "outcome", "units", "ms", "limit", "used", "cap"].includes(k),
        ),
      ).toBe(true);
    }
  });

  it("tell a duplicate create (exists) and a delete of a filter already gone apart from a plain ok", async () => {
    const c = clock();
    const budgets = new GmailBudgets({ now: c.now });
    const { client, events } = wired(budgets, "a", c.now);
    const q = 'from:("a@spam.example")';
    const made = await client.create(q);
    await expect(client.create(q)).rejects.toMatchObject({ name: "FilterExistsError" });
    await client.remove(made.id);
    await client.remove(made.id);
    expect(events.map((e) => (e.event === "gmail-call" ? e.outcome : "budget"))).toEqual([
      "ok",
      "exists",
      "ok",
      "gone",
    ]);
  });

  it("take an account tag only, never an address", () => {
    const budgets = new GmailBudgets();
    const raw = createGmailClient({ getAccessToken: () => Promise.resolve("t") });
    for (const bad of ["person@example.com", "", "Acct-1", "x".repeat(65), "acct 1"]) {
      expect(() => budgets.wrap(raw, { key: "a", account: bad })).toThrow(RangeError);
    }
    budgets.wrap(raw, { key: "a", account: "acct-0a1b2c3d" });
  });

  it("a log that throws does not break a call", async () => {
    const c = clock();
    const budgets = new GmailBudgets({ now: c.now });
    const fake = new FakeGmail();
    const raw = createGmailClient({
      getAccessToken: () => Promise.resolve(fake.token),
      fetch: fake.fetch,
    });
    const client = budgets.wrap(raw, {
      key: "a",
      account: "acct-a",
      log: () => {
        throw new Error("disk full");
      },
    });
    await expect(client.list()).resolves.toMatchObject({ filters: [] });
  });
});

describe("through the adapter", () => {
  it("our own limit fails the rest of the plan as TRANSIENT with its own words, sends nothing more, and the next minute completes it", async () => {
    const c = clock();
    // A list and one create fit (1 + 5); the second filter's create does not.
    const budgets = new GmailBudgets({ now: c.now, limits: limits({ perMinute: 6 }) });
    const { fake, adapter } = wired(budgets, "a", c.now);
    const list = addrs(60).map(entry);
    const first = await adapter.apply(await adapter.plan(list, initialGmailState()));
    expect(first.applied).toBe(50);
    expect(first.failed).toHaveLength(10);
    expect(first.failed.every((f) => f.error.code === "TRANSIENT")).toBe(true);
    expect(first.failed[0]?.error.message).toContain("own Gmail limit");
    expect(first.failed[0]?.error.message).not.toContain("Google asked");
    expect(fake.callsTo("POST")).toHaveLength(1);
    c.advance(MINUTE + SECOND + 1);
    // The create that was refused left its intent (the adapter cannot tell a refusal before the request from a lost answer), so
    // the next round settles it (a list) and the one after puts the 10 addresses in a filter.
    const second = await adapter.apply(await adapter.plan(list, first.state));
    expect(second.applied).toBe(0);
    expect(second.deferred).toBe(10);
    c.advance(MINUTE + SECOND + 1);
    const third = await adapter.apply(await adapter.plan(list, second.state));
    expect(third.applied).toBe(10);
    expect(third.failed).toEqual([]);
    expect(fake.filters.size).toBe(2);
  });

  it("an Unblock is not reported done while the limit holds the delete back", async () => {
    const c = clock();
    const budgets = new GmailBudgets({ now: c.now });
    const { fake, adapter } = wired(budgets, "a", c.now);
    const list = addrs(3).map(entry);
    const placed = await adapter.apply(await adapter.plan(list, initialGmailState()));
    expect(placed.applied).toBe(3);
    // Minute cap left for a list and a create only (6): the delete of the old filter is refused.
    const tight = new GmailBudgets({ now: c.now, limits: limits({ perMinute: 6 }) });
    const second = wired(tight, "a", c.now, fake);
    const result = await second.adapter.apply(
      await second.adapter.plan(list.slice(0, 2), placed.state),
    );
    expect(result.failed.map((f) => f.error.code)).toEqual(["TRANSIENT"]);
    expect(result.failed[0]?.error.message).toBe("still in a Gmail filter");
    expect(result.applied).toBe(0);
  });
});

describe("two days of rounds on the fake clock", () => {
  it(
    "never passes the minute cap, an account's day or the global ceiling in any window, and starts again after a day",
    { timeout: 60_000 },
    async () => {
      const c = clock();
      const caps = limits({ perMinute: 30, perAccountDay: 600, allAccountsDay: 1_000 });
      const budgets = new GmailBudgets({ now: c.now, limits: caps });
      const fake = new FakeGmail();
      const rigs = ["a", "b", "c"].map((key) => wired(budgets, key, c.now, fake));
      const states = rigs.map(() => initialGmailState());
      const spent: { account: number; t: number; units: number }[] = [];
      let refused = 0;
      // Demand every half hour for 50 hours, two rounds back to back each time: the list swaps between two sets of 60
      // addresses, so every round rewrites filters, and a round costs more than the minute cap lets through.
      for (let step = 0; step < 100; step += 1) {
        for (let again = 0; again < 2; again += 1) {
          for (const [i, rig] of rigs.entries()) {
            const list = addrs(60, `m${String(i)}${step % 2 === 0 ? "a" : "b"}x`).map(entry);
            const before = fake.units;
            try {
              const result = await rig.adapter.apply(
                await rig.adapter.plan(list, states[i] ?? initialGmailState()),
              );
              states[i] = result.state;
              if (result.failed.length > 0) refused += 1;
            } catch {
              refused += 1;
            }
            spent.push({ account: i, t: c.now(), units: fake.units - before });
          }
          c.advance(SECOND);
        }
        c.advance(30 * MINUTE - 2 * SECOND);
      }
      expect(refused).toBeGreaterThan(0);
      // The fake counted every unit Google would have charged, so a window's sum is exact.
      const within = (from: number, length: number, account?: number): number =>
        spent
          .filter(
            (p) =>
              p.t >= from &&
              p.t < from + length &&
              (account === undefined || p.account === account),
          )
          .reduce((sum, p) => sum + p.units, 0);
      let peakMinute = 0;
      let peakAccountDay = 0;
      let peakAllDay = 0;
      for (const point of spent) {
        for (const account of [0, 1, 2]) {
          peakMinute = Math.max(peakMinute, within(point.t, MINUTE, account));
          peakAccountDay = Math.max(peakAccountDay, within(point.t, DAY, account));
        }
        peakAllDay = Math.max(peakAllDay, within(point.t, DAY));
      }
      expect(peakMinute).toBeLessThanOrEqual(caps.perMinute);
      expect(peakAccountDay).toBeLessThanOrEqual(caps.perAccountDay);
      expect(peakAllDay).toBeLessThanOrEqual(caps.allAccountsDay);
      // The ceiling is what bound (3 x 600 > 1,000), and the second day was served again.
      expect(peakAllDay).toBeGreaterThan(caps.allAccountsDay * 0.8);
      const start = spent[0]?.t ?? 0;
      expect(within(start + DAY + HOUR, 2 * DAY)).toBeGreaterThan(0);
      for (const rig of rigs) expect(rig.events.some((e) => e.event === "gmail-budget")).toBe(true);
    },
  );
});

describe("refusals in the other places a round can meet one", () => {
  it("a round with only cleanup to do, refused by our own limit, is not recorded as applied (the engine asks again)", async () => {
    const c = clock();
    // A list and one create fit in the minute; the delete of the replaced filter does not.
    const budgets = new GmailBudgets({ now: c.now, limits: limits({ perMinute: 6 }) });
    const { fake, adapter } = wired(budgets, "a", c.now);
    const store = new Store(openDatabase(":memory:"));
    const engine = new SyncEngine(store, { debounceMs: 5, timeoutMs: 1_000 });
    engine.addAccount({ id: "a.gmail", adapter, initialState: initialGmailState() });
    store.add(entry("a@spam.example"));
    expect(await engine.sync("a.gmail")).toMatchObject({ status: "applied", applied: 1 });
    c.advance(MINUTE + SECOND + 1);
    store.add(entry("b@spam.example"));
    expect(await engine.sync("a.gmail")).toMatchObject({ status: "applied", applied: 1 });
    expect(fake.filters.size).toBe(2); // the old filter is stale, not deleted
    // Same minute: the cleanup round's list is refused. Reported as applied it would never be retried.
    expect(await engine.sync("a.gmail")).toMatchObject({
      status: "partial",
      applied: 0,
      failed: 1,
    });
    c.advance(MINUTE + SECOND + 1);
    expect(await engine.sync("a.gmail")).toMatchObject({ status: "applied" });
    expect(fake.filters.size).toBe(1);
    engine.dispose();
    store.close();
  });

  it("a refused read after a 5xx create keeps the intent and sends no second create; the next round takes the filter in", async () => {
    const c = clock();
    // The list (1) and the create (5) fit; the read that follows the 503 does not.
    const budgets = new GmailBudgets({ now: c.now, limits: limits({ perMinute: 6 }) });
    const { fake, adapter } = wired(budgets, "a", c.now);
    fake.createThenFail = [503];
    const list = addrs(3).map(entry);
    const first = await adapter.apply(await adapter.plan(list, initialGmailState()));
    expect(first.applied).toBe(0);
    expect(first.failed).toHaveLength(3);
    expect((first.state.data as { intent: unknown[] }).intent).toHaveLength(1);
    expect(fake.filters.size).toBe(1); // it landed; only the answer was lost
    c.advance(MINUTE + SECOND + 1);
    let state: OpaqueState = first.state;
    for (let i = 0; i < 3; i += 1) {
      const result = await adapter.apply(await adapter.plan(list, state));
      state = result.state;
      c.advance(MINUTE + SECOND + 1);
    }
    expect(fake.callsTo("POST")).toHaveLength(1);
    expect(fake.filters.size).toBe(1);
    expect((state.data as { filters: { entries: unknown[] }[] }).filters[0]?.entries).toHaveLength(
      3,
    );
  });

  it("verify under a refusal throws a rate limit, never a verdict", async () => {
    const c = clock();
    const budgets = new GmailBudgets({ now: c.now, limits: limits({ perMinute: 1 }) });
    const { adapter } = wired(budgets, "a", c.now);
    const state: OpaqueState = {
      adapterId: "gmail",
      data: {
        filters: [{ id: "abc", entries: [{ id: crypto.randomUUID(), value: "a@spam.example" }] }],
        stale: [],
        intent: [],
        refused: [],
      },
    };
    await adapter.verify(state);
    await expect(adapter.verify(state)).rejects.toMatchObject({ code: "QUOTA_EXCEEDED" });
  });

  /** A fake mailbox holding `count` filters this lane wrote (one address each) and the state that records them. */
  function filtersWritten(count: number) {
    const fake = new FakeGmail();
    const records = Array.from({ length: count }, (_, i) => {
      const value = `u${String(i)}@spam.example`;
      const id = fake.addForeign({ query: compileFromQuery([value]) }, { addLabelIds: ["TRASH"] });
      return { id, entries: [{ id: crypto.randomUUID(), value }] };
    });
    const state: OpaqueState = {
      adapterId: "gmail",
      data: { filters: records, stale: [], intent: [], refused: [] },
    };
    return { fake, state };
  }

  it("uninstalling 100 filters (the 5,000-address maximum) fits in one minute under the default limits", async () => {
    const { fake, state } = filtersWritten(100);
    const c = clock();
    const rig = wired(new GmailBudgets({ now: c.now }), "a", c.now, fake);
    const left = await rig.adapter.uninstall(state);
    expect((left.data as { filters: unknown[] }).filters).toEqual([]);
    expect(fake.filters.size).toBe(0);
  });

  it("an uninstall that runs out of its minute returns what is left, never an empty state", async () => {
    const { fake, state } = filtersWritten(3);
    const c = clock();
    // The list (1) and one delete (5) fit; the other two deletes do not.
    const budgets = new GmailBudgets({ now: c.now, limits: limits({ perMinute: 6 }) });
    const rig = wired(budgets, "a", c.now, fake);
    const left = await rig.adapter.uninstall(state);
    expect((left.data as { filters: unknown[] }).filters).toHaveLength(2);
    expect(fake.filters.size).toBe(2);
  });
});
