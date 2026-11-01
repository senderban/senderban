import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AdapterError } from "../../src/adapter.js";
import { DeltaExpiredError, DeltaTooLargeError } from "../../src/graph/client.js";
import type { GraphDeltaFrom, GraphDeltaPage, GraphMail } from "../../src/graph/client.js";
import {
  OUTLOOK_ANNOUNCED_MAX,
  OUTLOOK_LATE_MS,
  OUTLOOK_MAX_PAGES,
  OUTLOOK_REJECTED_HALT,
  OUTLOOK_ROUND_MS,
  OutlookWatcher,
} from "../../src/graph/watcher.js";
import type {
  OutlookCursor,
  OutlookGap,
  OutlookIncoming,
  OutlookPollEvent,
  OutlookWatcherState,
} from "../../src/graph/watcher.js";

const MINUTE = 60_000;
const NOW = Date.UTC(2026, 10, 1, 12, 0, 0);
const link = (n: number) => `https://graph.microsoft.com/v1.0/delta?$deltatoken=${String(n)}`;

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(NOW);
});
afterEach(() => {
  vi.useRealTimers();
});
const tick = (ms: number) => vi.advanceTimersByTimeAsync(ms);

type Answer = GraphDeltaPage | Error | ((from: GraphDeltaFrom) => GraphDeltaPage | Error);

function setup(options: { stored?: OutlookCursor; maxPerDrain?: number } = {}) {
  const script: Answer[] = [];
  const asked: GraphDeltaFrom[] = [];
  let serial = 0;
  const quiet = (): GraphDeltaPage => {
    serial += 1;
    return { mail: [], unreadable: 0, link: link(serial), more: false };
  };
  let cursor = options.stored;
  const saved: OutlookCursor[] = [];
  const told: OutlookIncoming[] = [];
  const overflow: number[] = [];
  const gaps: OutlookGap[] = [];
  const states: OutlookWatcherState[] = [];
  const polls: OutlookPollEvent[] = [];
  const watcher = new OutlookWatcher({
    accountId: "ms-1.graph",
    client: {
      delta: (from) => {
        asked.push(from);
        const next = script.shift() ?? quiet();
        const answer = typeof next === "function" ? next(from) : next;
        return answer instanceof Error ? Promise.reject(answer) : Promise.resolve(answer);
      },
    },
    cursors: {
      get: () => cursor,
      set: (_id, value) => {
        cursor = value;
        saved.push(value);
      },
    },
    onMessage: (_id, message) => void told.push(message),
    onOverflow: (_id, skipped) => void overflow.push(skipped),
    onGap: (_id, gap) => void gaps.push(gap),
    onState: (_id, state) => void states.push(state),
    onPoll: (_id, event) => void polls.push(event),
    random: () => 0,
    ...(options.maxPerDrain === undefined ? {} : { maxPerDrain: options.maxPerDrain }),
  });
  return {
    watcher,
    script,
    asked,
    told,
    overflow,
    gaps,
    states,
    polls,
    saved,
    cursor: () => cursor,
  };
}

const mail = (
  id: string,
  receivedMs: number,
  from: string | null = "spam@news.example.com",
): GraphMail => ({
  id,
  from,
  subject: `subject ${id}`,
  receivedMs,
});
const page = (
  mails: GraphMail[],
  n: number,
  over: Partial<GraphDeltaPage> = {},
): GraphDeltaPage => ({
  mail: mails,
  unreadable: 0,
  link: link(n),
  more: false,
  ...over,
});
const stored = (over: Partial<OutlookCursor> = {}): OutlookCursor => ({
  link: link(0),
  newestMs: NOW - MINUTE,
  roundMs: NOW - MINUTE,
  ...over,
});

