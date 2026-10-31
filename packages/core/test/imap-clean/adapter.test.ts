import { describe, expect, it, vi } from "vitest";
import { AdapterError, type OpaqueState } from "../../src/adapter.js";
import type { BlockAction, BlockEntry, Blocklist } from "../../src/blocklist.js";
import {
  ImapCleanAdapter,
  RETRO_ABORTS_MAX,
  RETRO_DAYS,
  RETRO_ENTRIES_PER_PLAN,
  RETRO_HOLD_MAX_MS,
  RETRO_HOLD_MS,
  RETRO_MAX_UIDS,
  RETRO_ROUND_MS,
  RETRO_BATCH,
  RETRO_SCAN_ABOVE,
  RETRO_WINDOW_UIDS,
  SWEEP_ALL_GAP_MS,
  initialCleanState,
} from "../../src/imap-clean/adapter.js";
import type { CleanEvent } from "../../src/imap-clean/adapter.js";
import { CLEAN_UIDS_PER_COMMAND, CleanLink } from "../../src/imap-clean/session.js";
import type { CleanFolders, CleanMailbox, CleanRow } from "../../src/imap-clean/session.js";
import { UnreadableMailError } from "../../src/watcher/watcher.js";
import type { IncomingMessage } from "../../src/watcher/watcher.js";

const entry = (
  n: number,
  value: string,
  match: BlockEntry["match"] = "exactAddress",
  action: BlockAction = "junk",
): BlockEntry => ({
  id: `0b5f5f58-8f2c-4b9e-9a45-${String(n).padStart(12, "0")}`,
  match,
  value,
  action,
  createdAt: "2026-10-31T00:00:00.000Z",
});

const incoming = (uid: number, from: string): IncomingMessage => ({
  uid,
  from,
  subject: "s",
  spamScore: null,
});

class FakeBox implements CleanMailbox {
  mail = new Map<number, string>();
  moves: { uids: number[]; folder: string }[] = [];
  created: string[] = [];
  searches: string[][] = [];
  probes: string[] = [];
  reads = 0;
  listed = 0;
  destroyed = false;
  movable = true;
  found: CleanFolders = { junk: "Junk", trash: "Deleted Messages" };
  top = 0;
  refuseMoves = false;
  refuseCreate = false;
  loseConnection = false;
  unreadable = false;
  /** Called on every search, so a test can move the clock. */
  onSearch: () => void = () => undefined;

  fill(rows: readonly (readonly [number, string])[]): this {
    for (const [uid, from] of rows) this.mail.set(uid, from);
    this.top = Math.max(0, ...this.mail.keys());
    return this;
  }
  canMove(): boolean {
    return this.movable;
  }
  topUid(): number {
    return this.top;
  }
  validity = "1";
  uidValidity(): string {
    return this.validity;
  }
  uidsSince(range: string): Promise<number[]> {
    this.probes.push(range);
    const [lo, hi] = range.split(":").map(Number) as [number, number];
    return Promise.resolve([...this.mail.keys()].filter((uid) => uid >= lo && uid <= hi));
  }
  searchFrom(_: string, needles: readonly string[]): Promise<number[]> {
    this.searches.push([...needles]);
    this.onSearch();
    if (this.loseConnection) return Promise.reject(new Error("connection lost"));
    return Promise.resolve(
      [...this.mail].filter(([, from]) => needles.some((n) => from.includes(n))).map(([u]) => u),
    );
  }
  readFrom(uids: readonly number[]): Promise<CleanRow[]> {
    this.reads += 1;
    if (this.unreadable) return Promise.reject(new UnreadableMailError("too large"));
    return Promise.resolve(uids.map((uid) => ({ uid, from: this.mail.get(uid) ?? "" })));
  }
  folders(): Promise<CleanFolders> {
    this.listed += 1;
    return Promise.resolve(this.found);
  }
  createFolder(path: string): Promise<void> {
    if (this.refuseCreate) return Promise.reject(new AdapterError("REJECTED", "refused"));
    this.created.push(path);
    return Promise.resolve();
  }
  move(uids: readonly number[], folder: string): Promise<void> {
    if (this.refuseMoves) return Promise.reject(new AdapterError("REJECTED", "refused"));
    if (this.loseConnection) return Promise.reject(new Error("connection lost"));
    this.moves.push({ uids: [...uids], folder });
    for (const uid of uids) this.mail.delete(uid);
    return Promise.resolve();
  }
  destroy(): void {
    this.destroyed = true;
  }
}

interface Rig {
  adapter: ImapCleanAdapter;
  link: CleanLink;
  events: CleanEvent[];
  clock: { now: number };
}

function rig(box: FakeBox | null, state: OpaqueState = initialCleanState()): Rig {
  const link = new CleanLink();
  if (box !== null) link.attach(box);
  const events: CleanEvent[] = [];
  const clock = { now: Date.parse("2026-10-31T00:00:00.000Z") };
  const adapter = new ImapCleanAdapter({
    accountId: "you@example.test",
    link,
    initialState: state,
    onClean: (event) => events.push(event),
    now: () => clock.now,
  });
  return { adapter, link, events, clock };
}

