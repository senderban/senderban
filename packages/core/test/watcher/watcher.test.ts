import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  UnreadableMailError,
  AccountWatcher,
  FatalWatchError,
  SUBJECT_MAX,
  SUBJECT_SCAN_MAX,
  refusedByServer,
  sanitizeSubject,
  toIncoming,
  parseDeliveredAt,
  DELIVERED_AT,
  parseSpamScore,
  SPAM_HEADER_MAX_BYTES,
  SPAM_SCORE,
} from "../../src/watcher/watcher.js";
import type {
  Cursor,
  CursorStore,
  IncomingMessage,
  IncomingRow,
  MailboxSession,
  WatcherState,
} from "../../src/watcher/watcher.js";

describe("refusedByServer", () => {
  it.each([
    ["a refused sign-in", { authenticationFailed: true }, true],
    ["a response code", { serverResponseCode: "LIMIT" }, true],
    ["a tagged no", { responseStatus: "NO" }, true],
    ["a server that says goodbye", { responseStatus: "BYE" }, true],
    ["a dropped connection", { code: "ECONNRESET" }, false],
    ["an empty code", { serverResponseCode: "", authenticationFailed: false }, false],
    ["a code that is not text", { serverResponseCode: 1 }, false],
  ])("%s", (_name, fields, expected) => {
    expect(refusedByServer(Object.assign(new Error("x"), fields))).toBe(expected);
  });

  it("takes anything", () => {
    for (const odd of [null, undefined, "NO", 1]) expect(refusedByServer(odd)).toBe(false);
  });

  it("is told with the backoff it caused", async () => {
    const seen: [WatcherState, boolean | undefined][] = [];
    const errors = [
      Object.assign(new Error("Command failed"), { serverResponseCode: "LIMIT" }),
      Object.assign(new Error("read ECONNRESET"), { code: "ECONNRESET" }),
    ];
    vi.useFakeTimers();
    const watcher = new AccountWatcher({
      accountId: "a",
      connect: () => Promise.reject(errors.shift() ?? new Error("x")),
      cursors: { get: () => undefined, set: () => undefined },
      onMessage: () => undefined,
      onState: (_id, state, _detail, refused) => seen.push([state, refused]),
      random: () => 0,
    });
    watcher.start();
    await vi.advanceTimersByTimeAsync(600);
    await watcher.stop();
    vi.useRealTimers();
    expect(seen.filter((s) => s[0] === "backoff")).toEqual([
      ["backoff", true],
      ["backoff", false],
    ]);
  });
});

const msg = (uid: number, from = "a@example.com"): IncomingMessage => ({
  uid,
  from,
  subject: `m${String(uid)}`,
  spamScore: null,
  deliveredAt: null,
});

class FakeSession implements MailboxSession {
  uidValidity = "1";
  uidNext: number;
  closed = false;
  fetches = 0;
  gate: Promise<void> | null = null;
  private existsListener: (() => void) | null = null;
  private closeListener: ((cause: Error | null) => void) | null = null;

  constructor(public messages: IncomingRow[]) {
    this.uidNext = Math.max(0, ...messages.map((m) => m.uid)) + 1;
  }

  /** IMAP `n:*` returns the last message even when n is past it; the fake does the same. */
  async fetchSince(uid: number): Promise<IncomingRow[]> {
    this.fetches += 1;
    if (this.gate !== null) await this.gate;
    const found = this.messages.filter((m) => m.uid > uid);
    const last = this.messages[this.messages.length - 1];
    return found.length === 0 && last !== undefined ? [last] : found;
  }
  onExists(listener: () => void): void {
    this.existsListener = listener;
  }
  onClose(listener: (cause: Error | null) => void): void {
    this.closeListener = listener;
  }
  close(): Promise<void> {
    this.closed = true;
    return Promise.resolve();
  }

  deliver(...more: IncomingRow[]): void {
    // `uidNext` stays: a real session holds the value it read at open.
    this.messages.push(...more);
    this.existsListener?.();
  }
  drop(cause: Error | null = null): void {
    this.closeListener?.(cause);
  }
}

