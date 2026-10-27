import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createGate } from "../../src/gate.js";
import { GMAIL_MAIL_UNITS, GmailBudgets } from "../../src/gmail/budget.js";
import { HISTORY_PAGE_SIZE, createGmailMailClient } from "../../src/gmail/mail-client.js";
import type { GmailMailClient } from "../../src/gmail/mail-client.js";
import {
  ANNOUNCED_MAX,
  GMAIL_MAX_PAGES,
  GMAIL_MESSAGE_ATTEMPTS,
  GMAIL_POLL,
  GMAIL_POLL_DEADLINE_MS,
  GMAIL_START_SPREAD_MS,
  GmailWatcher,
} from "../../src/gmail/watcher.js";
import type {
  GmailBackoffDetail,
  GmailGap,
  GmailIncoming,
  GmailPollEvent,
  GmailWatcherState,
} from "../../src/gmail/watcher.js";
import { SUBJECT_MAX } from "../../src/watcher/watcher.js";
import { FakeGmail } from "./fake-gmail.js";

const SECOND = 1_000;
const MINUTE = 60 * SECOND;
const HOUR = 60 * MINUTE;

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(Date.UTC(2026, 9, 27, 12, 0, 0));
});
afterEach(() => {
  vi.useRealTimers();
});

const tick = (ms: number) => vi.advanceTimersByTimeAsync(ms);

function setup(
  over: {
    maxPerDrain?: number;
    random?: () => number;
    budgets?: GmailBudgets;
    startCursor?: string;
  } = {},
) {
  const fake = new FakeGmail();
  const budgets = over.budgets ?? new GmailBudgets();
  const raw = createGmailMailClient({
    getAccessToken: () => Promise.resolve(fake.token),
    fetch: fake.fetch,
  });
  const client = budgets.wrapMail(raw, { key: "a", account: "acct-a" });
  const store = new Map<string, string>();
  if (over.startCursor !== undefined) store.set("acct", over.startCursor);
  const messages: GmailIncoming[] = [];
  const gaps: GmailGap[] = [];
  const overflow: number[] = [];
  const states: [GmailWatcherState, GmailBackoffDetail | undefined][] = [];
  const polls: GmailPollEvent[] = [];
  const watcher = new GmailWatcher({
    accountId: "acct",
    client,
    cursors: {
      get: (id) => store.get(id),
      set: (id, historyId) => void store.set(id, historyId),
    },
    onMessage: (_id, message) => void messages.push(message),
    onOverflow: (_id, skipped) => void overflow.push(skipped),
    onGap: (_id, gap) => void gaps.push(gap),
    onState: (_id, state, detail) => void states.push([state, detail]),
    onPoll: (_id, event) => void polls.push(event),
    random: over.random ?? (() => 0),
    ...(over.maxPerDrain === undefined ? {} : { maxPerDrain: over.maxPerDrain }),
  });
  const historyCalls = () => fake.calls.filter((c) => c.url.includes("/history?")).length;
  const messageCalls = () => fake.calls.filter((c) => c.url.includes("/messages/")).length;
  return {
    fake,
    store,
    messages,
    gaps,
    overflow,
    states,
    polls,
    watcher,
    budgets,
    historyCalls,
    messageCalls,
  };
}

/** Starts the watcher and lets its first poll (the cursor) run. */
async function started(t: ReturnType<typeof setup>) {
  t.watcher.start();
  await tick(0);
  await tick(0);
}

describe("GmailWatcher: first run", () => {
  it("takes the mailbox's current historyId as the cursor and announces nothing that was already there", async () => {
    const t = setup();
    t.fake.deliver({ from: "old@x.example" });
    await started(t);
    expect(t.store.get("acct")).toBe("1001");
    expect(t.messages).toEqual([]);
    expect(t.polls[0]).toMatchObject({ outcome: "first", found: 0 });
    expect(t.historyCalls()).toBe(0);
    expect(t.watcher.current).toBe("watching");
    expect(t.watcher.lastOkAt).not.toBeNull();
  });

  it("is `starting` until a poll has worked, and `lastOkAt` is null until then", async () => {
    const t = setup({ random: () => 0.5 });
    t.watcher.start();
    expect(t.watcher.current).toBe("starting");
    expect(t.watcher.lastOkAt).toBeNull();
    await tick(GMAIL_START_SPREAD_MS);
    expect(t.watcher.current).toBe("watching");
    expect(t.states.map(([s]) => s)).toEqual(["starting", "watching"]);
  });

  it("a stored cursor that is not digits is treated as no cursor", async () => {
    const t = setup({ startCursor: "12; drop table" });
    await started(t);
    expect(t.store.get("acct")).toBe("1000");
    expect(t.historyCalls()).toBe(0);
  });
});