describe("OutlookWatcher", () => {
  it("starts a first round from now and announces nothing that was there before", async () => {
    const t = setup();
    t.watcher.start();
    await tick(0);
    expect(t.asked).toEqual([{ sinceMs: NOW }]);
    expect(t.cursor()).toEqual({ link: link(1), newestMs: NOW, roundMs: NOW });
    expect(t.told).toEqual([]);
    expect(t.polls[0]).toMatchObject({ outcome: "first", pages: 1 });
    expect(t.watcher.current).toBe("watching");
  });

  it("goes on from the stored link, one request a poll, and keeps the new link", async () => {
    const t = setup({ stored: stored() });
    t.script.push(page([mail("a", NOW - 5_000)], 7));
    t.watcher.start();
    await tick(0);
    expect(t.asked).toEqual([{ link: link(0) }]);
    expect(t.told).toEqual([{ id: "a", from: "spam@news.example.com", subject: "subject a" }]);
    expect(t.cursor()).toEqual({ link: link(7), newestMs: NOW - 5_000, roundMs: NOW - MINUTE });
    await tick(MINUTE);
    expect(t.asked).toHaveLength(2);
    expect(t.asked[1]).toEqual({ link: link(7) });
  });

  it("polls about once a minute: 1,440 a day", async () => {
    const t = setup({ stored: stored({ roundMs: NOW }) });
    t.watcher.start();
    await tick(10 * MINUTE);
    // random() = 0: the shortest gap of 50 s.
    expect(t.asked.length).toBeGreaterThanOrEqual(10);
    expect(t.asked.length).toBeLessThanOrEqual(13);
  });

  it("announces a mail with no readable sender as such", async () => {
    const t = setup({ stored: stored() });
    t.script.push(page([mail("a", NOW - 5_000, null)], 1));
    t.watcher.start();
    await tick(0);
    expect(t.told[0]?.from).toBeNull();
  });

  it("does not announce a replay, in one poll or the next", async () => {
    const t = setup({ stored: stored() });
    t.script.push(page([mail("a", NOW - 5_000), mail("a", NOW - 5_000)], 1));
    t.script.push(page([mail("a", NOW - 5_000)], 2));
    t.watcher.start();
    await tick(0);
    await tick(MINUTE);
    expect(t.told).toHaveLength(1);
  });

  it("does not take a change to old mail for new mail", async () => {
    const newestMs = NOW - MINUTE;
    const t = setup({ stored: stored({ newestMs }) });
    t.script.push(page([mail("old", newestMs - OUTLOOK_LATE_MS - 1)], 1));
    t.watcher.start();
    await tick(0);
    expect(t.told).toEqual([]);
    expect(t.polls[0]).toMatchObject({ found: 0 });
  });

  it("still announces mail that took a while to show up", async () => {
    const newestMs = NOW - MINUTE;
    const t = setup({ stored: stored({ newestMs }) });
    t.script.push(page([mail("late", newestMs - OUTLOOK_LATE_MS + 1)], 1));
    t.watcher.start();
    await tick(0);
    expect(t.told.map((m) => m.id)).toEqual(["late"]);
  });

  it("does not let a time from the future raise the floor over real mail", async () => {
    const t = setup({ stored: stored() });
    t.script.push(page([mail("future", NOW + 10 * OUTLOOK_LATE_MS)], 1));
    t.script.push(page([mail("real", NOW + 2_000)], 2));
    t.watcher.start();
    await tick(0);
    expect(t.cursor()?.newestMs).toBe(NOW);
    await tick(MINUTE);
    expect(t.told.map((m) => m.id)).toEqual(["future", "real"]);
  });

  it("announces the newest of a burst whatever order it came in, and counts the rest", async () => {
    const t = setup({ stored: stored(), maxPerDrain: 2 });
    t.script.push(
      page(
        [mail("b", NOW - 2_000), mail("d", NOW), mail("a", NOW - 3_000), mail("c", NOW - 1_000)],
        1,
      ),
    );
    t.watcher.start();
    await tick(0);
    expect(t.told.map((m) => m.id)).toEqual(["c", "d"]);
    expect(t.overflow).toEqual([2]);
    expect(t.polls[0]).toMatchObject({ outcome: "gap", found: 4, announced: 2 });
  });

  it("does not announce later what it counted as skipped", async () => {
    const t = setup({ stored: stored(), maxPerDrain: 1 });
    t.script.push(page([mail("a", NOW - 2_000), mail("b", NOW - 1_000)], 1));
    t.script.push(page([mail("a", NOW - 2_000)], 2));
    t.watcher.start();
    await tick(0);
    await tick(MINUTE);
    expect(t.told.map((m) => m.id)).toEqual(["b"]);
  });

  it("reads the pages of a round in turn and stops at the page limit, keeping its place", async () => {
    const t = setup({ stored: stored() });
    for (let n = 1; n <= OUTLOOK_MAX_PAGES + 1; n += 1) {
      t.script.push(page([mail(`m${String(n)}`, NOW - 60 + n)], n, { more: true }));
    }
    t.watcher.start();
    await tick(0);
    expect(t.asked).toHaveLength(OUTLOOK_MAX_PAGES);
    expect(t.cursor()?.link).toBe(link(OUTLOOK_MAX_PAGES));
    await tick(MINUTE);
    expect(t.asked[OUTLOOK_MAX_PAGES]).toEqual({ link: link(OUTLOOK_MAX_PAGES) });
  });

  it("does not move the link when a page fails: it reads again and announces nothing twice", async () => {
    const t = setup({ stored: stored() });
    t.script.push(page([mail("a", NOW - 1_000)], 1, { more: true }));
    t.script.push(new AdapterError("TRANSIENT", "busy"));
    t.script.push(page([mail("a", NOW - 1_000)], 2, { more: true }));
    t.script.push(page([], 3));
    t.watcher.start();
    await tick(0);
    expect(t.told).toEqual([]);
    expect(t.cursor()?.link).toBe(link(0));
    expect(t.watcher.current).toBe("backoff");
    await tick(2 * MINUTE);
    expect(t.told.map((m) => m.id)).toEqual(["a"]);
    expect(t.cursor()?.link).not.toBe(link(0));
  });

  it("starts a new round from the newest mail seen when the link is lost: no mail lost, no notice", async () => {
    const newestMs = NOW - 3 * 3_600_000;
    const t = setup({ stored: stored({ newestMs }) });
    t.script.push(new DeltaExpiredError());
    t.script.push(page([mail("while-away", newestMs + 1_000)], 9));
    t.watcher.start();
    await tick(0);
    expect(t.asked).toEqual([{ link: link(0) }, { sinceMs: newestMs }]);
    expect(t.told.map((m) => m.id)).toEqual(["while-away"]);
    expect(t.gaps).toEqual([]);
    expect(t.cursor()?.link).toBe(link(9));
  });

  it("does not ask for ever when a new round is refused as well", async () => {
    const t = setup({ stored: stored() });
    t.script.push(new DeltaExpiredError());
    t.script.push(new AdapterError("REJECTED", "no"));
    t.watcher.start();
    await tick(0);
    expect(t.asked).toHaveLength(2);
    expect(t.watcher.current).toBe("backoff");
  });

  it("forgets what it read of a lost link: the new round says it again", async () => {
    const t = setup({ stored: stored() });
    t.script.push(page([mail("a", NOW - 1_000)], 1, { more: true }));
    t.script.push(new DeltaExpiredError());
    t.script.push(page([mail("a", NOW - 1_000)], 2));
    t.watcher.start();
    await tick(0);
    expect(t.asked[2]).toEqual({ sinceMs: NOW - MINUTE });
    expect(t.told.map((m) => m.id)).toEqual(["a"]);
    expect(t.polls[0]?.pages).toBe(2);
  });

  it("starts a new round after a week, from the newest mail seen", async () => {
    const newestMs = NOW - 5_000;
    const t = setup({ stored: stored({ newestMs, roundMs: NOW - OUTLOOK_ROUND_MS }) });
    t.watcher.start();
    await tick(0);
    expect(t.asked).toEqual([{ sinceMs: newestMs }]);
    expect(t.cursor()).toMatchObject({ newestMs, roundMs: NOW });
  });

  it("does not tell again the newest mail a lost link brings back, after a restart", async () => {
    const newestMs = NOW - MINUTE;
    const t = setup({ stored: stored({ newestMs }) });
    t.script.push(new DeltaExpiredError());
    t.script.push(page([mail("newest", newestMs), mail("later", newestMs + 1_000)], 1));
    t.watcher.start();
    await tick(0);
    expect(t.asked[1]).toEqual({ sinceMs: newestMs });
    expect(t.told.map((m) => m.id)).toEqual(["later"]);
  });

  it("does not tell again the newest mail a new round brings back, after a restart", async () => {
    const newestMs = NOW - 3 * 24 * 60 * MINUTE;
    const t = setup({ stored: stored({ newestMs, roundMs: NOW - OUTLOOK_ROUND_MS - 1_000 }) });
    t.script.push(page([mail("newest", newestMs), mail("later", newestMs + 1_000)], 1));
    t.watcher.start();
    await tick(0);
    expect(t.asked).toEqual([{ sinceMs: newestMs }]);
    expect(t.told.map((m) => m.id)).toEqual(["later"]);
  });

  it("keeps the round's start while the round lasts", async () => {
    const roundMs = NOW - OUTLOOK_ROUND_MS + MINUTE * 10;
    const t = setup({ stored: stored({ roundMs }) });
    t.watcher.start();
    await tick(0);
    expect(t.cursor()?.roundMs).toBe(roundMs);
  });

  it("starts from now after a page too big, and says mail was not announced", async () => {
    const t = setup({ stored: stored() });
    t.script.push(new DeltaTooLargeError());
    t.watcher.start();
    await tick(0);
    expect(t.asked).toEqual([{ link: link(0) }, { sinceMs: NOW }]);
    expect(t.gaps).toEqual(["too-large"]);
    expect(t.cursor()).toMatchObject({ newestMs: NOW, roundMs: NOW });
  });

  it("says when entries could not be read, and moves on", async () => {
    const t = setup({ stored: stored() });
    t.script.push(page([], 3, { unreadable: 2 }));
    t.watcher.start();
    await tick(0);
    expect(t.gaps).toEqual(["unreadable"]);
    expect(t.cursor()?.link).toBe(link(3));
  });

  it("treats a stored link that no longer reads as no cursor", async () => {
    const t = setup({ stored: stored({ link: "https://evil.example/x" }) });
    t.watcher.start();
    await tick(0);
    expect(t.asked).toEqual([{ sinceMs: expect.any(Number) as number }]);
  });

  it("halts on a refused sign-in, and only start() asks again", async () => {
    const t = setup({ stored: stored() });
    t.script.push(new AdapterError("AUTH_REQUIRED", "no"));
    t.watcher.start();
    await tick(0);
    expect(t.watcher.current).toBe("halted-auth");
    await tick(60 * MINUTE);
    t.watcher.resume();
    t.watcher.resumeNow();
    await tick(60 * MINUTE);
    expect(t.asked).toHaveLength(1);
  });

  it("halts after Microsoft refused several polls in a row", async () => {
    const t = setup({ stored: stored() });
    for (let n = 0; n < OUTLOOK_REJECTED_HALT; n += 1) {
      t.script.push(new AdapterError("REJECTED", "no"));
    }
    t.watcher.start();
    await tick(60 * MINUTE);
    expect(t.watcher.current).toBe("halted-rejected");
    expect(t.asked).toHaveLength(OUTLOOK_REJECTED_HALT);
  });

  it("writes and announces nothing from a poll called off midway", async () => {
    const t = setup({ stored: stored() });
    t.script.push(() => {
      t.watcher.stop();
      return page([mail("a", NOW - 1_000)], 1);
    });
    t.watcher.start();
    await tick(0);
    expect(t.told).toEqual([]);
    expect(t.saved).toEqual([]);
    await tick(10 * MINUTE);
    expect(t.asked).toHaveLength(1);
  });

  it("does not let a broken consumer hold the link", async () => {
    const cursor = { value: stored() };
    const watcher = new OutlookWatcher({
      accountId: "ms-1.graph",
      client: { delta: () => Promise.resolve(page([mail("a", NOW - 1_000)], 5)) },
      cursors: {
        get: () => cursor.value,
        set: (_id, value) => {
          cursor.value = value;
        },
      },
      onMessage: () => {
        throw new Error("toast broke");
      },
      random: () => 0,
    });
    watcher.start();
    await tick(0);
    expect(cursor.value.link).toBe(link(5));
    expect(watcher.current).toBe("watching");
    watcher.stop();
  });

  it("remembers a bounded number of ids", async () => {
    const t = setup({ stored: stored(), maxPerDrain: 1 });
    const many = Array.from({ length: OUTLOOK_ANNOUNCED_MAX + 1 }, (_, n) =>
      mail(`m${String(n)}`, NOW - 1_000),
    );
    t.script.push(page(many, 1));
    t.script.push(page([mail("m0", NOW - 1_000)], 2));
    t.watcher.start();
    await tick(0);
    await tick(MINUTE);
    // The oldest id fell out, and the mail comes round again: bounded memory has this one cost.
    expect(t.told.map((m) => m.id)).toContain("m0");
  });
});