class MemoryCursors implements CursorStore {
  readonly map = new Map<string, Cursor>();
  get(accountId: string): Cursor | undefined {
    return this.map.get(accountId);
  }
  set(accountId: string, cursor: Cursor): void {
    this.map.set(accountId, cursor);
  }
}

const BACKOFF = { baseMs: 1_000, maxMs: 8_000, stableMs: 30_000 };

function setup(sessions: readonly (FakeSession | (() => Promise<FakeSession>))[]) {
  const queue = [...sessions];
  const cursors = new MemoryCursors();
  const seen: IncomingMessage[] = [];
  const states: WatcherState[] = [];
  const overflow: number[] = [];
  const unreadable: number[] = [];
  const noSender: number[] = [];
  let connects = 0;
  const watcher = new AccountWatcher({
    accountId: "acc",
    connect: async () => {
      connects += 1;
      const next = queue.shift();
      if (next === undefined) throw new Error("no more sessions");
      return typeof next === "function" ? next() : next;
    },
    cursors,
    onMessage: (_id, m) => seen.push(m),
    onOverflow: (_id, n) => overflow.push(n),
    onUnreadable: (_id, n) => unreadable.push(n),
    onUnreadableSender: (_id, m) => noSender.push(m.uid),
    onState: (_id, s) => states.push(s),
    backoff: BACKOFF,
    random: () => 1,
  });
  return {
    watcher,
    cursors,
    seen,
    states,
    overflow,
    unreadable,
    noSender,
    connects: () => connects,
  };
}

const flush = () => vi.advanceTimersByTimeAsync(0);

beforeEach(() => {
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
});

describe("sanitizeSubject and a very long subject", () => {
  it("keeps every character it can hold, past the scan limit too", () => {
    expect(sanitizeSubject("a".repeat(SUBJECT_SCAN_MAX * 2))).toBe("a".repeat(SUBJECT_MAX));
  });

  it("looks at a bounded part only, and keeps what a person reads", () => {
    const start = `Invoice ${"x".repeat(50)}`;
    expect(sanitizeSubject(start + " ".repeat(SUBJECT_SCAN_MAX) + "hidden")).toBe(start);
  });
});

const lost = (uid: number): IncomingRow => ({ uid, from: null, subject: "s" });

describe("AccountWatcher and a sender it cannot match", () => {
  it("tells it once, and never again at a reconnect", async () => {
    const first = new FakeSession([msg(1)]);
    const second = new FakeSession([msg(1), lost(2)]);
    const { watcher, seen, noSender, cursors } = setup([first, second]);
    watcher.start();
    await flush();
    first.deliver(lost(2));
    await flush();
    expect(noSender).toEqual([2]);
    expect(cursors.get("acc")?.lastUid).toBe(2);
    first.drop();
    await vi.advanceTimersByTimeAsync(BACKOFF.baseMs);
    expect(watcher.current).toBe("watching");
    expect(noSender).toEqual([2]);
    expect(seen).toEqual([]);
    await watcher.stop();
  });

  it("keeps the order and shares the toast limit with readable mail", async () => {
    const session = new FakeSession([msg(1)]);
    const { watcher, seen, noSender, overflow, cursors } = setup([session]);
    watcher.start();
    await flush();
    session.deliver(msg(2), lost(3), msg(4), lost(5), lost(6), msg(7), lost(8));
    await flush();
    // DEFAULT_MAX_PER_DRAIN = 5: the older two are counted, not shown.
    expect(overflow).toEqual([2]);
    expect(seen.map((m) => m.uid)).toEqual([4, 7]);
    expect(noSender).toEqual([5, 6, 8]);
    expect(cursors.get("acc")?.lastUid).toBe(8);
    await watcher.stop();
  });
});