describe("GmailWatcher: new mail", () => {
  it("announces new INBOX mail once, with a clean sender and subject, and keeps the cursor", async () => {
    const t = setup();
    await started(t);
    t.fake.deliver({ from: '"Spam Inc" <X@Spam.Example>', subject: "Win‮ now\n!" });
    await tick(GMAIL_POLL.baseMs);
    expect(t.messages).toHaveLength(1);
    expect(t.messages[0]).toMatchObject({ from: "x@spam.example", subject: "Win now !" });
    expect(t.store.get("acct")).toBe("1001");
    await tick(2 * GMAIL_POLL.baseMs);
    expect(t.messages).toHaveLength(1);
  });

  it("a subject is cut to the display bound", async () => {
    const t = setup();
    await started(t);
    t.fake.deliver({ from: "a@x.example", subject: "s".repeat(5_000) });
    await tick(GMAIL_POLL.baseMs);
    expect(t.messages[0]?.subject).toHaveLength(SUBJECT_MAX);
  });

  it("a sender that cannot be read safely is announced without an address", async () => {
    const t = setup();
    await started(t);
    t.fake.deliver({ from: ["<victim@bank.example>", "<other@y.example>"] }); // two From headers
    t.fake.deliver({ from: `<victim@bank.example>`, extraHeaders: [] });
    // a hidden second From: too long to be read, so only one is left in the answer
    t.fake.deliver({ from: ["<victim@bank.example>", `<${"x".repeat(9_000)}@y.example>`] });
    t.fake.deliver({ from: "list: a@x.example, b@y.example;" });
    await tick(GMAIL_POLL.baseMs);
    expect(t.messages.map((m) => m.from)).toEqual([null, "victim@bank.example", null, null]);
  });

  it("the display name is never the sender", async () => {
    const t = setup();
    await started(t);
    t.fake.deliver({ from: '"boss@co.com" <x@spam.example>' });
    await tick(GMAIL_POLL.baseMs);
    expect(t.messages[0]?.from).toBe("x@spam.example");
  });

  it("announces the newest `maxPerDrain` and counts the older ones", async () => {
    const t = setup({ maxPerDrain: 3 });
    await started(t);
    for (let i = 0; i < 7; i += 1) t.fake.deliver({ from: `m${String(i)}@x.example` });
    await tick(GMAIL_POLL.baseMs);
    expect(t.messages.map((m) => m.from)).toEqual(["m4@x.example", "m5@x.example", "m6@x.example"]);
    expect(t.overflow).toEqual([4]);
    expect(t.polls.at(-1)).toMatchObject({ outcome: "gap", found: 7, announced: 3 });
    expect(t.messageCalls()).toBe(3);
  });

  it("mail that is no longer in the INBOX when read (sent, moved) is not announced", async () => {
    const t = setup();
    await started(t);
    const id = t.fake.deliver({ from: "a@x.example" });
    // the history recorded it as INBOX mail; by the time it is read it has been moved out
    const message = t.fake.mail.get(id);
    if (message !== undefined) message.labelIds = ["SENT"];
    await tick(GMAIL_POLL.baseMs);
    expect(t.messageCalls()).toBe(1);
    expect(t.messages).toEqual([]);
    expect(t.store.get("acct")).toBe("1001");
  });

  it("a message deleted before it was read is skipped quietly and the cursor still moves", async () => {
    const t = setup();
    await started(t);
    const id = t.fake.deliver({ from: "a@x.example" });
    t.fake.mail.delete(id);
    await tick(GMAIL_POLL.baseMs);
    expect(t.messages).toEqual([]);
    expect(t.store.get("acct")).toBe("1001");
    expect(t.gaps).toEqual([]);
  });

  it("a consumer that throws does not wedge the cursor", async () => {
    const t = setup();
    const boom = new GmailWatcher({
      accountId: "acct",
      client: createGmailMailClient({
        getAccessToken: () => Promise.resolve(t.fake.token),
        fetch: t.fake.fetch,
      }),
      cursors: { get: (id) => t.store.get(id), set: (id, h) => void t.store.set(id, h) },
      onMessage: () => {
        throw new Error("consumer bug");
      },
      random: () => 0,
    });
    boom.start();
    await tick(0);
    t.fake.deliver({ from: "a@x.example" });
    await tick(GMAIL_POLL.baseMs);
    expect(t.store.get("acct")).toBe("1001");
    boom.stop();
  });

  it("history that Google lists twice is announced once", async () => {
    const t = setup();
    await started(t);
    const id = t.fake.deliver({ from: "a@x.example" });
    t.fake.history.push({ id: 1500, added: [id] });
    t.fake.historyId = 1500;
    await tick(GMAIL_POLL.baseMs);
    expect(t.messages).toHaveLength(1);
  });

  it("the cursor never moves backwards", async () => {
    const t = setup({ startCursor: "5000" });
    t.fake.historyId = 5000;
    t.watcher.start();
    await tick(0);
    t.fake.forced.push({ status: 200, body: { historyId: "7" } });
    await tick(GMAIL_POLL.baseMs);
    expect(t.store.get("acct")).toBe("5000");
  });
});

