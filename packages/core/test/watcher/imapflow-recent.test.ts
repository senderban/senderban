import { beforeEach, describe, expect, it, vi } from "vitest";

interface Row {
  uid: number;
  envelope?: { from?: { address?: string }[]; subject?: string };
  internalDate?: Date | string;
}

const fake = vi.hoisted(() => {
  const state: {
    listeners: Map<string, (value?: unknown) => void>;
    exists: number;
    rows: Row[];
    fetchError: Error | null;
    ranges: string[];
    oldDuringFetch: number[];
    hooks: { reading: { old: number; oversized: boolean } } | null;
    closes: number;
    hold: Promise<void> | null;
    noMailbox: boolean;
  } = {
    listeners: new Map(),
    exists: 0,
    rows: [],
    fetchError: null,
    ranges: [],
    oldDuringFetch: [],
    hooks: null,
    closes: 0,
    hold: null,
    noMailbox: false,
  };
  return state;
});

vi.mock("imapflow", () => ({
  ImapFlow: class {
    usable = true;
    get mailbox(): { exists: number } | false {
      return fake.noMailbox ? false : { exists: fake.exists };
    }
    on(name: string, listener: (value?: unknown) => void): void {
      fake.listeners.set(name, listener);
    }
    connect(): Promise<void> {
      return Promise.resolve();
    }
    mailboxOpen(): Promise<{ uidNext: number; uidValidity: bigint }> {
      return Promise.resolve({ uidNext: 100, uidValidity: 1n });
    }
    fetch(range: string): AsyncIterable<Row> {
      fake.ranges.push(range);
      fake.oldDuringFetch.push(fake.hooks?.reading.old ?? -1);
      const rows = [...fake.rows];
      return {
        [Symbol.asyncIterator]: () => ({
          next: async () => {
            if (fake.hold !== null) await fake.hold;
            if (fake.fetchError !== null) throw fake.fetchError;
            const value = rows.shift();
            return Promise.resolve(
              value === undefined ? { done: true, value: undefined } : { done: false, value },
            );
          },
        }),
      };
    }
    close(): void {
      fake.closes += 1;
    }
  },
}));

const { imapflowConnector, RECENT_SCAN_FACTOR } =
  await import("../../src/watcher/imapflow-session.js");
const { RECENT_MAX, RecentTooLargeError } = await import("../../src/watcher/watcher.js");

const config = { host: "mail.example.test", port: 993, secure: true, user: "u", password: "p" };
const mail = (uid: number, address = "a@example.com"): Row => ({
  uid,
  envelope: { from: [{ address }], subject: `s${String(uid)}` },
  internalDate: new Date(Date.UTC(2026, 10, 23, 0, 0, uid)),
});

async function open() {
  const session = await imapflowConnector(config, (_client, hooks) => {
    fake.hooks = hooks;
  })();
  if (session.recent === undefined) throw new Error("no recent on an imapflow session");
  return { session, recent: session.recent.bind(session) };
}

beforeEach(() => {
  fake.listeners.clear();
  fake.exists = 0;
  fake.rows = [];
  fake.fetchError = null;
  fake.closes = 0;
  fake.hold = null;
  fake.noMailbox = false;
  fake.ranges = [];
  fake.oldDuringFetch = [];
  fake.hooks = null;
});

