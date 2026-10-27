import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AdapterError } from "../../src/adapter.js";
import { createGate } from "../../src/gate.js";
import { GmailBudgets } from "../../src/gmail/budget.js";
import {
  HistoryExpiredError,
  MalformedAnswerError,
  createGmailMailClient,
} from "../../src/gmail/mail-client.js";
import type { GmailMailClient, HistoryPage, MessageMetadata } from "../../src/gmail/mail-client.js";
import {
  GMAIL_MAX_PER_DRAIN_LIMIT,
  GMAIL_MESSAGE_ATTEMPTS,
  GMAIL_MESSAGE_PATIENCE_MS,
  GMAIL_POLL,
  GMAIL_POLL_DEADLINE_MS,
  GMAIL_REJECTED_HALT,
  GMAIL_START_SPREAD_MS,
  GmailWatcher,
} from "../../src/gmail/watcher.js";
import type {
  GmailGap,
  GmailIncoming,
  GmailPollEvent,
  GmailWatcherState,
} from "../../src/gmail/watcher.js";
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

const page = (over: Partial<HistoryPage> = {}): HistoryPage => ({
  messages: [],
  historyId: "10",
  unreadable: 0,
  ...over,
});
const meta = (id: string, from = "a@x.example"): MessageMetadata => ({
  id,
  labelIds: ["INBOX"],
  headers: [
    { name: "From", value: `<${from}>` },
    { name: "Subject", value: "s" },
  ],
  headersComplete: true,
});

/** A watcher over a scripted client: every call is recorded, and the test decides what it answers. */
function rig(client: Partial<GmailMailClient>, startCursor = "10") {
  const calls: string[] = [];
  const stub: GmailMailClient = {
    profile: (...a) => {
      calls.push("profile");
      return client.profile?.(...a) ?? Promise.resolve({ historyId: "10" });
    },
    history: (...a) => {
      calls.push("history");
      return client.history?.(...a) ?? Promise.resolve(page());
    },
    message: (id, ...a) => {
      calls.push(`message:${id}`);
      return client.message?.(id, ...a) ?? Promise.resolve(meta(id));
    },
  };
  const store = new Map<string, string>();
  store.set("acct", startCursor);
  const messages: GmailIncoming[] = [];
  const gaps: GmailGap[] = [];
  const states: GmailWatcherState[] = [];
  const polls: GmailPollEvent[] = [];
  const watcher = new GmailWatcher({
    accountId: "acct",
    client: stub,
    cursors: { get: (a) => store.get(a), set: (a, h) => void store.set(a, h) },
    onMessage: (_a, m) => void messages.push(m),
    onGap: (_a, g) => void gaps.push(g),
    onState: (_a, s) => void states.push(s),
    onPoll: (_a, e) => void polls.push(e),
    random: () => 0,
  });
  return { watcher, calls, store, messages, gaps, states, polls };
}