describe("GmailWatcher: pages and gaps", () => {
  it("reads every page of a long answer, within the cap, announces the newest few once, and counts the rest", async () => {
    const t = setup();
    await started(t);
    const total = HISTORY_PAGE_SIZE + 30;
    for (let i = 0; i < total; i += 1) t.fake.deliver({ from: `p${String(i)}@x.example` });
    await tick(GMAIL_POLL.baseMs);
    expect(t.polls.at(-1)).toMatchObject({ pages: 2, found: total, announced: 5 });
    expect(t.messages.map((m) => m.from)).toEqual(
      [125, 126, 127, 128, 129].map((i) => `p${String(i)}@x.example`),
    );
    expect(t.overflow).toEqual([total - 5]);
    // 2 history pages and 5 messages: 4 + 100 units, well inside the minute line
    expect(t.fake.mailUnits).toBe(1 + 2 * 2 + 5 * 20);
  });

  it("stops at the page cap, reports the rest as a gap, and moves the cursor to the present", async () => {
    const t = setup();
    await started(t);
    for (let i = 0; i < GMAIL_MAX_PAGES * HISTORY_PAGE_SIZE + 20; i += 1) {
      t.fake.deliver({ from: "a@x.example" });
    }
    await tick(GMAIL_POLL.baseMs);
    expect(t.polls.at(-1)?.pages).toBe(GMAIL_MAX_PAGES);
    expect(t.gaps).toContain("overflow");
    expect(t.store.get("acct")).toBe(String(t.fake.historyId));
  });

  it("an expired cursor (404) starts again from the present and says mail in the gap was not announced", async () => {
    const t = setup();
    await started(t);
    t.fake.deliver({ from: "a@x.example" });
    t.fake.oldestHistoryId = 99_999;
    await tick(GMAIL_POLL.baseMs);
    expect(t.gaps).toEqual(["expired"]);
    expect(t.messages).toEqual([]);
    expect(t.store.get("acct")).toBe(String(t.fake.historyId));
    expect(t.polls.at(-1)).toMatchObject({ outcome: "gap" });
    expect(t.watcher.current).toBe("watching");
  });

  it("records that did not fit the shape are reported, and the rest is announced", async () => {
    const t = setup();
    await started(t);
    const id = t.fake.deliver({ from: "a@x.example" });
    t.fake.forced.push({
      status: 200,
      body: {
        historyId: "1100",
        history: [
          { messagesAdded: "nonsense" },
          { messagesAdded: [{ message: { id, labelIds: ["INBOX"] } }] },
        ],
      },
    });
    await tick(GMAIL_POLL.baseMs);
    expect(t.messages).toHaveLength(1);
    expect(t.gaps).toEqual(["unreadable"]);
    expect(t.store.get("acct")).toBe("1100");
  });
});