describe("AccountWatcher.nudge", () => {
  it("tries at once instead of waiting out the delay, and keeps the failure count", async () => {
    const refused = () => Promise.reject(new Error("getaddrinfo ENOTFOUND mail.example.net"));
    const { watcher, connects } = setup([refused, refused, refused, refused]);
    watcher.start();
    await flush();
    await vi.advanceTimersByTimeAsync(1_000);
    await vi.advanceTimersByTimeAsync(2_000);
    expect(connects()).toBe(3);
    expect(watcher.nudge()).toBe(true);
    await flush();
    expect(connects()).toBe(4);
    // Fourth failure: 8 s, not back to 1 s, and the old timer is gone.
    await vi.advanceTimersByTimeAsync(7_999);
    expect(connects()).toBe(4);
    await vi.advanceTimersByTimeAsync(1);
    expect(connects()).toBe(5);
    await watcher.stop();
  });

  it("does nothing unless the watcher waits for a retry", async () => {
    const { watcher, connects } = setup([
      new FakeSession([msg(1)]),
      () => Promise.reject(new FatalWatchError("authentication failed")),
    ]);
    expect(watcher.nudge()).toBe(false);
    watcher.start();
    expect(watcher.nudge()).toBe(false);
    await flush();
    expect(watcher.nudge()).toBe(false);
    await watcher.stop();
    expect(watcher.nudge()).toBe(false);
    watcher.start();
    await flush();
    expect(watcher.current).toBe("halted");
    expect(watcher.nudge()).toBe(false);
    expect(connects()).toBe(2);
  });
});

describe("AccountWatcher and a mail too large to read", () => {
  it("steps past it after one reconnect and tells the person, instead of looping for good", async () => {
    const first = new FakeSession([msg(1)]);
    const second = new FakeSession([msg(1), msg(2), msg(3)]);
    const third = new FakeSession([msg(1), msg(2), msg(3)]);
    const { watcher, seen, cursors, unreadable, connects } = setup([first, second, third]);
    watcher.start();
    await flush();
    first.drop(new UnreadableMailError("a mail is too large to read"));
    await vi.advanceTimersByTimeAsync(BACKOFF.baseMs);
    expect(connects()).toBe(2);
    expect(watcher.current).toBe("watching");
    expect(cursors.get("acc")?.lastUid).toBe(3);
    expect(unreadable).toEqual([2]);
    expect(seen).toEqual([]);
    expect(second.fetches).toBe(0);
    second.deliver(msg(4));
    await flush();
    expect(seen.map((m) => m.uid)).toEqual([4]);
    await watcher.stop();
  });

  it("does not ask for the newest mail at every connect: that one may be the mail it cannot read", async () => {
    const first = new FakeSession([msg(1)]);
    const second = new FakeSession([msg(1), msg(2)]);
    const third = new FakeSession([msg(1), msg(2)]);
    const { watcher, connects } = setup([first, second, third]);
    watcher.start();
    await flush();
    first.drop(new UnreadableMailError("a mail is too large to read"));
    await vi.advanceTimersByTimeAsync(BACKOFF.baseMs);
    second.drop(new Error("network blip"));
    await vi.advanceTimersByTimeAsync(BACKOFF.baseMs * 2);
    expect(connects()).toBe(3);
    expect(third.fetches).toBe(0);
    expect(watcher.current).toBe("watching");
    third.deliver(msg(3));
    await flush();
    expect(third.fetches).toBe(1);
    await watcher.stop();
  });

  it("announces the next mail on the connection that stepped past one", async () => {
    const first = new FakeSession([msg(1)]);
    const second = new FakeSession([msg(1), msg(2)]);
    const { watcher, seen } = setup([first, second]);
    watcher.start();
    await flush();
    first.drop(new UnreadableMailError("a mail is too large to read"));
    await vi.advanceTimersByTimeAsync(BACKOFF.baseMs);
    second.deliver(msg(3));
    await flush();
    expect(seen.map((m) => m.uid)).toEqual([3]);
    await watcher.stop();
  });

  it("announces the first mail after the very first connect", async () => {
    const session = new FakeSession([msg(1)]);
    const { watcher, seen } = setup([session]);
    watcher.start();
    await flush();
    session.deliver(msg(2));
    await flush();
    expect(seen.map((m) => m.uid)).toEqual([2]);
    await watcher.stop();
  });

  it("announces the first mail after a mailbox was renumbered", async () => {
    const session = new FakeSession([msg(1)]);
    const { watcher, seen, cursors } = setup([session]);
    cursors.set("acc", { uidValidity: "0", lastUid: 900 });
    watcher.start();
    await flush();
    session.deliver(msg(2));
    await flush();
    expect(seen.map((m) => m.uid)).toEqual([2]);
    await watcher.stop();
  });

  it("forgets a pending skip when the watcher is started again", async () => {
    const first = new FakeSession([msg(1)]);
    const second = new FakeSession([msg(1), msg(2)]);
    const { watcher, unreadable, seen } = setup([first, second]);
    watcher.start();
    await flush();
    first.drop(new UnreadableMailError("a mail is too large to read"));
    await watcher.stop();
    watcher.start();
    await flush();
    expect(unreadable).toEqual([]);
    expect(seen.map((m) => m.uid)).toEqual([2]);
    await watcher.stop();
  });

  it("moves nothing and says nothing when no mail lies past the cursor", async () => {
    const first = new FakeSession([msg(1)]);
    const second = new FakeSession([msg(1)]);
    const { watcher, unreadable } = setup([first, second]);
    watcher.start();
    await flush();
    first.drop(new UnreadableMailError("a mail is too large to read"));
    await vi.advanceTimersByTimeAsync(BACKOFF.baseMs);
    expect(watcher.current).toBe("watching");
    expect(unreadable).toEqual([]);
    await watcher.stop();
  });

  it("keeps the backoff for an ordinary failure: the mail is not skipped", async () => {
    const first = new FakeSession([msg(1)]);
    const second = new FakeSession([msg(1), msg(2)]);
    const { watcher, seen, unreadable } = setup([first, second]);
    watcher.start();
    await flush();
    first.drop(new Error("connection reset"));
    await vi.advanceTimersByTimeAsync(BACKOFF.baseMs);
    expect(seen.map((m) => m.uid)).toEqual([2]);
    expect(unreadable).toEqual([]);
    await watcher.stop();
  });
});

