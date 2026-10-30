import { describe, expect, it, vi } from "vitest";
import { AccountWatcher, FETCH_LIMIT, UnreadableMailError } from "../../src/watcher/watcher.js";
import type {
  Cursor,
  IncomingMessage,
  MailboxSession,
  WatcherOptions,
} from "../../src/watcher/watcher.js";

const msg = (uid: number): IncomingMessage => ({
  uid,
  from: "a@example.com",
  subject: "s",
  spamScore: null,
});

function session(messages: IncomingMessage[], uidNext: number): MailboxSession {
  return {
    uidValidity: "1",
    uidNext,
    fetchSince: (uid) => Promise.resolve(messages.filter((m) => m.uid > uid)),
    onExists: () => undefined,
    onClose: () => undefined,
    close: () => Promise.resolve(),
  };
}

function watcher(
  connect: () => Promise<MailboxSession>,
  cursor: Cursor,
  over: Partial<WatcherOptions> = {},
) {
  const cursors = new Map([["a", cursor]]);
  const announced: number[] = [];
  const instance = new AccountWatcher({
    accountId: "a",
    connect,
    cursors: {
      get: (id) => cursors.get(id),
      set: (id, value) => cursors.set(id, value),
    },
    onMessage: (_, message) => announced.push(message.uid),
    backoff: { baseMs: 100_000, maxMs: 100_000, stableMs: 100_000 },
    random: () => 0,
    ...over,
  });
  return { instance, cursors, announced };
}

const settled = async (instance: AccountWatcher) => {
  await vi.waitFor(() => {
    expect(["watching", "backoff"]).toContain(instance.current);
  });
};

describe("screen", () => {
  it("sees every new mail, past the announcement cap, and only the rest is announced", async () => {
    const mail = Array.from({ length: 8 }, (_, i) => msg(i + 2));
    const seen: number[] = [];
    const { instance, announced, cursors } = watcher(
      () => Promise.resolve(session(mail, 10)),
      { uidValidity: "1", lastUid: 1 },
      {
        screen: (fresh) => {
          seen.push(...fresh.map((m) => m.uid));
          return Promise.resolve(fresh.filter((m) => m.uid % 2 === 0));
        },
        maxPerDrain: 3,
      },
    );
    instance.start();
    await settled(instance);
    expect(seen).toEqual([2, 3, 4, 5, 6, 7, 8, 9]);
    expect(announced).toEqual([4, 6, 8]);
    expect(cursors.get("a")?.lastUid).toBe(9);
    await instance.stop();
  });

  it("moves the cursor past a batch it took entirely", async () => {
    const { instance, announced, cursors } = watcher(
      () => Promise.resolve(session([msg(2)], 3)),
      { uidValidity: "1", lastUid: 1 },
      { screen: () => Promise.resolve([]) },
    );
    instance.start();
    await settled(instance);
    expect(announced).toEqual([]);
    expect(cursors.get("a")?.lastUid).toBe(2);
    await instance.stop();
  });

  it("keeps the cursor when screening failed, so the batch is seen again", async () => {
    const { instance, announced, cursors } = watcher(
      () => Promise.resolve(session([msg(2)], 3)),
      { uidValidity: "1", lastUid: 1 },
      { screen: () => Promise.reject(new Error("connection lost")) },
    );
    instance.start();
    await settled(instance);
    expect(instance.current).toBe("backoff");
    expect(announced).toEqual([]);
    expect(cursors.get("a")?.lastUid).toBe(1);
    await instance.stop();
  });

  it("drops the batch when the watcher stopped while it was being screened", async () => {
    let release: (left: readonly IncomingMessage[]) => void = () => undefined;
    let screening = false;
    const { instance, announced, cursors } = watcher(
      () => Promise.resolve(session([msg(2)], 3)),
      { uidValidity: "1", lastUid: 1 },
      {
        screen: () =>
          new Promise((resolve) => {
            screening = true;
            release = resolve;
          }),
      },
    );
    instance.start();
    await vi.waitFor(() => {
      expect(screening).toBe(true);
    });
    await instance.stop();
    release([msg(2)]);
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(announced).toEqual([]);
    expect(cursors.get("a")?.lastUid).toBe(1);
  });
});

describe("onGap", () => {
  it("fires at opening when more came in than one fetch takes", async () => {
    const onGap = vi.fn();
    const top = FETCH_LIMIT + 5;
    const { instance } = watcher(
      () => Promise.resolve(session([msg(top)], top + 1)),
      { uidValidity: "1", lastUid: 2 },
      { onGap },
    );
    instance.start();
    await settled(instance);
    expect(onGap).toHaveBeenCalledTimes(1);
    await instance.stop();
  });

  it("fires for a burst past the limit on a live session", async () => {
    const onGap = vi.fn();
    const burst = Array.from({ length: FETCH_LIMIT }, (_, i) => msg(i + 2));
    const { instance } = watcher(
      () => Promise.resolve(session(burst, 3)),
      { uidValidity: "1", lastUid: 1 },
      { onGap },
    );
    instance.start();
    await settled(instance);
    expect(onGap).toHaveBeenCalledTimes(1);
    await instance.stop();
  });

  it("fires when the server renumbered the mailbox, not on a first run", async () => {
    const onGap = vi.fn();
    const renumbered = watcher(
      () => Promise.resolve(session([], 5)),
      { uidValidity: "0", lastUid: 3 },
      { onGap },
    );
    renumbered.instance.start();
    await settled(renumbered.instance);
    expect(onGap).toHaveBeenCalledTimes(1);
    await renumbered.instance.stop();

    onGap.mockClear();
    const first = watcher(
      () => Promise.resolve(session([], 5)),
      { uidValidity: "1", lastUid: 3 },
      { onGap },
    );
    first.cursors.clear();
    first.instance.start();
    await settled(first.instance);
    expect(onGap).not.toHaveBeenCalled();
    await first.instance.stop();
  });

  it("stays quiet for a gap one fetch covers", async () => {
    const onGap = vi.fn();
    const { instance } = watcher(
      () => Promise.resolve(session([msg(FETCH_LIMIT + 1)], FETCH_LIMIT + 2)),
      { uidValidity: "1", lastUid: 1 },
      { onGap },
    );
    instance.start();
    await settled(instance);
    expect(onGap).not.toHaveBeenCalled();
    await instance.stop();
  });

  it("fires when an unreadable mail made the watcher step over new mail", async () => {
    const onGap = vi.fn();
    let opens = 0;
    const connect = (): Promise<MailboxSession> => {
      opens += 1;
      const base = session([msg(2)], 3);
      if (opens > 1) return Promise.resolve(base);
      return Promise.resolve({
        ...base,
        fetchSince: () => Promise.reject(new UnreadableMailError("a mail is too large to read")),
      });
    };
    const { instance, cursors } = watcher(
      connect,
      { uidValidity: "1", lastUid: 1 },
      { onGap, backoff: { baseMs: 1, maxMs: 1, stableMs: 100_000 } },
    );
    instance.start();
    await vi.waitFor(() => {
      expect(onGap).toHaveBeenCalledTimes(1);
    });
    expect(cursors.get("a")?.lastUid).toBe(2);
    await instance.stop();
  });
});