describe("GmailWatcher: failures", () => {
  it("a failed poll backs off, keeps the cursor, and the next one announces what it missed", async () => {
    const t = setup();
    await started(t);
    t.fake.deliver({ from: "a@x.example" });
    t.fake.forcedFor.set("GET", [503]);
    await tick(GMAIL_POLL.baseMs);
    expect(t.watcher.current).toBe("backoff");
    expect(t.states.at(-1)).toEqual(["backoff", "transient"]);
    expect(t.store.get("acct")).toBe("1000");
    expect(t.messages).toEqual([]);
    await tick(5 * MINUTE);
    expect(t.messages).toHaveLength(1);
    expect(t.watcher.current).toBe("watching");
    expect(t.store.get("acct")).toBe("1001");
  });

  it("the delay grows with each failure up to the cap, with equal jitter", async () => {
    const t = setup({ random: () => 0 });
    await started(t);
    t.fake.forcedFor.set(
      "GET",
      Array.from({ length: 30 }, () => 503),
    );
    const at: number[] = [];
    for (let i = 0; i < 6; i += 1) {
      const before = t.historyCalls();
      let waited = 0;
      while (t.historyCalls() === before && waited < 10 * MINUTE) {
        await tick(SECOND);
        waited += SECOND;
      }
      at.push(waited);
    }
    // random() = 0 gives half the ceiling: 50 s (the interval), then 30, 60, 120, 150, 150 s of backoff
    expect(at.slice(1)).toEqual([30_000, 60_000, 120_000, 150_000, 150_000]);
  });

  it("two messages, the second unreadable once: the first is announced once, never twice", async () => {
    const t = setup();
    await started(t);
    t.fake.deliver({ from: "a@x.example" });
    t.fake.deliver({ from: "b@x.example" });
    // history passes, first message passes, second message fails
    t.fake.forcedFor.set("GET", ["pass", "pass", 503]);
    await tick(GMAIL_POLL.baseMs);
    expect(t.messages.map((m) => m.from)).toEqual(["a@x.example"]);
    expect(t.store.get("acct")).toBe("1000");
    await tick(5 * MINUTE);
    expect(t.messages.map((m) => m.from)).toEqual(["a@x.example", "b@x.example"]);
    expect(t.store.get("acct")).toBe("1002");
  });

  it("a message that never reads is given up after its tries, reported, and the cursor moves on", async () => {
    const t = setup();
    await started(t);
    t.fake.deliver({ from: "a@x.example" });
    const bad = { status: 200, body: { id: "someone-else" } };
    // every poll: history passes, the message answer is for another id
    t.fake.forcedFor.set(
      "GET",
      Array.from({ length: GMAIL_MESSAGE_ATTEMPTS }, () => ["pass" as const, bad]).flat(),
    );
    await tick(HOUR);
    expect(t.messages).toEqual([]);
    expect(t.gaps).toEqual(["skipped"]);
    expect(t.store.get("acct")).toBe("1001");
    expect(t.watcher.current).toBe("watching");
    const calls = t.messageCalls();
    await tick(HOUR);
    expect(t.messageCalls()).toBe(calls); // not read again
  });

  it("a refused sign-in halts the watcher: no more requests until it is started again", async () => {
    const t = setup();
    await started(t);
    t.fake.forcedFor.set("GET", [401]);
    await tick(GMAIL_POLL.baseMs);
    expect(t.watcher.current).toBe("halted-auth");
    const calls = t.fake.calls.length;
    await tick(3 * HOUR);
    expect(t.fake.calls).toHaveLength(calls);
    t.watcher.start();
    await tick(GMAIL_START_SPREAD_MS);
    expect(t.watcher.current).toBe("watching");
    expect(t.fake.calls.length).toBeGreaterThan(calls);
  });

  it("a rate limit from Google is a visible backoff for quota, and the poll is not lost", async () => {
    const t = setup();
    await started(t);
    t.fake.deliver({ from: "a@x.example" });
    t.fake.forcedFor.set("GET", [429]);
    await tick(GMAIL_POLL.baseMs);
    expect(t.states.at(-1)).toEqual(["backoff", "quota"]);
    await tick(5 * MINUTE);
    expect(t.messages).toHaveLength(1);
  });

  it("our own budget line reached is a backoff for quota with no request sent", async () => {
    const budgets = new GmailBudgets({
      limits: {
        perMinute: 1_100,
        perAccountDay: 5_000,
        allAccountsDay: 100_000,
        mailPerAccountDay: 1 + GMAIL_MAIL_UNITS.history,
        mailAllAccountsDay: 250_000,
      },
    });
    const t = setup({ budgets });
    await started(t); // profile: 1 unit
    await tick(GMAIL_POLL.baseMs); // history: 2 units, the line is full
    const calls = t.fake.calls.length;
    await tick(GMAIL_POLL.baseMs + 10 * MINUTE);
    expect(t.states.at(-1)).toEqual(["backoff", "quota"]);
    expect(t.fake.calls).toHaveLength(calls);
  });

  it("a rejection that is not a sign-in or quota problem backs off as `rejected`", async () => {
    const t = setup();
    await started(t);
    t.fake.forcedFor.set("GET", [400]);
    await tick(GMAIL_POLL.baseMs);
    expect(t.states.at(-1)).toEqual(["backoff", "rejected"]);
    expect(t.polls.at(-1)).toMatchObject({ outcome: "error", code: "REJECTED" });
  });
});