async function round(adapter: ImapCleanAdapter, list: Blocklist, state: OpaqueState) {
  return adapter.apply(await adapter.plan(list, state));
}

const dataOf = (state: OpaqueState) =>
  state.data as { applied: BlockEntry[]; retro: string[]; pass: unknown };

describe("ImapCleanAdapter capabilities", () => {
  it("never claims a block on the server", () => {
    const { adapter } = rig(new FakeBox());
    expect(adapter.capabilities()).toMatchObject({
      serverBlock: false,
      retroClean: true,
      watch: true,
    });
  });
});

describe("plan", () => {
  it("is empty when nothing changed, so no round runs", async () => {
    const { adapter } = rig(new FakeBox());
    expect((await adapter.plan([], initialCleanState())).changes).toEqual([]);
  });

  it("creates what is new and removes what left the list", async () => {
    const box = new FakeBox();
    const { adapter } = rig(box);
    const a = entry(1, "a@blocked.example");
    const b = entry(2, "b@blocked.example");
    const first = await round(adapter, [a], initialCleanState());
    const plan = await adapter.plan([b], first.state);
    expect(plan.changes.map((c) => [c.kind, c.entry.id])).toEqual([
      ["remove", a.id],
      ["create", b.id],
    ]);
  });

  it("refuses an entry that fails the semantic check", async () => {
    const { adapter } = rig(new FakeBox());
    const bad = entry(1, "not an address");
    await expect(adapter.plan([bad], initialCleanState())).rejects.toMatchObject({
      code: "REJECTED",
    });
  });

  it("refuses another adapter's state", async () => {
    const { adapter } = rig(new FakeBox());
    await expect(adapter.plan([], { adapterId: "sieve", data: {} })).rejects.toMatchObject({
      code: "REJECTED",
    });
  });

  it("does not start a round for past mail while the mailbox is away", async () => {
    const a = entry(1, "a@blocked.example");
    const queued = { adapterId: "imap-clean", data: { applied: [a], retro: [a.id] } };
    const away = rig(null, queued);
    expect((await away.adapter.plan([a], queued)).changes).toEqual([]);
    const back = rig(new FakeBox(), queued);
    expect((await back.adapter.plan([a], queued)).changes).toHaveLength(1);
  });

  it("names a bounded part of a long queue in the journal", async () => {
    const list = Array.from({ length: RETRO_ENTRIES_PER_PLAN + 5 }, (_, i) =>
      entry(i, `u${String(i)}@blocked.example`),
    );
    const state = {
      adapterId: "imap-clean",
      data: { applied: list, retro: list.map((e) => e.id) },
    };
    const { adapter } = rig(new FakeBox(), state);
    expect((await adapter.plan(list, state)).changes).toHaveLength(RETRO_ENTRIES_PER_PLAN);
  });

  it("plans nothing for a retired account", async () => {
    const { adapter } = rig(new FakeBox());
    adapter.retire();
    const plan = await adapter.plan([entry(1, "a@blocked.example")], initialCleanState());
    expect(plan.changes).toEqual([]);
  });
});