describe("imapflow session recent()", () => {
  it("asks for the newest positions, not UIDs, and hands them back newest first", async () => {
    fake.exists = 42;
    fake.rows = [mail(70), mail(75), mail(80)];
    const { recent } = await open();
    const rows = await recent(3);
    expect(fake.ranges).toEqual(["40:*"]);
    expect(rows.map((r) => r.uid)).toEqual([80, 75, 70]);
    expect(rows[0]).toEqual({
      uid: 80,
      from: "a@example.com",
      subject: "s80",
      deliveredAt: Date.UTC(2026, 10, 23, 0, 0, 80),
    });
  });

  it("starts at position 1 in a small mailbox, and asks nothing of an empty one", async () => {
    fake.exists = 2;
    fake.rows = [mail(1), mail(2)];
    const { recent } = await open();
    await recent(RECENT_MAX);
    expect(fake.ranges).toEqual(["1:*"]);
    fake.exists = 0;
    await expect(recent(RECENT_MAX)).resolves.toEqual([]);
    expect(fake.ranges).toHaveLength(1);
  });

  it("keeps a sender it cannot match, with nothing to click", async () => {
    fake.exists = 1;
    fake.rows = [{ uid: 5, envelope: { from: [{ address: "not an address" }], subject: "x" } }];
    const { recent } = await open();
    expect(await recent(1)).toEqual([{ uid: 5, from: null, subject: "x", deliveredAt: null }]);
  });

  it("keeps only the newest asked for, from a server that sends more", async () => {
    fake.exists = 3;
    fake.rows = Array.from({ length: 50 }, (_, i) => mail(i + 1));
    const { recent } = await open();
    const rows = await recent(3);
    expect(rows).toHaveLength(3);
    // Stopped after RECENT_SCAN_FACTOR rows per row asked for: 15 of 50.
    expect(rows.map((r) => r.uid)).toEqual([15, 14, 13]);
    expect(RECENT_SCAN_FACTOR).toBe(5);
  });

  it("refuses a count outside 1 to RECENT_MAX", async () => {
    fake.exists = 5;
    const { recent } = await open();
    for (const count of [0, RECENT_MAX + 1, 1.5]) {
      await expect(recent(count)).rejects.toThrow(RangeError);
    }
    expect(fake.ranges).toEqual([]);
  });

  it("marks the read as old mail, and ends the mark even when it fails", async () => {
    fake.exists = 1;
    fake.rows = [mail(1)];
    const { recent } = await open();
    await recent(1);
    expect(fake.oldDuringFetch).toEqual([1]);
    expect(fake.hooks?.reading.old).toBe(0);
    fake.fetchError = Object.assign(new Error("too large"), { code: "LineTooLarge" });
    await expect(recent(1)).rejects.toThrow();
    expect(fake.hooks?.reading.old).toBe(0);
  });

  it("does not answer an empty Inbox when no mailbox is open: the connection is closing", async () => {
    fake.exists = 1;
    fake.rows = [mail(1)];
    const { recent } = await open();
    fake.noMailbox = true;
    await expect(recent(1)).rejects.toThrow("not open");
    expect(fake.ranges).toEqual([]);
  });

  it("names a size limit hit by the read as a mail too large to list", async () => {
    fake.exists = 1;
    fake.rows = [mail(1)];
    const { recent } = await open();
    fake.fetchError = Object.assign(new Error("too large"), { code: "LiteralTooLarge" });
    await expect(recent(1)).rejects.toBeInstanceOf(RecentTooLargeError);
    // The stream may only see the close; the limit came as an event.
    fake.fetchError = new Error("Connection closed");
    if (fake.hooks !== null) fake.hooks.reading.oversized = true;
    await expect(recent(1)).rejects.toBeInstanceOf(RecentTooLargeError);
  });

  it("closes the connection when the caller gives up on the read, and not otherwise", async () => {
    fake.exists = 1;
    fake.rows = [mail(1)];
    const { recent } = await open();
    await recent(1, new AbortController().signal);
    expect(fake.closes).toBe(0);
    let release = (): void => undefined;
    fake.hold = new Promise((resolve) => {
      release = resolve;
    });
    const controller = new AbortController();
    const read = recent(1, controller.signal);
    controller.abort(new Error("deadline"));
    expect(fake.closes).toBe(1);
    fake.fetchError = new Error("Connection closed");
    release();
    await expect(read).rejects.toThrow("Connection closed");
    await expect(recent(1, controller.signal)).rejects.toThrow("deadline");
  });

  it("does not make the watcher step over new mail when the limit is hit by a recent read", async () => {
    fake.exists = 1;
    const { session, recent } = await open();
    const causes: unknown[] = [];
    session.onClose((cause) => {
      causes.push(cause);
    });
    fake.rows = [mail(1)];
    const read = recent(1);
    // The connection ends on the read, while it still runs.
    fake.listeners.get("error")?.(Object.assign(new Error("too large"), { code: "LineTooLarge" }));
    fake.listeners.get("close")?.();
    await read;
    expect(causes).toHaveLength(1);
    expect((causes[0] as Error).name).not.toBe("UnreadableMailError");
    expect(fake.hooks?.reading.oversized).toBe(true);
  });
});