describe("GmailWatcher: timing, one flight, stop and resume", () => {
  it("polls about once a minute: 60 s plus or minus 10 s, never sooner than 50 s", async () => {
    let seed = 7;
    const random = () => {
      seed = (seed * 1_103_515_245 + 12_345) % 2_147_483_648;
      return seed / 2_147_483_648;
    };
    const t = setup({ random });
    await started(t);
    const times: number[] = [];
    let last = Date.now();
    let seen = t.historyCalls();
    for (let i = 0; i < 20 * 60; i += 1) {
      await tick(SECOND);
      if (t.historyCalls() > seen) {
        times.push(Date.now() - last);
        last = Date.now();
        seen = t.historyCalls();
      }
    }
    const gaps = times.slice(1);
    expect(gaps.length).toBeGreaterThan(10);
    expect(Math.min(...gaps)).toBeGreaterThanOrEqual(GMAIL_POLL.baseMs - GMAIL_POLL.jitterMs);
    expect(Math.max(...gaps)).toBeLessThanOrEqual(GMAIL_POLL.baseMs + GMAIL_POLL.jitterMs + SECOND);
  });

  it(
    "a day of polling stays inside the account's mail line and is never refused",
    { timeout: 60_000 },
    async () => {
      let seed = 99;
      const random = () => {
        seed = (seed * 1_103_515_245 + 12_345) % 2_147_483_648;
        return seed / 2_147_483_648;
      };
      const t = setup({ random });
      await started(t);
      await tick(24 * HOUR);
      expect(t.states.some(([s]) => s === "backoff")).toBe(false);
      // the budget derived 1,440 polls a day (mean interval 60 s); the real count is near it and under the jitter's worst case
      expect(t.historyCalls()).toBeGreaterThan(1_380);
      expect(t.historyCalls()).toBeLessThan(1_500);
      const spent = t.historyCalls() * GMAIL_MAIL_UNITS.history + GMAIL_MAIL_UNITS.profile;
      expect(t.budgets.remainingMail("a").accountDay).toBe(4_500 - spent);
    },
  );

  it("one poll at a time: a slow poll is not joined by a second, and the next timer is set when it ends", async () => {
    const t = setup();
    await started(t);
    let release: () => void = () => undefined;
    t.fake.hold = new Promise<void>((resolve) => {
      release = resolve;
    });
    await tick(GMAIL_POLL.baseMs);
    expect(t.historyCalls()).toBe(1);
    // inside its deadline a slow poll is waited for, not joined by a second
    await tick(GMAIL_POLL_DEADLINE_MS - 15 * SECOND);
    expect(t.historyCalls()).toBe(1);
    t.fake.hold = null;
    release();
    await tick(0);
    await tick(GMAIL_POLL.baseMs + GMAIL_POLL.jitterMs);
    expect(t.historyCalls()).toBe(2);
  });

  it("stop() ends it: no timer, no request, and a poll still in the air announces nothing and keeps no cursor", async () => {
    const t = setup();
    await started(t);
    t.fake.deliver({ from: "a@x.example" });
    let release: () => void = () => undefined;
    t.fake.hold = new Promise<void>((resolve) => {
      release = resolve;
    });
    await tick(GMAIL_POLL.baseMs);
    t.watcher.stop();
    expect(t.watcher.current).toBe("stopped");
    t.fake.hold = null;
    release();
    await tick(0);
    await tick(3 * HOUR);
    expect(t.messages).toEqual([]);
    expect(t.store.get("acct")).toBe("1000");
    expect(vi.getTimerCount()).toBe(0);
  });

  it("stop() while a message is being read: nothing is announced and no cursor is kept", async () => {
    let release: (m: "gone") => void = () => undefined;
    const stub: GmailMailClient = {
      profile: () => Promise.resolve({ historyId: "1" }),
      history: () =>
        Promise.resolve({
          messages: [{ id: "m1", labelIds: ["INBOX"] }],
          historyId: "2",
          unreadable: 0,
        }),
      message: () =>
        new Promise((resolve) => {
          release = resolve;
        }),
    };
    const store = new Map<string, string>([["acct", "1"]]);
    const seen: GmailIncoming[] = [];
    const watcher = new GmailWatcher({
      accountId: "acct",
      client: stub,
      cursors: { get: (a) => store.get(a), set: (a, h) => void store.set(a, h) },
      onMessage: (_a, m) => void seen.push(m),
      random: () => 0,
    });
    watcher.start();
    await tick(0);
    await tick(0);
    watcher.stop();
    release("gone");
    await tick(0);
    await tick(HOUR);
    expect(seen).toEqual([]);
    expect(store.get("acct")).toBe("1");
    expect(vi.getTimerCount()).toBe(0);
  });

  it("resumeNow() looks within the start spread instead of waiting out the interval", async () => {
    const t = setup({ random: () => 0.5 });
    t.watcher.start();
    await tick(GMAIL_START_SPREAD_MS);
    await tick(0);
    const before = t.historyCalls();
    t.watcher.resumeNow();
    await tick(GMAIL_START_SPREAD_MS / 2);
    await tick(0);
    expect(t.historyCalls()).toBe(before + 1);
  });

  it("resumeNow() while a poll runs brings the next one soon, and starts no second one", async () => {
    const t = setup({ random: () => 0 });
    await started(t);
    let release: () => void = () => undefined;
    t.fake.hold = new Promise<void>((resolve) => {
      release = resolve;
    });
    await tick(50 * SECOND);
    t.watcher.resumeNow();
    expect(t.historyCalls()).toBe(1);
    t.fake.hold = null;
    release();
    await tick(0);
    await tick(0);
    await tick(1);
    expect(t.historyCalls()).toBe(2);
  });

  it("resumeNow() on a stopped or halted watcher does nothing", async () => {
    const t = setup();
    t.watcher.resumeNow();
    await tick(HOUR);
    expect(t.fake.calls).toHaveLength(0);
  });

  it("start() twice is one watcher", async () => {
    const t = setup();
    t.watcher.start();
    t.watcher.start();
    await tick(0);
    await tick(0);
    expect(t.fake.calls).toHaveLength(1);
  });
});

