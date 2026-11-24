import { describe, expect, it } from "vitest";
import {
  AccountWatcher,
  RECENT_TOO_LARGE_MAILS,
  RECENT_TOO_LARGE_MS,
  RecentTooLargeError,
} from "../../src/watcher/watcher.js";
import type { MailboxSession, RecentRow } from "../../src/watcher/watcher.js";

const row = (uid: number): RecentRow => ({
  uid,
  from: "a@example.com",
  subject: `m${String(uid)}`,
  deliveredAt: null,
});

function session(recent?: MailboxSession["recent"]): MailboxSession & { asked: number[] } {
  const asked: number[] = [];
  return {
    asked,
    uidValidity: "1",
    uidNext: 1,
    fetchSince: () => Promise.resolve([]),
    ...(recent === undefined
      ? {}
      : {
          recent: (count: number) => {
            asked.push(count);
            return recent(count);
          },
        }),
    onExists: () => undefined,
    onClose: () => undefined,
    close: () => Promise.resolve(),
  };
}

function watcherOn(open: MailboxSession | Promise<MailboxSession>): AccountWatcher {
  return new AccountWatcher({
    accountId: "a",
    connect: () => Promise.resolve(open),
    // A cursor at the mailbox's top: the first drain reads nothing.
    cursors: { get: () => ({ uidValidity: "1", lastUid: 0 }), set: () => undefined },
    onMessage: () => undefined,
  });
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

describe("AccountWatcher.recent", () => {
  it("reads on the open connection while watching", async () => {
    const open = session(() => Promise.resolve([row(9), row(8)]));
    const watcher = watcherOn(open);
    watcher.start();
    await settle();
    expect(watcher.current).toBe("watching");
    await expect(watcher.recent(10)).resolves.toEqual([row(9), row(8)]);
    expect(open.asked).toEqual([10]);
    await watcher.stop();
  });

  it("answers null and never connects when not watching", async () => {
    let connects = 0;
    const watcher = new AccountWatcher({
      accountId: "a",
      connect: () => {
        connects += 1;
        return Promise.resolve(session(() => Promise.resolve([])));
      },
      cursors: { get: () => undefined, set: () => undefined },
      onMessage: () => undefined,
    });
    await expect(watcher.recent(10)).resolves.toBeNull();
    expect(connects).toBe(0);
  });

  it("answers null on a session that cannot read recent mail", async () => {
    const watcher = watcherOn(session());
    watcher.start();
    await settle();
    await expect(watcher.recent(10)).resolves.toBeNull();
    await watcher.stop();
  });

  it("answers null once stopped", async () => {
    const open = session(() => Promise.resolve([row(1)]));
    const watcher = watcherOn(open);
    watcher.start();
    await settle();
    await watcher.stop();
    await expect(watcher.recent(10)).resolves.toBeNull();
    expect(open.asked).toEqual([]);
  });

  it("hands a failed read to the caller, and keeps watching", async () => {
    const watcher = watcherOn(session(() => Promise.reject(new Error("NO"))));
    watcher.start();
    await settle();
    await expect(watcher.recent(10)).rejects.toThrow("NO");
    expect(watcher.current).toBe("watching");
    await watcher.stop();
  });

  it("joins a read that is running: one FETCH queued on the connection, whoever asks", async () => {
    const gates: ((rows: RecentRow[]) => void)[] = [];
    const release = (rows: RecentRow[]): void => {
      gates.shift()?.(rows);
    };
    const open = session(
      () =>
        new Promise<RecentRow[]>((resolve) => {
          gates.push(resolve);
        }),
    );
    const watcher = watcherOn(open);
    watcher.start();
    await settle();
    const first = watcher.recent(10);
    const second = watcher.recent(10);
    release([row(1)]);
    await expect(first).resolves.toEqual([row(1)]);
    await expect(second).resolves.toEqual([row(1)]);
    expect(open.asked).toEqual([10]);
    // Once it ended, the next look asks again.
    const third = watcher.recent(10);
    release([row(2)]);
    await expect(third).resolves.toEqual([row(2)]);
    expect(open.asked).toEqual([10, 10]);
    await watcher.stop();
  });

  it("after a mail too large to list, asks again only once ten newer mails came or half an hour passed", async () => {
    const clock = { t: 0 };
    const cursor = { lastUid: 50 };
    let large = true;
    const open = session(() =>
      large ? Promise.reject(new RecentTooLargeError("too large")) : Promise.resolve([row(1)]),
    );
    const watcher = new AccountWatcher({
      accountId: "a",
      connect: () => Promise.resolve(open),
      cursors: { get: () => ({ uidValidity: "1", lastUid: cursor.lastUid }), set: () => undefined },
      onMessage: () => undefined,
      now: () => clock.t,
    });
    watcher.start();
    await settle();
    await expect(watcher.recent(10)).rejects.toBeInstanceOf(RecentTooLargeError);
    // Answered without a FETCH: each one would cost a reconnect.
    cursor.lastUid += RECENT_TOO_LARGE_MAILS - 1;
    clock.t += RECENT_TOO_LARGE_MS - 1;
    await expect(watcher.recent(10)).rejects.toBeInstanceOf(RecentTooLargeError);
    expect(open.asked).toHaveLength(1);
    cursor.lastUid += 1;
    large = false;
    await expect(watcher.recent(10)).resolves.toEqual([row(1)]);
    expect(open.asked).toHaveLength(2);
    // The time alone frees it too.
    large = true;
    await expect(watcher.recent(10)).rejects.toBeInstanceOf(RecentTooLargeError);
    clock.t += RECENT_TOO_LARGE_MS;
    large = false;
    await expect(watcher.recent(10)).resolves.toEqual([row(1)]);
    expect(open.asked).toHaveLength(4);
    await watcher.stop();
  });
});