describe("AccountWatcher announcing", () => {
  it("does not announce mail that was already there, then announces new mail once", async () => {
    const session = new FakeSession([msg(1), msg(2)]);
    const { watcher, seen, cursors } = setup([session]);
    watcher.start();
    await flush();
    expect(watcher.current).toBe("watching");
    expect(seen).toEqual([]);
    expect(cursors.get("acc")).toEqual({ uidValidity: "1", lastUid: 2 });

    session.deliver(msg(3, "spam@bad.example"));
    await flush();
    expect(seen.map((m) => m.uid)).toEqual([3]);
    expect(cursors.get("acc")?.lastUid).toBe(3);
    await watcher.stop();
  });

  it("does not re-announce the last message when nothing is new (n:* quirk)", async () => {
    const session = new FakeSession([msg(1), msg(2)]);
    const { watcher, seen } = setup([session]);
    watcher.start();
    await flush();
    session.deliver(); // exists fired with no new message; the fake returns uid 2 again
    await flush();
    expect(seen).toEqual([]);
    await watcher.stop();
  });

  it("re-baselines instead of announcing when uidValidity changed", async () => {
    const session = new FakeSession([msg(1), msg(2), msg(3)]);
    session.uidValidity = "9";
    const { watcher, seen, cursors } = setup([session]);
    cursors.set("acc", { uidValidity: "1", lastUid: 1 });
    watcher.start();
    await flush();
    expect(seen).toEqual([]);
    expect(cursors.get("acc")).toEqual({ uidValidity: "9", lastUid: 3 });
    await watcher.stop();
  });

  it("announces only the newest few of a burst and reports the rest", async () => {
    const session = new FakeSession([msg(1)]);
    const { watcher, seen, overflow, cursors } = setup([session]);
    watcher.start();
    await flush();
    session.deliver(...[2, 3, 4, 5, 6, 7, 8, 9].map((u) => msg(u)));
    await flush();
    expect(seen.map((m) => m.uid)).toEqual([5, 6, 7, 8, 9]);
    expect(overflow).toEqual([3]);
    expect(cursors.get("acc")?.lastUid).toBe(9);
    await watcher.stop();
  });

  it("writes the cursor once per drain, not once per message", async () => {
    const session = new FakeSession([msg(1)]);
    const { watcher, cursors } = setup([session]);
    watcher.start();
    await flush();
    const writes = vi.spyOn(cursors, "set");
    session.deliver(...[2, 3, 4, 5, 6, 7, 8, 9].map((u) => msg(u)));
    await flush();
    expect(writes).toHaveBeenCalledTimes(1);
    expect(writes).toHaveBeenCalledWith("acc", { uidValidity: "1", lastUid: 9 });
    await watcher.stop();
  });

  it("keeps the cursor moving when the consumer throws", async () => {
    const session = new FakeSession([msg(1)]);
    const cursors = new MemoryCursors();
    const watcher = new AccountWatcher({
      accountId: "acc",
      connect: () => Promise.resolve(session),
      cursors,
      onMessage: () => {
        throw new Error("consumer bug");
      },
      backoff: BACKOFF,
    });
    watcher.start();
    await flush();
    session.deliver(msg(2));
    await flush();
    expect(cursors.get("acc")?.lastUid).toBe(2);
    expect(watcher.current).toBe("watching");
    await watcher.stop();
  });

  it("coalesces an exists that arrives while a fetch is running into one more round", async () => {
    const session = new FakeSession([msg(1)]);
    const { watcher, seen } = setup([session]);
    watcher.start();
    await flush();

    let release!: () => void;
    session.gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    session.deliver(msg(2));
    await flush();
    session.deliver(msg(3)); // second event while the first fetch is still blocked
    await flush();
    session.gate = null;
    release();
    await flush();
    expect(seen.map((m) => m.uid)).toEqual([2, 3]);
    await watcher.stop();
  });
});