describe("stop() and start() while a poll is in the air", () => {
  it("a watcher restarted while its old poll is still running polls again (it used to stay `starting` for ever)", async () => {
    let held: (() => void) | null = null;
    const r = rig({
      history: (_c, _t, signal) =>
        new Promise((resolve, reject) => {
          if (held === null) {
            held = () => {
              resolve(page());
            };
            signal?.addEventListener(
              "abort",
              () => {
                reject(signal.reason as Error);
              },
              { once: true },
            );
          } else resolve(page());
        }),
    });
    r.watcher.start();
    await tick(0);
    expect(r.calls).toEqual(["history"]);
    r.watcher.stop();
    r.watcher.start();
    await tick(0);
    await tick(GMAIL_START_SPREAD_MS);
    expect(r.calls.filter((c) => c === "history").length).toBeGreaterThanOrEqual(2);
    expect(r.watcher.current).toBe("watching");
    await tick(2 * GMAIL_POLL.baseMs);
    expect(r.calls.filter((c) => c === "history").length).toBeGreaterThanOrEqual(3);
  });

  it("the same with a message read in the air", async () => {
    const r = rig({
      history: () =>
        Promise.resolve(page({ messages: [{ id: "m1", labelIds: ["INBOX"] }], historyId: "11" })),
      message: (_id, signal) =>
        new Promise((_resolve, reject) => {
          signal?.addEventListener(
            "abort",
            () => {
              reject(signal.reason as Error);
            },
            { once: true },
          );
        }),
    });
    r.watcher.start();
    await tick(0);
    r.watcher.stop();
    r.watcher.start();
    await tick(0);
    await tick(GMAIL_START_SPREAD_MS);
    expect(r.calls.filter((c) => c === "history").length).toBeGreaterThanOrEqual(2);
    expect(r.messages).toEqual([]);
    expect(r.store.get("acct")).toBe("10");
  });

  it("a poll that ends after stop() changes nothing: not the state, not lastOkAt, not the cursor", async () => {
    let release: () => void = () => undefined;
    const r = rig({
      history: () =>
        new Promise((resolve) => {
          release = () => {
            resolve(page({ messages: [{ id: "m1", labelIds: ["INBOX"] }], historyId: "11" }));
          };
        }),
    });
    r.watcher.start();
    await tick(0);
    r.watcher.stop();
    release();
    await tick(0);
    await tick(HOUR);
    expect(r.watcher.current).toBe("stopped");
    expect(r.watcher.lastOkAt).toBeNull();
    expect(r.store.get("acct")).toBe("10");
    expect(r.messages).toEqual([]);
    expect(r.calls.filter((c) => c.startsWith("message"))).toEqual([]);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("stop() aborts the request of the poll in the air, and no further page is asked for", async () => {
    const signals: (AbortSignal | undefined)[] = [];
    let first: (p: HistoryPage) => void = () => undefined;
    const r = rig({
      history: (_c, _t, signal) => {
        signals.push(signal);
        return new Promise((resolve) => {
          first = resolve;
        });
      },
    });
    r.watcher.start();
    await tick(0);
    r.watcher.stop();
    expect(signals[0]?.aborted).toBe(true);
    first(page({ nextPageToken: "t2", messages: [{ id: "m1", labelIds: ["INBOX"] }] }));
    await tick(0);
    await tick(HOUR);
    expect(r.calls).toEqual(["history"]);
  });
});

describe("a poll that was called off hands nothing over", () => {
  it("the poll's signal reaches the message reads too, and a read that comes back after the deadline is not announced", async () => {
    const signals: (AbortSignal | undefined)[] = [];
    let late: (m: MessageMetadata) => void = () => undefined;
    let first = true;
    const r = rig({
      history: () =>
        Promise.resolve(page({ messages: [{ id: "m1", labelIds: ["INBOX"] }], historyId: "11" })),
      message: (id, signal) => {
        signals.push(signal);
        if (first) {
          first = false;
          // the read that does not come back in time: it ignores the signal, as a stuck token refresh would
          return new Promise((resolve) => {
            late = resolve;
          });
        }
        return Promise.reject(new AdapterError("TRANSIENT", "still down"));
      },
    });
    r.watcher.start();
    await tick(0);
    await tick(GMAIL_POLL_DEADLINE_MS + SECOND);
    expect(signals[0]?.aborted).toBe(true);
    expect(r.watcher.current).toBe("backoff");
    late(meta("m1"));
    await tick(0);
    await tick(0);
    expect(r.messages).toEqual([]);
    expect(r.store.get("acct")).toBe("10");
    r.watcher.stop();
  });
});

describe("a poll that waits for a gate slot", () => {
  /** A watcher that holds the only slot of the gate until `release()`; the other watchers queue behind it. */
  function blocker(gate: ReturnType<typeof createGate>) {
    let release: () => void = () => undefined;
    const w = new GmailWatcher({
      accountId: "blocker",
      client: {
        profile: () => Promise.resolve({ historyId: "1" }),
        history: () =>
          new Promise((resolve) => {
            release = () => {
              resolve(page());
            };
          }),
        message: () => Promise.resolve("gone"),
      },
      cursors: { get: () => "1", set: () => undefined },
      onMessage: () => undefined,
      gate,
      random: () => 0,
    });
    return {
      w,
      release: () => {
        release();
      },
    };
  }
  function queued(gate: ReturnType<typeof createGate>, hold: boolean) {
    const calls: string[] = [];
    const w = new GmailWatcher({
      accountId: "queued",
      client: {
        profile: () => Promise.resolve({ historyId: "1" }),
        history: () => {
          calls.push("history");
          return hold ? new Promise(() => undefined) : Promise.resolve(page());
        },
        message: () => Promise.resolve("gone"),
      },
      cursors: { get: () => "1", set: () => undefined },
      onMessage: () => undefined,
      gate,
      random: () => 0,
    });
    return { w, calls };
  }

  it("stop() while it is queued: no unhandled rejection, and no request when its turn comes", async () => {
    const gate = createGate(1);
    const b = blocker(gate);
    const q = queued(gate, false);
    b.w.start();
    await tick(0);
    q.w.start();
    await tick(0);
    q.w.stop();
    b.release();
    await tick(0);
    await tick(0);
    await tick(HOUR);
    expect(q.calls).toEqual([]);
    expect(q.w.current).toBe("stopped");
    b.w.stop();
    await tick(0); // the blocker's own poll in the air settles and drops its deadline timer
    expect(vi.getTimerCount()).toBe(0);
  });

  it("restarted while the old poll is still queued: the new poll runs once, and a resume does not start a second", async () => {
    const gate = createGate(1);
    const b = blocker(gate);
    const q = queued(gate, true);
    b.w.start();
    await tick(0);
    q.w.start();
    await tick(0);
    q.w.stop();
    q.w.start();
    await tick(GMAIL_START_SPREAD_MS);
    expect(q.calls).toEqual([]); // both queued behind the blocker
    b.release();
    await tick(0);
    await tick(0);
    expect(q.calls).toEqual(["history"]); // the stale one sent nothing, the new one is in the air
    q.w.resumeNow();
    await tick(GMAIL_START_SPREAD_MS);
    expect(q.calls).toEqual(["history"]);
    q.w.stop();
    b.w.stop();
  });

  it("its deadline does not start until it has its slot", async () => {
    const gate = createGate(1);
    const b = blocker(gate);
    const q = queued(gate, false);
    b.w.start();
    await tick(0);
    q.w.start();
    await tick(0);
    await tick(GMAIL_POLL_DEADLINE_MS - SECOND); // waiting in the queue for almost the whole deadline
    b.release();
    await tick(0);
    await tick(0);
    expect(q.calls).toEqual(["history"]);
    expect(q.w.current).toBe("watching");
    q.w.stop();
    b.w.stop();
  });
});

describe("a message that Google does not serve", () => {
  it("after half an hour of 503 it is given up and reported, and not before", async () => {
    const fake = new FakeGmail();
    const store = new Map<string, string>();
    const gaps: GmailGap[] = [];
    const w = new GmailWatcher({
      accountId: "acct",
      client: createGmailMailClient({
        getAccessToken: () => Promise.resolve(fake.token),
        fetch: fake.fetch,
      }),
      cursors: { get: (a) => store.get(a), set: (a, h) => void store.set(a, h) },
      onMessage: () => undefined,
      onGap: (_a, g) => void gaps.push(g),
      random: () => 0,
    });
    w.start();
    await tick(0);
    fake.deliver({ from: "a@x.example" });
    fake.forcedFor.set("GET", Array.from({ length: 80 }, () => ["pass" as const, 503]).flat());
    await tick(GMAIL_MESSAGE_PATIENCE_MS - 5 * MINUTE);
    expect(gaps).toEqual([]);
    expect(store.get("acct")).toBe("1000");
    await tick(15 * MINUTE);
    expect(gaps).toEqual(["skipped"]);
    expect(store.get("acct")).toBe("1001");
    w.stop();
  });
});

describe("the deadline of a poll", () => {
  it("a poll that never ends is called off after the deadline, counts as a failure, and frees its gate slot", async () => {
    const hang: GmailMailClient["history"] = () => new Promise(() => undefined);
    const gate = createGate(1);
    const stuck = new GmailWatcher({
      accountId: "stuck",
      client: {
        profile: () => Promise.resolve({ historyId: "1" }),
        history: hang,
        message: () => Promise.resolve("gone"),
      },
      cursors: { get: () => "1", set: () => undefined },
      onMessage: () => undefined,
      gate,
      random: () => 0,
    });
    let served = 0;
    const other = new GmailWatcher({
      accountId: "other",
      client: {
        profile: () => Promise.resolve({ historyId: "1" }),
        history: () => {
          served += 1;
          return Promise.resolve(page());
        },
        message: () => Promise.resolve("gone"),
      },
      cursors: { get: () => "1", set: () => undefined },
      onMessage: () => undefined,
      gate,
      random: () => 0,
    });
    stuck.start();
    await tick(0);
    other.start();
    await tick(GMAIL_POLL_DEADLINE_MS - SECOND);
    expect(served).toBe(0); // the slot is still held
    await tick(2 * SECOND);
    expect(stuck.current).toBe("backoff");
    expect(served).toBe(1); // the next account got the slot
    stuck.stop();
    other.stop();
    expect(vi.getTimerCount()).toBe(0);
  });
});

describe("failures that belong to the network are not the message's", () => {
  it("a message read that fails with a 503 for many polls is never given up; it is announced when Google answers", async () => {
    const fake = new FakeGmail();
    const budgets = new GmailBudgets();
    const client = budgets.wrapMail(
      createGmailMailClient({
        getAccessToken: () => Promise.resolve(fake.token),
        fetch: fake.fetch,
      }),
      { key: "a", account: "acct-a" },
    );
    const store = new Map<string, string>();
    const gaps: GmailGap[] = [];
    const messages: GmailIncoming[] = [];
    const w = new GmailWatcher({
      accountId: "acct",
      client,
      cursors: { get: (a) => store.get(a), set: (a, h) => void store.set(a, h) },
      onMessage: (_a, m) => void messages.push(m),
      onGap: (_a, g) => void gaps.push(g),
      random: () => 0,
    });
    w.start();
    await tick(0);
    fake.deliver({ from: "a@x.example" });
    // history passes, the message read answers 503, for more polls than a message gets tries
    fake.forcedFor.set(
      "GET",
      Array.from({ length: GMAIL_MESSAGE_ATTEMPTS + 3 }, () => ["pass" as const, 503]).flat(),
    );
    await tick(HOUR);
    expect(gaps).toEqual([]);
    expect(messages).toHaveLength(1);
    expect(store.get("acct")).toBe("1001");
    w.stop();
  });

  it("an answer that is not what it should be, or a refusal of that one message, does count, and the mail is given up and reported", async () => {
    for (const failure of [
      new MalformedAnswerError("message get"),
      new AdapterError("REJECTED", "no"),
    ]) {
      const r = rig({
        history: () =>
          Promise.resolve(page({ messages: [{ id: "m1", labelIds: ["INBOX"] }], historyId: "11" })),
        message: () => Promise.reject(failure),
      });
      r.watcher.start();
      await tick(HOUR);
      expect(r.gaps).toEqual(["skipped"]);
      expect(r.store.get("acct")).toBe("11");
      r.watcher.stop();
    }
  });

  it("what is counted against a message is forgotten when newer mail pushes it out of the batch", async () => {
    // Poll 1: m1 fails (one try). Poll 2: 30 newer messages push m1 out of the batch of five. Polls 3 to 5: m1 comes back and fails.
    // With the count forgotten m1 is given up on its fourth read (polls 1, 3, 4, 5 are three tries after the reset: 1, 2, 3);
    // had poll 1's try been kept it would be given up on the third read.
    let phase = 0;
    const many = Array.from({ length: 30 }, (_, i) => ({
      id: `n${String(i)}`,
      labelIds: ["INBOX"],
    }));
    const r = rig({
      history: () => {
        phase += 1;
        const list =
          phase === 2
            ? [{ id: "m1", labelIds: ["INBOX"] }, ...many]
            : [{ id: "m1", labelIds: ["INBOX"] }];
        return Promise.resolve(page({ messages: list, historyId: String(10 + phase) }));
      },
      message: (id) =>
        id === "m1"
          ? Promise.reject(new MalformedAnswerError("message get"))
          : Promise.resolve(meta(id)),
    });
    r.watcher.start();
    await tick(HOUR);
    expect(r.gaps).toEqual(["skipped"]);
    expect(r.calls.filter((c) => c === "message:m1")).toHaveLength(4);
    r.watcher.stop();
  });
});

describe("a Google that keeps refusing", () => {
  it(`stops after ${String(GMAIL_REJECTED_HALT)} polls in a row, says so, and begins again on start()`, async () => {
    const fake = new FakeGmail();
    const client = createGmailMailClient({
      getAccessToken: () => Promise.resolve(fake.token),
      fetch: fake.fetch,
    });
    const store = new Map<string, string>([["acct", "1000"]]);
    const states: GmailWatcherState[] = [];
    const w = new GmailWatcher({
      accountId: "acct",
      client,
      cursors: { get: (a) => store.get(a), set: (a, h) => void store.set(a, h) },
      onMessage: () => undefined,
      onState: (_a, s) => void states.push(s),
      random: () => 0,
    });
    fake.forcedFor.set(
      "GET",
      Array.from({ length: 50 }, () => 400),
    );
    w.start();
    await tick(HOUR);
    expect(w.current).toBe("halted-rejected");
    expect(fake.calls).toHaveLength(GMAIL_REJECTED_HALT);
    await tick(3 * HOUR);
    expect(fake.calls).toHaveLength(GMAIL_REJECTED_HALT);
    w.resumeNow(); // a halted watcher stays halted
    await tick(HOUR);
    expect(fake.calls).toHaveLength(GMAIL_REJECTED_HALT);
    fake.forcedFor.set("GET", []);
    w.start();
    await tick(GMAIL_START_SPREAD_MS);
    expect(w.current).toBe("watching");
    w.stop();
  });

  it("a poll that fails for another reason in between starts the count again", async () => {
    let n = 0;
    const r = rig({
      history: () => {
        n += 1;
        return Promise.reject(
          n % 3 === 0 ? new AdapterError("TRANSIENT", "net") : new AdapterError("REJECTED", "no"),
        );
      },
    });
    r.watcher.start();
    await tick(10 * HOUR);
    expect(n).toBeGreaterThan(3 * GMAIL_REJECTED_HALT);
    expect(r.watcher.current).not.toBe("halted-rejected");
    r.watcher.stop();
  });

  it("a poll that works in between starts the count again", async () => {
    let n = 0;
    const r = rig({
      history: () => {
        n += 1;
        return n % 5 === 0
          ? Promise.resolve(page())
          : Promise.reject(new AdapterError("REJECTED", "no"));
      },
    });
    r.watcher.start();
    await tick(10 * HOUR);
    expect(r.watcher.current).not.toBe("halted-rejected");
    r.watcher.stop();
  });

  it("a refused sign-in on a message read halts the watcher; the mail that did read is announced once and the cursor stays", async () => {
    const r = rig({
      history: () =>
        Promise.resolve(
          page({
            messages: [
              { id: "m1", labelIds: ["INBOX"] },
              { id: "m2", labelIds: ["INBOX"] },
            ],
            historyId: "12",
          }),
        ),
      message: (id) =>
        id === "m2"
          ? Promise.reject(new AdapterError("AUTH_REQUIRED", "no"))
          : Promise.resolve(meta(id)),
    });
    r.watcher.start();
    await tick(0);
    await tick(0);
    expect(r.watcher.current).toBe("halted-auth");
    expect(r.messages.map((m) => m.id)).toEqual(["m1"]);
    expect(r.store.get("acct")).toBe("10");
    const calls = r.calls.length;
    r.watcher.resumeNow();
    await tick(3 * HOUR);
    expect(r.calls).toHaveLength(calls);
  });

  it("a rate limit on a message read backs off for quota; the readable mail is announced once and the cursor stays", async () => {
    let ok = false;
    const r = rig({
      history: () =>
        Promise.resolve(
          page({
            messages: [
              { id: "m1", labelIds: ["INBOX"] },
              { id: "m2", labelIds: ["INBOX"] },
            ],
            historyId: "12",
          }),
        ),
      message: (id) =>
        id === "m2" && !ok
          ? Promise.reject(new AdapterError("QUOTA_EXCEEDED", "slow"))
          : Promise.resolve(meta(id)),
    });
    r.watcher.start();
    await tick(0);
    await tick(0);
    expect(r.watcher.current).toBe("backoff");
    expect(r.messages.map((m) => m.id)).toEqual(["m1"]);
    expect(r.store.get("acct")).toBe("10");
    ok = true;
    await tick(5 * MINUTE);
    expect(r.messages.map((m) => m.id)).toEqual(["m1", "m2"]);
    expect(r.store.get("acct")).toBe("12");
    r.watcher.stop();
  });
});

describe("pages, ids and the consumer", () => {
  it("the same message on two pages is read once", async () => {
    let n = 0;
    const r = rig({
      history: () => {
        n += 1;
        return n === 1
          ? Promise.resolve(
              page({
                messages: [{ id: "m1", labelIds: ["INBOX"] }],
                nextPageToken: "t",
                historyId: "11",
              }),
            )
          : Promise.resolve(
              page({
                messages: [
                  { id: "m1", labelIds: ["INBOX"] },
                  { id: "m2", labelIds: ["INBOX"] },
                ],
                historyId: "12",
              }),
            );
      },
    });
    r.watcher.start();
    await tick(0);
    await tick(0);
    expect(r.calls.filter((c) => c.startsWith("message"))).toEqual(["message:m1", "message:m2"]);
    expect(r.messages).toHaveLength(2);
  });

  it("a history id past 2^53 is compared as a number would get wrong, never as a Number", async () => {
    const r = rig(
      { history: () => Promise.resolve(page({ historyId: "9007199254740993" })) },
      "9007199254740992",
    );
    r.watcher.start();
    await tick(0);
    await tick(0);
    expect(r.store.get("acct")).toBe("9007199254740993");
  });

  it("a cursor that goes expired on the second page restarts from the present and reports the gap", async () => {
    let n = 0;
    const r = rig({
      history: () => {
        n += 1;
        return n === 1
          ? Promise.resolve(
              page({
                messages: [{ id: "m1", labelIds: ["INBOX"] }],
                nextPageToken: "t",
                historyId: "11",
              }),
            )
          : Promise.reject(new HistoryExpiredError());
      },
      profile: () => Promise.resolve({ historyId: "50" }),
    });
    r.watcher.start();
    await tick(0);
    await tick(0);
    expect(r.gaps).toEqual(["expired"]);
    expect(r.store.get("acct")).toBe("50");
    expect(r.messages).toEqual([]);
    expect(r.calls.filter((c) => c.startsWith("message"))).toEqual([]);
  });

  it("a consumer that throws is counted in the poll event, so a broken toast path does not look like quiet", async () => {
    const polls: GmailPollEvent[] = [];
    const w = new GmailWatcher({
      accountId: "acct",
      client: {
        profile: () => Promise.resolve({ historyId: "10" }),
        history: () =>
          Promise.resolve(page({ messages: [{ id: "m1", labelIds: ["INBOX"] }], historyId: "11" })),
        message: (id) => Promise.resolve(meta(id)),
      },
      cursors: { get: () => "10", set: () => undefined },
      onMessage: () => {
        throw new Error("bug");
      },
      onPoll: (_a, e) => void polls.push(e),
      random: () => 0,
    });
    w.start();
    await tick(0);
    await tick(0);
    expect(polls[0]).toMatchObject({ outcome: "ok", announced: 1, consumerErrors: 1 });
    w.stop();
  });

  it("maxPerDrain is held to a ceiling: a caller cannot ask for a thousand parallel reads", async () => {
    const ids = Array.from({ length: 200 }, (_, i) => ({
      id: `m${String(i)}`,
      labelIds: ["INBOX"],
    }));
    const calls: string[] = [];
    const w = new GmailWatcher({
      accountId: "acct",
      client: {
        profile: () => Promise.resolve({ historyId: "10" }),
        history: () => Promise.resolve(page({ messages: ids, historyId: "11" })),
        message: (id) => {
          calls.push(id);
          return Promise.resolve(meta(id));
        },
      },
      cursors: { get: () => "10", set: () => undefined },
      onMessage: () => undefined,
      maxPerDrain: 1_000,
      random: () => 0,
    });
    w.start();
    await tick(0);
    await tick(0);
    expect(calls).toHaveLength(GMAIL_MAX_PER_DRAIN_LIMIT);
    w.stop();
  });

  it("lastOkAt survives stop() and start(); only `watching` says the watcher has polled lately", async () => {
    const r = rig({});
    r.watcher.start();
    await tick(0);
    await tick(0);
    const at = r.watcher.lastOkAt;
    expect(at).not.toBeNull();
    r.watcher.stop();
    r.watcher.start();
    expect(r.watcher.current).toBe("starting");
    expect(r.watcher.lastOkAt).toBe(at);
    r.watcher.stop();
  });
});