describe("clearing past mail", () => {
  it("moves what a rule reaches and leaves a display-name look-alike alone", async () => {
    const box = new FakeBox().fill([
      [1, "spam@blocked.example"],
      [2, "friend@friend.example"],
      // SEARCH FROM is a substring match over the whole header: a display name would hit it.
      [3, "spam@blocked.example.friend.example"],
    ]);
    const { adapter, events } = rig(box);
    const result = await round(adapter, [entry(1, "spam@blocked.example")], initialCleanState());
    expect(box.moves).toEqual([{ uids: [1], folder: "Junk" }]);
    expect([...box.mail.keys()].sort()).toEqual([2, 3]);
    expect(dataOf(result.state).retro).toEqual([]);
    expect(result.deferred).toBeUndefined();
    expect(events).toMatchObject([{ kind: "retro", moved: 1, failed: 0, left: 0 }]);
  });

  it("sends Trash entries to the provider's own Trash folder, Junk ones to Junk", async () => {
    const box = new FakeBox().fill([
      [1, "a@blocked.example"],
      [2, "b@blocked.example"],
    ]);
    const { adapter } = rig(box);
    await round(
      adapter,
      [
        entry(1, "a@blocked.example", "exactAddress", "trash"),
        entry(2, "b@blocked.example", "exactAddress", "reject"),
      ],
      initialCleanState(),
    );
    expect(box.moves).toEqual([
      { uids: [2], folder: "Junk" },
      { uids: [1], folder: "Deleted Messages" },
    ]);
  });

  it("makes the folder when the server has none, once", async () => {
    const box = new FakeBox().fill([
      [1, "a@blocked.example"],
      [2, "a@blocked.example"],
    ]);
    box.found = { junk: null, trash: null };
    const { adapter } = rig(box);
    const a = entry(1, "a@blocked.example");
    const after = await round(adapter, [a], initialCleanState());
    box.fill([[3, "b@blocked.example"]]);
    await round(adapter, [a, entry(2, "b@blocked.example")], after.state);
    expect(box.created).toEqual(["Junk"]);
    expect(box.listed).toBe(1);
  });

  it("sends at most RETRO_BATCH entries per search, and every entry once", async () => {
    const list = Array.from({ length: RETRO_BATCH * 2 + 1 }, (_, i) =>
      entry(i, `u${String(i)}@blocked.example`),
    );
    const box = new FakeBox().fill([[1, "friend@friend.example"]]);
    const { adapter } = rig(box);
    await round(adapter, list, initialCleanState());
    expect(box.searches.map((s) => s.length)).toEqual([RETRO_BATCH, RETRO_BATCH, 1]);
  });

  it("moves in commands of at most CLEAN_UIDS_PER_COMMAND, never one per mail", async () => {
    const rows = Array.from(
      { length: CLEAN_UIDS_PER_COMMAND + 1 },
      (_, i) => [i + 1, "a@blocked.example"] as const,
    );
    const box = new FakeBox().fill(rows);
    const { adapter } = rig(box);
    await round(adapter, [entry(1, "a@blocked.example")], initialCleanState());
    expect(box.moves.map((m) => m.uids.length)).toEqual([CLEAN_UIDS_PER_COMMAND, 1]);
    expect(box.reads).toBe(2);
  });

  it("walks windows down from the top only until one comes back empty", async () => {
    const box = new FakeBox();
    box.top = RETRO_WINDOW_UIDS * 3;
    // Only the top window holds mail of the last 30 days.
    box.mail.set(box.top - 10, "a@blocked.example");
    const { adapter } = rig(box);
    await round(adapter, [entry(1, "a@blocked.example")], initialCleanState());
    expect(box.probes).toHaveLength(2);
    expect(box.moves).toHaveLength(1);
  });

  it("reads no further back than RETRO_MAX_UIDS", async () => {
    const box = new FakeBox();
    box.top = RETRO_MAX_UIDS * 3;
    for (let hi = box.top; hi > 0; hi -= RETRO_WINDOW_UIDS) box.mail.set(hi, "x@y.example");
    const { adapter } = rig(box);
    await round(adapter, [entry(1, "a@blocked.example")], initialCleanState());
    expect(box.probes).toHaveLength(RETRO_MAX_UIDS / RETRO_WINDOW_UIDS);
    const lowest = Math.min(...box.probes.map((p) => Number(p.split(":")[0])));
    expect(lowest).toBe(box.top - RETRO_MAX_UIDS + 1);
  });

  it("clears the queue at once when nothing arrived in the last days", async () => {
    const box = new FakeBox();
    box.top = 10;
    const { adapter } = rig(box);
    const result = await round(adapter, [entry(1, "a@blocked.example")], initialCleanState());
    expect(box.searches).toEqual([]);
    expect(dataOf(result.state).retro).toEqual([]);
  });

  it("uses a window RETRO_DAYS long", () => {
    expect(RETRO_DAYS).toBe(30);
  });

  it("stops at the round's time and leaves the rest for the engine to go on with", async () => {
    const list = Array.from({ length: RETRO_BATCH + 1 }, (_, i) =>
      entry(i, `u${String(i)}@blocked.example`),
    );
    const box = new FakeBox().fill([[1, "friend@friend.example"]]);
    const { adapter, clock } = rig(box);
    box.onSearch = () => {
      clock.now += RETRO_ROUND_MS;
    };
    const result = await round(adapter, list, initialCleanState());
    expect(box.searches).toHaveLength(1);
    expect(dataOf(result.state).retro).toHaveLength(1);
    expect(result.deferred).toBe(1);
  });

  it("keeps the rules and the queue when the mailbox is away, with no timer behind them", async () => {
    const { adapter } = rig(null);
    const a = entry(1, "a@blocked.example");
    const result = await round(adapter, [a], initialCleanState());
    expect(dataOf(result.state)).toMatchObject({ retro: [a.id] });
    expect(result.deferred).toBeUndefined();
    expect(result.failed).toEqual([]);
  });

  it("keeps the queue when the connection goes in the middle, and fails nothing", async () => {
    const box = new FakeBox().fill([[1, "a@blocked.example"]]);
    box.loseConnection = true;
    const { adapter, link } = rig(box);
    const a = entry(1, "a@blocked.example");
    const pending = round(adapter, [a], initialCleanState());
    link.detach(box);
    const result = await pending;
    expect(dataOf(result.state).retro).toEqual([a.id]);
    expect(result.failed).toEqual([]);
  });

  it("gives up one read, and goes on below it, on a mail too large to read", async () => {
    const rows = Array.from(
      { length: CLEAN_UIDS_PER_COMMAND + 5 },
      (_, i) => [i + 1, "a@blocked.example"] as const,
    );
    const box = new FakeBox().fill(rows);
    box.unreadable = true;
    const { adapter, events } = rig(box);
    const first = await round(adapter, [entry(1, "a@blocked.example")], initialCleanState());
    expect(events[0]).toMatchObject({ failed: CLEAN_UIDS_PER_COMMAND, left: 1 });
    box.unreadable = false;
    await adapter.apply(await adapter.plan([entry(1, "a@blocked.example")], first.state));
    expect(box.moves.flatMap((m) => m.uids).sort((x, y) => x - y)).toEqual([1, 2, 3, 4, 5]);
  });

  it("gets through a step however slow the search, so a queue always ends", async () => {
    const a = entry(1, "x@blocked.example");
    const rows = Array.from(
      { length: CLEAN_UIDS_PER_COMMAND * 2 },
      (_, i) => [i + 1, "x@blocked.example"] as const,
    );
    const box = new FakeBox().fill(rows);
    const { adapter, clock } = rig(box);
    box.onSearch = () => {
      clock.now += RETRO_ROUND_MS * 2;
    };
    const first = await round(adapter, [a], initialCleanState());
    expect(box.moves).toHaveLength(1);
    expect(first.deferred).toBe(1);
    const second = await adapter.apply(await adapter.plan([a], first.state));
    expect(box.mail.size).toBe(0);
    expect(dataOf(second.state)).toMatchObject({ retro: [], pass: null });
  });

  it("does not read the same false candidates twice", async () => {
    const a = entry(1, "x@blocked.example");
    // A display name holds the address: the search finds them, and nothing moves, so only the saved pass can end this.
    const rows = Array.from(
      { length: CLEAN_UIDS_PER_COMMAND * 2 },
      (_, i) => [i + 1, "x@blocked.example.friend.example"] as const,
    );
    const box = new FakeBox().fill(rows);
    const { adapter, clock } = rig(box);
    const read = vi.spyOn(box, "readFrom");
    read.mockImplementation((uids) => {
      clock.now += RETRO_ROUND_MS;
      return Promise.resolve(uids.map((uid) => ({ uid, from: box.mail.get(uid) ?? "" })));
    });
    const first = await round(adapter, [a], initialCleanState());
    expect(read).toHaveBeenCalledTimes(1);
    const second = await adapter.apply(await adapter.plan([a], first.state));
    expect(read).toHaveBeenCalledTimes(2);
    expect(dataOf(second.state).retro).toEqual([]);
  });

  it("reads a long queue's window once, with no search", async () => {
    const list = Array.from({ length: RETRO_SCAN_ABOVE + 1 }, (_, i) =>
      entry(i, `u${String(i)}@blocked.example`),
    );
    const box = new FakeBox().fill([
      [1, "u7@blocked.example"],
      [2, "friend@friend.example"],
    ]);
    const { adapter } = rig(box);
    const result = await round(adapter, list, initialCleanState());
    expect(box.searches).toEqual([]);
    expect(box.reads).toBe(1);
    expect([...box.mail.keys()]).toEqual([2]);
    expect(dataOf(result.state).retro).toEqual([]);
  });

  it("searches a domain precisely, with subdomains only when asked", async () => {
    const box = new FakeBox().fill([
      [1, "a@king.example"],
      [2, "a@booking.example"],
    ]);
    const { adapter } = rig(box);
    const after = await round(
      adapter,
      [entry(1, "king.example", "exactDomain")],
      initialCleanState(),
    );
    expect(box.searches).toEqual([["@king.example"]]);
    expect(box.reads).toBe(1);
    await round(
      adapter,
      [entry(1, "king.example", "exactDomain"), entry(2, "wide.example", "subdomains")],
      after.state,
    );
    expect(box.searches.at(-1)).toEqual(["@wide.example", ".wide.example"]);
  });

  it("starts a pass over when the entries it stood for changed", async () => {
    const a = entry(1, "a@blocked.example");
    const b = entry(2, "b@blocked.example");
    const pass = { size: 2, below: 2, validity: "1" };
    const state = {
      adapterId: "imap-clean",
      data: { applied: [a, b], retro: [a.id, b.id], pass },
    };
    const box = new FakeBox().fill([
      [1, "b@blocked.example"],
      [5, "b@blocked.example"],
    ]);
    const { adapter } = rig(box, state);
    await round(adapter, [b], state);
    expect(box.mail.size).toBe(0);
  });

  it("forgets how far it read when the mailbox was renumbered", async () => {
    const a = entry(1, "a@blocked.example");
    const pass = { size: 1, below: 2, validity: "1" };
    const state = { adapterId: "imap-clean", data: { applied: [a], retro: [a.id], pass } };
    const box = new FakeBox().fill([[5, "a@blocked.example"]]);
    box.validity = "2";
    const { adapter } = rig(box, state);
    await round(adapter, [a], state);
    expect(box.mail.size).toBe(0);
  });

  it("wakes up by itself after the rest", async () => {
    vi.useFakeTimers();
    try {
      const a = entry(1, "a@blocked.example");
      const box = new FakeBox().fill([[1, "a@blocked.example"]]);
      const state = { adapterId: "imap-clean", data: { applied: [a], retro: [a.id] } };
      const link = new CleanLink();
      link.attach(box);
      const onRested = vi.fn();
      const adapter = new ImapCleanAdapter({
        accountId: "x",
        link,
        initialState: state,
        onRested,
      });
      box.onSearch = () => {
        throw new Error("socket closed");
      };
      for (let i = 0; i < RETRO_ABORTS_MAX; i += 1) {
        await expect(round(adapter, [a], state)).rejects.toThrow();
      }
      await vi.advanceTimersByTimeAsync(RETRO_HOLD_MS);
      expect(onRested).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it("rests twice as long each time, up to the ceiling, until a read gets somewhere", async () => {
    vi.useFakeTimers();
    try {
      const a = entry(1, "a@blocked.example");
      const box = new FakeBox().fill([[1, "a@blocked.example"]]);
      const state = { adapterId: "imap-clean", data: { applied: [a], retro: [a.id] } };
      const link = new CleanLink();
      link.attach(box);
      const onRested = vi.fn();
      const adapter = new ImapCleanAdapter({ accountId: "x", link, initialState: state, onRested });
      box.onSearch = () => {
        throw new Error("socket closed");
      };
      const strikeOut = async (): Promise<void> => {
        for (let i = 0; i < RETRO_ABORTS_MAX; i += 1) {
          await expect(round(adapter, [a], state)).rejects.toThrow();
        }
      };
      let expected = 0;
      for (const rest of [
        RETRO_HOLD_MS,
        RETRO_HOLD_MS * 2,
        RETRO_HOLD_MS * 4,
        RETRO_HOLD_MS * 8,
        RETRO_HOLD_MAX_MS,
        RETRO_HOLD_MAX_MS,
      ]) {
        await strikeOut();
        await vi.advanceTimersByTimeAsync(rest - 1);
        expect(onRested).toHaveBeenCalledTimes(expected);
        await vi.advanceTimersByTimeAsync(1);
        expected += 1;
        expect(onRested).toHaveBeenCalledTimes(expected);
      }
      box.onSearch = () => undefined;
      await round(adapter, [a], state);
      box.fill([[2, "a@blocked.example"]]);
      box.onSearch = () => {
        throw new Error("socket closed");
      };
      await strikeOut();
      await vi.advanceTimersByTimeAsync(RETRO_HOLD_MS);
      expect(onRested).toHaveBeenCalledTimes(expected + 1);
    } finally {
      vi.useRealTimers();
    }
  });

  it("clears the wake-up when the account is removed", async () => {
    vi.useFakeTimers();
    try {
      const a = entry(1, "a@blocked.example");
      const box = new FakeBox().fill([[1, "a@blocked.example"]]);
      const state = { adapterId: "imap-clean", data: { applied: [a], retro: [a.id] } };
      const link = new CleanLink();
      link.attach(box);
      const onRested = vi.fn();
      const adapter = new ImapCleanAdapter({ accountId: "x", link, initialState: state, onRested });
      box.onSearch = () => {
        throw new Error("socket closed");
      };
      for (let i = 0; i < RETRO_ABORTS_MAX; i += 1) {
        await expect(round(adapter, [a], state)).rejects.toThrow();
      }
      adapter.retire();
      await vi.advanceTimersByTimeAsync(RETRO_HOLD_MS);
      expect(onRested).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it("asks for a round on a new session after a round that failed", async () => {
    const box = new FakeBox().fill([[1, "a@blocked.example"]]);
    box.refuseMoves = true;
    const { adapter } = rig(box);
    const a = entry(1, "a@blocked.example");
    await expect(round(adapter, [a], initialCleanState())).rejects.toMatchObject({
      code: "REJECTED",
    });
    expect(adapter.hasWork).toBe(true);
    box.refuseMoves = false;
    await round(adapter, [a], initialCleanState());
    expect(adapter.hasWork).toBe(false);
  });

  it("lets a renumbered mailbox past the hourly limit, but not at every gap", async () => {
    const a = entry(1, "a@blocked.example");
    const state = { adapterId: "imap-clean", data: { applied: [a], retro: [] } };
    const { adapter, clock } = rig(new FakeBox(), state);
    adapter.sweepAll();
    const first = await round(adapter, [a], state);
    expect((await adapter.plan([a], first.state)).changes).toHaveLength(0);
    clock.now += RETRO_HOLD_MS - 1;
    adapter.sweepAll(true);
    expect((await adapter.plan([a], first.state)).changes).toHaveLength(0);
    clock.now += 1;
    adapter.sweepAll(true);
    expect((await adapter.plan([a], first.state)).changes).toHaveLength(1);
  });

  it("keeps a request inside the hourly limit for the end of it, as one sweep", async () => {
    vi.useFakeTimers();
    try {
      const a = entry(1, "a@blocked.example");
      const state = { adapterId: "imap-clean", data: { applied: [a], retro: [] } };
      const link = new CleanLink();
      link.attach(new FakeBox());
      const onRested = vi.fn();
      const adapter = new ImapCleanAdapter({ accountId: "x", link, initialState: state, onRested });
      adapter.sweepAll();
      const first = await round(adapter, [a], state);
      adapter.sweepAll();
      adapter.sweepAll();
      expect(adapter.hasWork).toBe(false);
      await vi.advanceTimersByTimeAsync(SWEEP_ALL_GAP_MS - 1);
      expect(onRested).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(1);
      expect(onRested).toHaveBeenCalledTimes(1);
      expect((await adapter.plan([a], first.state)).changes).toHaveLength(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it("brings a waiting sweep forward for a renumbered mailbox, and clears it on removal", async () => {
    vi.useFakeTimers();
    try {
      const link = new CleanLink();
      link.attach(new FakeBox());
      const onRested = vi.fn();
      const adapter = new ImapCleanAdapter({
        accountId: "x",
        link,
        initialState: initialCleanState(),
        onRested,
      });
      adapter.sweepAll();
      adapter.sweepAll();
      adapter.sweepAll(true);
      await vi.advanceTimersByTimeAsync(RETRO_HOLD_MS);
      expect(onRested).toHaveBeenCalledTimes(1);
      adapter.sweepAll();
      adapter.retire();
      adapter.sweepAll();
      await vi.advanceTimersByTimeAsync(SWEEP_ALL_GAP_MS);
      expect(onRested).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it("keeps a pass when a new entry joins behind it", async () => {
    const a = entry(1, "a@blocked.example");
    const b = entry(2, "b@blocked.example");
    const state = {
      adapterId: "imap-clean",
      data: { applied: [a], retro: [a.id], pass: { size: 1, below: 3, validity: "1" } },
    };
    const box = new FakeBox().fill([
      [1, "a@blocked.example"],
      [4, "a@blocked.example"],
      [5, "b@blocked.example"],
    ]);
    const { adapter } = rig(box, state);
    await round(adapter, [a, b], state);
    expect([...box.mail.keys()]).toEqual([4]);
  });

  it("asks for a round on a new session only with work waiting", async () => {
    const a = entry(1, "a@blocked.example");
    const quiet = rig(new FakeBox(), {
      adapterId: "imap-clean",
      data: { applied: [a], retro: [] },
    });
    expect(quiet.adapter.hasWork).toBe(false);
    quiet.adapter.sweepAll();
    expect(quiet.adapter.hasWork).toBe(true);
    const queued = rig(null, { adapterId: "imap-clean", data: { applied: [a], retro: [a.id] } });
    expect(queued.adapter.hasWork).toBe(true);
    const done = await round(
      rig(new FakeBox().fill([[1, "x@y.example"]])).adapter,
      [a],
      initialCleanState(),
    );
    expect(dataOf(done.state).retro).toEqual([]);
  });

  it("refuses to work on a server that cannot move by UID", async () => {
    const box = new FakeBox().fill([[1, "a@blocked.example"]]);
    box.movable = false;
    const { adapter } = rig(box);
    await expect(
      round(adapter, [entry(1, "a@blocked.example")], initialCleanState()),
    ).rejects.toMatchObject({ code: "CAPABILITY_NOT_SUPPORTED" });
    expect(box.mail.size).toBe(1);
  });

  it("fails the round when the server will not make the folder, so nothing reads as done", async () => {
    const box = new FakeBox().fill([[1, "a@blocked.example"]]);
    box.found = { junk: null, trash: null };
    box.refuseCreate = true;
    const { adapter } = rig(box);
    await expect(
      round(adapter, [entry(1, "a@blocked.example")], initialCleanState()),
    ).rejects.toMatchObject({ code: "REJECTED" });
    expect(box.mail.size).toBe(1);
  });

  it("stops moving on an Unblock even when the round that added the rule failed", async () => {
    const box = new FakeBox();
    box.refuseCreate = true;
    box.found = { junk: null, trash: null };
    box.fill([[1, "spam@blocked.example"]]);
    const { adapter } = rig(box);
    const a = entry(1, "spam@blocked.example");
    await expect(round(adapter, [a], initialCleanState())).rejects.toMatchObject({
      code: "REJECTED",
    });
    // Nothing was saved, so the plan for an empty list has no change and `apply` never runs.
    expect((await adapter.plan([], initialCleanState())).changes).toEqual([]);
    box.refuseCreate = false;
    const fresh = [incoming(5, "spam@blocked.example")];
    expect(await adapter.screen(fresh)).toBe(fresh);
    expect(box.moves).toEqual([]);
  });

  it("fails a round the server would not finish while the session stays up", async () => {
    const box = new FakeBox().fill([[1, "a@blocked.example"]]);
    box.loseConnection = true;
    const { adapter } = rig(box);
    await expect(
      round(adapter, [entry(1, "a@blocked.example")], initialCleanState()),
    ).rejects.toMatchObject({ code: "TRANSIENT" });
  });

  it("counts lost connections, so one bad mail cannot turn into a login loop", async () => {
    const a = entry(1, "a@blocked.example");
    const box = new FakeBox().fill([[1, "a@blocked.example"]]);
    const state = { adapterId: "imap-clean", data: { applied: [a], retro: [a.id] } };
    const { adapter, link } = rig(box, state);
    link.detach(box);
    box.onSearch = () => {
      link.detach(box);
      throw new Error("socket closed");
    };
    for (let i = 0; i < RETRO_ABORTS_MAX; i += 1) {
      link.attach(box);
      await round(adapter, [a], state);
    }
    const searches = box.searches.length;
    link.attach(box);
    expect((await adapter.plan([a], state)).changes).toEqual([]);
    expect(box.searches).toHaveLength(searches);
  });

  it("keeps a request to walk everything through a failed round", async () => {
    const a = entry(1, "a@blocked.example");
    const box = new FakeBox().fill([[1, "a@blocked.example"]]);
    box.refuseMoves = true;
    const state = { adapterId: "imap-clean", data: { applied: [a], retro: [] } };
    const { adapter } = rig(box, state);
    adapter.sweepAll();
    await expect(round(adapter, [a], state)).rejects.toMatchObject({ code: "REJECTED" });
    box.refuseMoves = false;
    await round(adapter, [a], state);
    expect(box.moves).toHaveLength(1);
  });

  it("looks at the folders again after a refused move", async () => {
    const a = entry(1, "a@blocked.example");
    const box = new FakeBox().fill([[1, "a@blocked.example"]]);
    box.refuseMoves = true;
    const state = { adapterId: "imap-clean", data: { applied: [a], retro: [a.id] } };
    const { adapter } = rig(box, state);
    await expect(round(adapter, [a], state)).rejects.toMatchObject({ code: "REJECTED" });
    box.refuseMoves = false;
    await round(adapter, [a], state);
    expect(box.listed).toBe(2);
  });

  it("drops the connection when the engine gives up on the round", async () => {
    const box = new FakeBox().fill([[1, "a@blocked.example"]]);
    const { adapter } = rig(box);
    const controller = new AbortController();
    box.onSearch = () => {
      controller.abort(new AdapterError("TRANSIENT", "late"));
    };
    const plan = await adapter.plan([entry(1, "a@blocked.example")], initialCleanState());
    await expect(adapter.apply(plan, controller.signal)).rejects.toMatchObject({
      code: "TRANSIENT",
    });
    expect(box.destroyed).toBe(true);
    expect(box.moves).toEqual([]);
  });

  it("rests after the engine gave up on it three times, and the rules go on working", async () => {
    const a = entry(1, "a@blocked.example");
    const box = new FakeBox().fill([[1, "a@blocked.example"]]);
    const state = { adapterId: "imap-clean", data: { applied: [a], retro: [a.id] } };
    const { adapter, clock } = rig(box, state);
    let controller = new AbortController();
    box.onSearch = () => {
      controller.abort(new AdapterError("TRANSIENT", "late"));
      throw new Error("socket closed");
    };
    for (let i = 0; i < RETRO_ABORTS_MAX; i += 1) {
      controller = new AbortController();
      const plan = await adapter.plan([a], state);
      await expect(adapter.apply(plan, controller.signal)).rejects.toThrow();
    }
    const searches = box.searches.length;
    expect((await adapter.plan([a], state)).changes).toEqual([]);

    const b = entry(2, "b@blocked.example");
    const held = await round(adapter, [a, b], state);
    expect(box.searches).toHaveLength(searches);
    expect(held.deferred).toBeUndefined();
    expect(dataOf(held.state).retro).toEqual([a.id, b.id]);
    box.onSearch = () => undefined;
    expect(await adapter.screen([incoming(9, "b@blocked.example")])).toEqual([]);

    clock.now += RETRO_HOLD_MS;
    expect((await adapter.plan([a, b], held.state)).changes).toHaveLength(2);
  });

  it("walks every rule at most once an hour, however often a gap repeats", async () => {
    const a = entry(1, "a@blocked.example");
    const state = { adapterId: "imap-clean", data: { applied: [a], retro: [] } };
    const { adapter, clock } = rig(new FakeBox(), state);
    adapter.sweepAll();
    const first = await round(adapter, [a], state);
    adapter.sweepAll();
    expect((await adapter.plan([a], first.state)).changes).toEqual([]);
    clock.now += SWEEP_ALL_GAP_MS;
    adapter.sweepAll();
    expect((await adapter.plan([a], first.state)).changes).toHaveLength(1);
  });

  it("walks the whole list again after mail went by unseen, and only once", async () => {
    const a = entry(1, "a@blocked.example");
    const box = new FakeBox().fill([[1, "a@blocked.example"]]);
    const state = { adapterId: "imap-clean", data: { applied: [a], retro: [] } };
    const { adapter } = rig(box, state);
    expect((await adapter.plan([a], state)).changes).toEqual([]);
    adapter.sweepAll();
    const result = await round(adapter, [a], state);
    expect(box.moves).toHaveLength(1);
    expect((await adapter.plan([a], result.state)).changes).toEqual([]);
  });

  it("has nothing to clear for an entry taken off while queued", async () => {
    const a = entry(1, "a@blocked.example");
    const state = { adapterId: "imap-clean", data: { applied: [a], retro: [a.id] } };
    const box = new FakeBox().fill([[1, "a@blocked.example"]]);
    const { adapter } = rig(box, state);
    const result = await round(adapter, [], state);
    expect(box.moves).toEqual([]);
    expect(dataOf(result.state)).toEqual({ applied: [], retro: [], pass: null });
  });
});

describe("screen", () => {
  it("moves blocked mail and hands back the rest to announce", async () => {
    const box = new FakeBox();
    const a = entry(1, "spam@blocked.example");
    const state = { adapterId: "imap-clean", data: { applied: [a], retro: [] } };
    const { adapter, events } = rig(box, state);
    const left = await adapter.screen([
      incoming(5, "spam@blocked.example"),
      incoming(6, "friend@friend.example"),
    ]);
    expect(left.map((m) => m.uid)).toEqual([6]);
    expect(box.moves).toEqual([{ uids: [5], folder: "Junk" }]);
    expect(events).toMatchObject([{ kind: "arrival", moved: 1, failed: 0 }]);
  });

  it("holds the rules from the saved state, before any round has run", async () => {
    const box = new FakeBox();
    const a = entry(1, "blocked.example", "subdomains");
    const { adapter } = rig(box, { adapterId: "imap-clean", data: { applied: [a], retro: [] } });
    await adapter.screen([incoming(5, "x@mail.blocked.example")]);
    expect(box.moves).toHaveLength(1);
  });

  it("acts on a new rule as soon as a round writes it, and stops on an Unblock", async () => {
    const box = new FakeBox();
    const { adapter } = rig(box);
    const a = entry(1, "spam@blocked.example");
    const after = await round(adapter, [a], initialCleanState());
    await adapter.screen([incoming(5, "spam@blocked.example")]);
    expect(box.moves).toHaveLength(1);
    await round(adapter, [], after.state);
    const left = await adapter.screen([incoming(6, "spam@blocked.example")]);
    expect(left).toHaveLength(1);
    expect(box.moves).toHaveLength(1);
  });

  it("says nothing and reads no folders when no rule reaches the batch", async () => {
    const box = new FakeBox();
    const { adapter, events } = rig(box);
    const fresh = [incoming(5, "friend@friend.example")];
    expect(await adapter.screen(fresh)).toBe(fresh);
    expect(box.listed).toBe(0);
    expect(events).toEqual([]);
  });

  it("reports a refused move without announcing the blocked mail", async () => {
    const box = new FakeBox();
    box.refuseMoves = true;
    const a = entry(1, "spam@blocked.example");
    const state = { adapterId: "imap-clean", data: { applied: [a], retro: [] } };
    const { adapter, events } = rig(box, state);
    const left = await adapter.screen([incoming(5, "spam@blocked.example")]);
    expect(left).toEqual([]);
    expect(events).toMatchObject([{ kind: "arrival", moved: 0, failed: 1 }]);
  });

  it("throws on a lost connection, so the cursor stays and the mail is seen again", async () => {
    const box = new FakeBox();
    box.loseConnection = true;
    const a = entry(1, "spam@blocked.example");
    const state = { adapterId: "imap-clean", data: { applied: [a], retro: [] } };
    const { adapter } = rig(box, state);
    await expect(adapter.screen([incoming(5, "spam@blocked.example")])).rejects.toThrow(
      "connection lost",
    );
  });

  it("throws when a blocked mail arrives and the mailbox is gone", async () => {
    const a = entry(1, "spam@blocked.example");
    const { adapter } = rig(null, { adapterId: "imap-clean", data: { applied: [a], retro: [] } });
    await expect(adapter.screen([incoming(5, "spam@blocked.example")])).rejects.toThrow();
  });

  it("moves nothing once retired", async () => {
    const box = new FakeBox();
    const a = entry(1, "spam@blocked.example");
    const { adapter } = rig(box, { adapterId: "imap-clean", data: { applied: [a], retro: [] } });
    adapter.retire();
    const fresh = [incoming(5, "spam@blocked.example")];
    expect(await adapter.screen(fresh)).toBe(fresh);
    expect(box.moves).toEqual([]);
  });
});

describe("verify", () => {
  it("passes only while the mailbox is connected", async () => {
    const box = new FakeBox();
    const { adapter, link } = rig(box);
    expect((await adapter.verify(initialCleanState())).drifted).toBe(false);
    link.detach(box);
    const drift = await adapter.verify(initialCleanState());
    expect(drift.drifted).toBe(true);
    expect(drift.detail).toContain("not connected");
  });

  it("says so after a refused move, until a move works", async () => {
    const box = new FakeBox();
    box.refuseMoves = true;
    const a = entry(1, "spam@blocked.example");
    const state = { adapterId: "imap-clean", data: { applied: [a], retro: [] } };
    const { adapter } = rig(box, state);
    await adapter.screen([incoming(5, "spam@blocked.example")]);
    expect((await adapter.verify(state)).detail).toContain("refused");
    box.refuseMoves = false;
    await adapter.screen([incoming(6, "spam@blocked.example")]);
    expect((await adapter.verify(state)).drifted).toBe(false);
  });

  it("opens no connection and sends no command", async () => {
    const box = new FakeBox();
    const spy = vi.spyOn(box, "folders");
    const { adapter } = rig(box);
    await adapter.verify(initialCleanState());
    expect(spy).not.toHaveBeenCalled();
    expect(box.searches).toEqual([]);
  });

  it("fails for a retired account instead of confirming a change nothing wrote", async () => {
    const { adapter } = rig(new FakeBox());
    adapter.retire();
    await expect(adapter.verify(initialCleanState())).rejects.toMatchObject({ code: "TRANSIENT" });
    await expect(
      adapter.apply({
        accountId: "x",
        changes: [],
        basedOn: initialCleanState(),
      }),
    ).rejects.toMatchObject({ code: "TRANSIENT" });
  });
});