describe("AccountWatcher reconnecting", () => {
  it("backs off with doubling delays up to the cap and resets after a stable connection", async () => {
    const dead = () => Promise.reject(new Error("refused"));
    const good = new FakeSession([msg(1)]);
    const { watcher, connects, states } = setup([
      dead,
      dead,
      dead,
      dead,
      dead,
      () => Promise.resolve(good),
    ]);
    watcher.start();
    await flush();
    expect(connects()).toBe(1);

    await vi.advanceTimersByTimeAsync(999);
    expect(connects()).toBe(1);
    await vi.advanceTimersByTimeAsync(1); // 1 s
    expect(connects()).toBe(2);
    await vi.advanceTimersByTimeAsync(2_000);
    expect(connects()).toBe(3);
    await vi.advanceTimersByTimeAsync(4_000);
    expect(connects()).toBe(4);
    await vi.advanceTimersByTimeAsync(8_000); // capped at maxMs
    expect(connects()).toBe(5);
    await vi.advanceTimersByTimeAsync(8_000);
    expect(connects()).toBe(6);
    expect(watcher.current).toBe("watching");

    // Stays up past stableMs, then drops: the delay starts again from the base.
    await vi.advanceTimersByTimeAsync(BACKOFF.stableMs);
    good.drop(new Error("reset by peer"));
    await flush();
    expect(watcher.current).toBe("backoff");
    expect(states.at(-1)).toBe("backoff");
    await vi.advanceTimersByTimeAsync(1_000);
    expect(connects()).toBe(7);
    await watcher.stop();
  });

  it("keeps growing the delay when connections die right after opening", async () => {
    const first = new FakeSession([msg(1)]);
    const second = new FakeSession([msg(1)]);
    const { watcher, connects } = setup([first, second, new FakeSession([msg(1)])]);
    watcher.start();
    await flush();
    first.drop();
    await vi.advanceTimersByTimeAsync(1_000);
    expect(connects()).toBe(2);
    second.drop(); // died before stableMs: next wait is 2 s, not 1 s
    await vi.advanceTimersByTimeAsync(1_999);
    expect(connects()).toBe(2);
    await vi.advanceTimersByTimeAsync(1);
    expect(connects()).toBe(3);
    await watcher.stop();
  });

  it("closes the dead session it replaces", async () => {
    const first = new FakeSession([msg(1)]);
    const { watcher } = setup([first, new FakeSession([msg(1)])]);
    watcher.start();
    await flush();
    first.drop();
    await flush();
    expect(first.closed).toBe(true);
    await watcher.stop();
  });

  it("halts on a fatal error and does not retry until told to", async () => {
    const good = new FakeSession([msg(1)]);
    const { watcher, connects, states } = setup([
      () => Promise.reject(new FatalWatchError("authentication failed")),
      good,
    ]);
    watcher.start();
    await flush();
    expect(watcher.current).toBe("halted");
    await vi.advanceTimersByTimeAsync(3_600_000);
    expect(connects()).toBe(1);

    // A system resume does not retry a wrong password (a lockout risk): only the person's own start does.
    watcher.reconnectNow();
    await flush();
    expect(connects()).toBe(1);
    expect(watcher.current).toBe("halted");

    watcher.start(); // user fixed the password
    await flush();
    expect(connects()).toBe(2);
    expect(watcher.current).toBe("watching");
    expect(states).toContain("halted");
    await watcher.stop();
  });

  it("a pause keeps a halt: resume() sends no refused password, only start() does", async () => {
    const good = new FakeSession([msg(1)]);
    const { watcher, connects } = setup([
      () => Promise.reject(new FatalWatchError("authentication failed")),
      good,
    ]);
    watcher.start();
    await flush();

    await watcher.stop();
    expect(watcher.current).toBe("halted");
    watcher.resume();
    await flush();
    expect(connects()).toBe(1);
    expect(watcher.current).toBe("halted");

    watcher.start();
    await flush();
    expect(connects()).toBe(2);
    await watcher.stop();
    expect(watcher.current).toBe("stopped");
  });

  it("resume() picks up a paused watcher", async () => {
    const { watcher, connects } = setup([new FakeSession([msg(1)]), new FakeSession([msg(1)])]);
    watcher.start();
    await flush();
    await watcher.stop();
    watcher.resume();
    await flush();
    expect(connects()).toBe(2);
    expect(watcher.current).toBe("watching");
    await watcher.stop();
  });

  it("reconnectNow replaces a live connection immediately (system resume)", async () => {
    const first = new FakeSession([msg(1)]);
    const second = new FakeSession([msg(1)]);
    const { watcher, connects } = setup([first, second]);
    watcher.start();
    await flush();
    watcher.reconnectNow();
    await flush();
    expect(first.closed).toBe(true);
    expect(connects()).toBe(2);
    first.drop(); // late close from the replaced socket must not tear down the new one
    await flush();
    expect(watcher.current).toBe("watching");
    await watcher.stop();
  });
});