describe("GmailWatcher: many accounts", () => {
  function fifty(stub: GmailMailClient, gate?: ReturnType<typeof createGate>, together = false) {
    const store = new Map<string, string>();
    return Array.from({ length: 50 }, (_, i) => {
      const id = `acct-${String(i)}`;
      store.set(id, "1");
      let k = 0;
      return new GmailWatcher({
        accountId: id,
        client: stub,
        cursors: { get: (a) => store.get(a), set: (a, h) => void store.set(a, h) },
        onMessage: () => undefined,
        ...(gate === undefined ? {} : { gate }),
        random: together ? () => 0 : () => ((i * 7 + k++ * 13) % 100) / 100,
      });
    });
  }

  it("50 watchers started together poll at spread-out moments inside the start window, not all at once", async () => {
    const starts: number[] = [];
    const stub: GmailMailClient = {
      profile: () => Promise.resolve({ historyId: "1" }),
      history: () => {
        starts.push(Date.now());
        return Promise.resolve({ messages: [], historyId: "1", unreadable: 0 });
      },
      message: () => Promise.resolve("gone"),
    };
    const t0 = Date.now();
    const watchers = fifty(stub);
    for (const w of watchers) w.start();
    await tick(GMAIL_START_SPREAD_MS);
    expect(starts).toHaveLength(50);
    expect(new Set(starts).size).toBeGreaterThan(20);
    expect(Math.max(...starts) - t0).toBeLessThanOrEqual(GMAIL_START_SPREAD_MS);
    // never more than a handful in the same second
    const perSecond = new Map<number, number>();
    for (const at of starts) {
      const second = Math.floor((at - t0) / SECOND);
      perSecond.set(second, (perSecond.get(second) ?? 0) + 1);
    }
    expect(Math.max(...perSecond.values())).toBeLessThanOrEqual(5);
    for (const w of watchers) w.stop();
    expect(vi.getTimerCount()).toBe(0);
  });

  async function peakOf(gate?: ReturnType<typeof createGate>) {
    let inFlight = 0;
    let peak = 0;
    let served = 0;
    const stub: GmailMailClient = {
      profile: () => Promise.resolve({ historyId: "1" }),
      history: async () => {
        inFlight += 1;
        peak = Math.max(peak, inFlight);
        await new Promise((resolve) => setTimeout(resolve, 200));
        inFlight -= 1;
        served += 1;
        return { messages: [], historyId: "1", unreadable: 0 };
      },
      message: () => Promise.resolve("gone"),
    };
    // the worst case: every account's timer fires at the same instant (a resume, a network return)
    const watchers = fifty(stub, gate, true);
    for (const w of watchers) w.start();
    await tick(50 * 200 + 1);
    for (const w of watchers) w.stop();
    expect(vi.getTimerCount()).toBe(0);
    return { peak, served };
  }

  it("polls go through the shared gate: at most five run at once, and all fifty get their turn", async () => {
    const { peak, served } = await peakOf(createGate(5));
    expect(served).toBe(50);
    expect(peak).toBe(5);
  });

  it("without the gate the same moment would be fifty polls at once: the gate is what bounds it", async () => {
    expect((await peakOf()).peak).toBe(50);
  });
});