describe("AccountWatcher stopping", () => {
  it("closes the session, ignores later events and cancels a pending retry", async () => {
    const session = new FakeSession([msg(1)]);
    const { watcher, seen, connects } = setup([session]);
    watcher.start();
    await flush();
    await watcher.stop();
    expect(session.closed).toBe(true);
    expect(watcher.current).toBe("stopped");
    session.deliver(msg(2));
    await flush();
    expect(seen).toEqual([]);
    expect(connects()).toBe(1);
  });

  it("closes a connection that finished opening after stop()", async () => {
    let release!: (s: FakeSession) => void;
    const late = new FakeSession([msg(1)]);
    const { watcher } = setup([
      () =>
        new Promise<FakeSession>((resolve) => {
          release = resolve;
        }),
    ]);
    watcher.start();
    await flush();
    await watcher.stop();
    release(late);
    await flush();
    expect(late.closed).toBe(true);
    expect(watcher.current).toBe("stopped");
  });

  it("does not retry after stop() during backoff", async () => {
    const { watcher, connects } = setup([() => Promise.reject(new Error("refused"))]);
    watcher.start();
    await flush();
    expect(watcher.current).toBe("backoff");
    await watcher.stop();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(connects()).toBe(1);
  });
});

describe("header sanitising", () => {
  it("removes control and bidi characters and collapses whitespace", () => {
    expect(sanitizeSubject("Hi\u0000 \u202Ethere\u202C\n\tfriend")).toBe("Hi there friend");
  });

  it("caps the subject length", () => {
    expect(sanitizeSubject("x".repeat(5_000))).toHaveLength(SUBJECT_MAX);
  });

  it("returns the validated lowercase address, never a display name", () => {
    expect(toIncoming(7, "Bad.Guy@Example.COM", "hello")).toEqual({
      uid: 7,
      from: "bad.guy@example.com",
      subject: "hello",
      spamScore: null,
      deliveredAt: null,
    });
  });

  it.each([
    ["X-Spam-Score: 1.6 (+)\r\n", 1.6],
    ["x-spam-score: -2.35\r\n", -2.35],
    ["X-Spam-Score:\t0\r\n", 0],
    ["X-Spam-Status: No\r\nX-Spam-Score: 7.1 (+++++)\r\n", 7.1],
  ])("reads the score from %j", (header, expected) => {
    expect(parseSpamScore(Buffer.from(header))).toBe(expected);
  });

  it.each([
    ["no header at all", ""],
    ["a word instead of a number", "X-Spam-Score: high\r\n"],
    ["an exponent", "X-Spam-Score: 1e9\r\n"],
    ["too many digits", "X-Spam-Score: 99999\r\n"],
    ["a score past the upper bound", `X-Spam-Score: ${String(SPAM_SCORE.max + 1)}\r\n`],
    ["a score under the lower bound", `X-Spam-Score: ${String(SPAM_SCORE.min - 1)}\r\n`],
    ["the header name inside another header", "X-Foo: x-spam-score: 3\r\n"],
    ["trailing junk glued to the number", "X-Spam-Score: 1.6.7\r\n"],
    [
      "two score lines (a sender can forge the first one)",
      "X-Spam-Score: -9.9\r\nX-Spam-Score: 14.2 (+++)\r\n",
    ],
  ])("gives no score for %s", (_name, header) => {
    expect(parseSpamScore(Buffer.from(header))).toBeNull();
  });

  it("gives no score when a padded forged line could have pushed the server's out of the window", () => {
    const forged = `X-Spam-Score: -9.9${" ".repeat(SPAM_HEADER_MAX_BYTES)}\r\nX-Spam-Score: 14.2\r\n`;
    expect(parseSpamScore(Buffer.from(forged))).toBeNull();
  });

  it.each(["7.20 / 15", "+7.2", "12.345", "spam"])(
    "counts a line it cannot read, so a forged line beside the server's %s gives no score",
    (server) => {
      const headers = `X-Spam-Score: -5\r\nX-Spam-Score: ${server}\r\n`;
      expect(parseSpamScore(Buffer.from(headers))).toBeNull();
    },
  );

  it("gives no score when the header is missing or past the parsed bytes", () => {
    expect(parseSpamScore(undefined)).toBeNull();
    const padded = Buffer.from(`${"X-Pad: x\r\n".repeat(60)}X-Spam-Score: 3\r\n`);
    expect(parseSpamScore(padded)).toBeNull();
  });

  it("carries the server's spam score from the fetched header", () => {
    const header = Buffer.from("X-Spam-Score: 1.6 (+)\r\n\r\n");
    expect(toIncoming(7, "a@example.com", "s", header)).toMatchObject({ spamScore: 1.6 });
  });

  it.each([
    undefined,
    "",
    "not an address",
    '"quoted local"@example.com',
    "MISSING_MAILBOX@MISSING_DOMAIN",
    "g@SYNTAX_ERROR",
  ])("keeps a message whose sender cannot be matched exactly, with no sender: %s", (from) => {
    expect(toIncoming(1, from, "x\u202ey")).toEqual({ uid: 1, from: null, subject: "x y" });
  });

  it.each([
    [new Date("2026-01-05T10:00:00Z"), Date.UTC(2026, 0, 5, 10)],
    [new Date(DELIVERED_AT.min), DELIVERED_AT.min],
    [new Date(DELIVERED_AT.min - 1), null],
    [new Date(DELIVERED_AT.max + 1), null],
    [new Date(Number.NaN), null],
    ["05-Jan-2026 10:00:00 +0000", null],
    [undefined, null],
  ])("reads the delivery time %s", (raw, expected) => {
    expect(parseDeliveredAt(raw)).toBe(expected);
    expect(toIncoming(1, "a@example.com", "", undefined, raw)).toMatchObject({
      deliveredAt: expected,
    });
  });
});