describe("GmailWatcher: bounded memory", () => {
  it("remembers at most ANNOUNCED_MAX ids", async () => {
    const budgets = new GmailBudgets({
      limits: {
        perMinute: 10_000_000,
        perAccountDay: 10_000_000,
        allAccountsDay: 10_000_000,
        mailPerAccountDay: 10_000_000,
        mailAllAccountsDay: 10_000_000,
      },
    });
    const t = setup({ maxPerDrain: 25, budgets });
    await started(t);
    // more than the cap announced over many polls; a re-listed old id is then announced again, so the set is bounded, not unbounded
    for (let round = 0; round < Math.ceil((ANNOUNCED_MAX + 40) / 25); round += 1) {
      for (let i = 0; i < 25; i += 1) t.fake.deliver({ from: "a@x.example" });
      await tick(GMAIL_POLL.baseMs + GMAIL_POLL.jitterMs);
    }
    expect(t.messages.length).toBeGreaterThan(ANNOUNCED_MAX);
    const first = t.messages[0]?.id ?? "";
    t.fake.history.push({ id: t.fake.historyId + 1, added: [first] });
    t.fake.historyId += 1;
    const before = t.messages.length;
    await tick(GMAIL_POLL.baseMs + GMAIL_POLL.jitterMs);
    expect(t.messages.length).toBe(before + 1);
  });
});
