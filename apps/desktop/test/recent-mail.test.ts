import { describe, expect, it, vi } from "vitest";
import { AdapterError, RECENT_MAX, RecentTooLargeError } from "@senderban/core";
import type { BlockEntry, RecentMail } from "@senderban/core";
import {
  ANNOUNCED_PER_ACCOUNT,
  Announcements,
  CLOCK_SLACK_MS,
  MISSED_WINDOW_MS,
  RECENT_CONCURRENCY,
  RECENT_LOOK_WAIT_MS,
  RECENT_REFRESH_MIN_MS,
  RECENT_TIMEOUT_MS,
  RECENT_TTL_MS,
  RecentMailService,
  recentMarks,
} from "../src/recent-mail.js";
import type { RecentDeps, RecentMarkInputs, RecentSource } from "../src/recent-mail.js";

const T0 = Date.UTC(2026, 10, 23, 12);

const mail = (
  id: string,
  from: string | null,
  receivedMs: number | null = T0 - 60_000,
): RecentMail => ({
  id,
  from,
  subject: `subject ${id}`,
  receivedMs,
});

function source(
  accountId: string,
  answer: () => Promise<readonly RecentMail[] | null>,
): RecentSource & { reads: number } {
  const s = {
    accountId,
    provider: "imap" as const,
    reads: 0,
    read: () => {
      s.reads += 1;
      return answer();
    },
  };
  return s;
}

function rig(sources: RecentSource[], over: Partial<RecentDeps> = {}) {
  const clock = { t: T0 };
  const logs: [string, Record<string, unknown>][] = [];
  const announced = new Announcements();
  const service = new RecentMailService({
    sources: () => sources,
    label: (id) => `${id}@mail.example`,
    marks: () => () => null,
    announced,
    blockAct: () => "junk",
    tag: (id) => `acct-${id}`,
    log: (event, fields) => logs.push([event, fields ?? {}]),
    now: () => clock.t,
    // Started long ago: only the tests of the start see it.
    startedAt: T0 - 2 * MISSED_WINDOW_MS,
    ...over,
  });
  return { service, clock, logs, announced };
}

describe("RecentMailService", () => {
  it("shows every account's newest mail in one list, newest first, with no account or message id", async () => {
    const a = source("a", () => Promise.resolve([mail("1", "x@one.example", T0 - 3_000)]));
    const b = source("b", () =>
      Promise.resolve([mail("2", "y@two.example", T0 - 1_000), mail("3", "z@two.example", null)]),
    );
    const { service } = rig([a, b]);
    const view = await service.view();
    expect(view.rows.map((r) => [r.account, r.from])).toEqual([
      ["b@mail.example", "y@two.example"],
      ["a@mail.example", "x@one.example"],
      ["b@mail.example", "z@two.example"],
    ]);
    expect(Object.keys(view.rows[0] ?? {}).sort()).toEqual(
      ["account", "blockAct", "from", "key", "mark", "receivedMs", "subject"].sort(),
    );
    expect(view.problems).toEqual([]);
  });

  it("keeps what it read for RECENT_TTL_MS: a second look sends nothing", async () => {
    const a = source("a", () => Promise.resolve([mail("1", "x@one.example")]));
    const { service, clock } = rig([a]);
    await service.view();
    clock.t += RECENT_TTL_MS - 1;
    await service.view();
    expect(a.reads).toBe(1);
    clock.t += 1;
    await service.view();
    expect(a.reads).toBe(2);
  });

  it("Refresh reads again, but no sooner than RECENT_REFRESH_MIN_MS per account", async () => {
    const a = source("a", () => Promise.resolve([]));
    const { service, clock } = rig([a]);
    await service.view();
    await service.view(true);
    expect(a.reads).toBe(1);
    clock.t += RECENT_REFRESH_MIN_MS;
    await service.view(true);
    expect(a.reads).toBe(2);
  });

  it("answers a second open during a read with the same look, not a second read", async () => {
    const gate: { release?: (rows: readonly RecentMail[]) => void } = {};
    const a = source(
      "a",
      () =>
        new Promise<readonly RecentMail[]>((resolve) => {
          gate.release = resolve;
        }),
    );
    const { service } = rig([a]);
    const first = service.view();
    const second = service.view(true);
    gate.release?.([mail("1", "x@one.example")]);
    expect(await first).toBe(await second);
    expect(a.reads).toBe(1);
  });

  it("reads at most RECENT_CONCURRENCY accounts of a kind at once", async () => {
    let running = 0;
    let most = 0;
    const sources = Array.from({ length: 10 }, (_, i) =>
      source(String(i), async () => {
        running += 1;
        most = Math.max(most, running);
        await new Promise((resolve) => setTimeout(resolve, 1));
        running -= 1;
        return [];
      }),
    );
    await rig(sources).service.view();
    expect(most).toBe(RECENT_CONCURRENCY);
    expect(sources.every((s) => s.reads === 1)).toBe(true);
  });

  it("gives each provider kind its own pool: hung IMAP servers do not hold a Gmail read back", async () => {
    vi.useFakeTimers();
    try {
      const hung = Array.from({ length: RECENT_CONCURRENCY }, (_, i) =>
        source(`h${String(i)}`, () => new Promise<readonly RecentMail[]>(() => undefined)),
      );
      const gmail: RecentSource = {
        accountId: "g",
        provider: "gmail",
        read: () => Promise.resolve([mail("1", "x@one.example")]),
      };
      const look = rig([...hung, gmail]).service.view();
      await vi.advanceTimersByTimeAsync(RECENT_LOOK_WAIT_MS);
      expect((await look).rows.map((r) => r.from)).toEqual(["x@one.example"]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("does not wait past RECENT_TIMEOUT_MS for one account, and aborts its read", async () => {
    vi.useFakeTimers();
    try {
      let aborted = false;
      const slow: RecentSource = {
        accountId: "slow",
        provider: "gmail",
        read: (signal) =>
          new Promise(() => {
            signal.addEventListener("abort", () => {
              aborted = true;
            });
          }),
      };
      const quick = source("quick", () => Promise.resolve([mail("1", "x@one.example")]));
      const { service } = rig([slow, quick]);
      // The look shows what it has after RECENT_LOOK_WAIT_MS; the slow read goes on.
      const view = service.view();
      await vi.advanceTimersByTimeAsync(RECENT_LOOK_WAIT_MS);
      const early = await view;
      expect(early.rows).toHaveLength(1);
      expect(early.problems).toEqual([{ account: "slow@mail.example", status: "reading" }]);
      expect(aborted).toBe(false);
      // A look meanwhile joins the running read instead of starting another.
      const again = service.view();
      await vi.advanceTimersByTimeAsync(RECENT_TIMEOUT_MS - RECENT_LOOK_WAIT_MS);
      expect((await again).problems[0]?.status).toBe("reading");
      expect(aborted).toBe(true);
      const done = await service.view();
      expect(done.rows).toHaveLength(1);
      expect(done.problems).toEqual([{ account: "slow@mail.example", status: "error" }]);
      expect(quick.reads).toBe(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it("says which accounts could not be read, and keeps the rows it had through a passing failure", async () => {
    let fail = false;
    const a = source("a", () =>
      fail ? Promise.reject(new Error("socket")) : Promise.resolve([mail("1", "x@one.example")]),
    );
    const off = source("off", () => Promise.resolve(null));
    const limited = source("lim", () =>
      Promise.reject(new AdapterError("QUOTA_EXCEEDED", "our own line")),
    );
    const { service, clock, logs } = rig([a, off, limited]);
    await service.view();
    fail = true;
    clock.t += RECENT_REFRESH_MIN_MS;
    const view = await service.view(true);
    expect(view.rows.map((r) => r.from)).toEqual(["x@one.example"]);
    expect(view.problems).toEqual([
      { account: "a@mail.example", status: "error" },
      { account: "off@mail.example", status: "offline" },
      { account: "lim@mail.example", status: "limit" },
    ]);
    // The log names the account by its tag and counts; no address, no subject.
    const line = logs.find(([e]) => e === "recent-read")?.[1];
    expect(Object.keys(line ?? {}).sort()).toEqual([
      "account",
      "ms",
      "outcome",
      "provider",
      "rows",
    ]);
    // A failure says its kind, never its text.
    const failed = logs.filter(([e]) => e === "recent-read").map(([, f]) => f.error);
    expect(failed).toContain("Error");
    expect(failed).toContain("QUOTA_EXCEEDED");
    expect(JSON.stringify(logs)).not.toMatch(/one\.example|subject/u);
  });

  it("says an account holds a mail too large to list, apart from one that could not be read", async () => {
    const big = source("big", () => Promise.reject(new RecentTooLargeError("too large")));
    const view = await rig([big]).service.view();
    expect(view.problems).toEqual([{ account: "big@mail.example", status: "large" }]);
  });

  it("shows at most RECENT_MAX rows of an account, whatever the source hands back", async () => {
    const many = Array.from({ length: RECENT_MAX + 5 }, (_, i) => mail(String(i), "x@one.example"));
    const { service } = rig([source("a", () => Promise.resolve(many))]);
    expect((await service.view()).rows).toHaveLength(RECENT_MAX);
  });

  it("gives a key for each row a click can act on, and only for the last look", async () => {
    const a = source("a", () =>
      Promise.resolve([mail("1", "x@one.example"), mail("2", null), mail("3", "me@mine.example")]),
    );
    const { service, clock } = rig([a], {
      marks: () => (_id, sender) => (sender === "me@mine.example" ? "own" : null),
    });
    const view = await service.view();
    const [row, unreadable, own] = view.rows;
    expect(service.take(unreadable?.key ?? "")).toBeNull();
    expect(service.take(own?.key ?? "")).toBeNull();
    // A key of an older look is dead, even unused.
    clock.t += 1;
    const next = (await service.view()).rows[0]?.key ?? "";
    expect(service.take(row?.key ?? "")).toBeNull();
    // One click per key, as a toast's id.
    expect(service.take(next)).toEqual({ accountId: "a", sender: "x@one.example" });
    expect(service.take(next)).toBeNull();
    expect(service.take("not-a-key")).toBeNull();
  });

  it("marks what the list already says, at each look, without reading again", async () => {
    const marks = new Map<string, "blocked" | "muted" | "own">();
    const a = source("a", () => Promise.resolve([mail("1", "x@one.example")]));
    let looks = 0;
    const { service, announced } = rig([a], {
      marks: () => {
        looks += 1;
        return (_id, sender) => marks.get(sender) ?? null;
      },
    });
    announced.record("a", "x@one.example", T0);
    expect((await service.view()).rows[0]?.mark).toBe("none");
    marks.set("x@one.example", "blocked");
    expect((await service.view()).rows[0]?.mark).toBe("blocked");
    expect(a.reads).toBe(1);
    // The lists are read once per look, not once per row.
    expect(looks).toBe(2);
  });

  it("marks as not notified a recent mail whose sender was not announced since it came", async () => {
    const a = source("a", () =>
      Promise.resolve([
        mail("1", "told@x.example", T0 - 60_000),
        mail("2", "missed@x.example", T0 - 60_000),
        mail("3", "old@x.example", T0 - MISSED_WINDOW_MS - 1),
        mail("4", "earlier@x.example", T0 - 60_000),
        mail("5", "notime@x.example", null),
      ]),
    );
    const { service, announced } = rig([a]);
    announced.record("a", "told@x.example", T0 - 30_000);
    // Announced long before this mail came: that was another mail.
    announced.record("a", "earlier@x.example", T0 - 60_000 - CLOCK_SLACK_MS - 1);
    // Another account's announcement says nothing about this one.
    announced.record("b", "missed@x.example", T0);
    const marks: Record<string, string> = Object.fromEntries(
      (await service.view()).rows.map((r) => [r.from ?? "", r.mark]),
    );
    expect(marks).toEqual({
      "told@x.example": "none",
      "missed@x.example": "missed",
      "old@x.example": "none",
      "earlier@x.example": "missed",
      "notime@x.example": "none",
    });
  });

  it("drops what it read RECENT_TTL_MS later, with no look in between: rows and the source's memo, not the keys the page shows", async () => {
    vi.useFakeTimers();
    try {
      const memos: number[] = [];
      const gmail: RecentSource = {
        accountId: "g",
        provider: "gmail",
        read: (_signal, memo) => {
          memos.push(memo.size);
          memo.set("id-1", mail("1", "x@one.example"));
          return Promise.resolve([mail("1", "x@one.example")]);
        },
      };
      const { service, clock } = rig([gmail]);
      await service.view();
      // Inside its time the memo is handed back as it was left.
      clock.t += RECENT_REFRESH_MIN_MS;
      const key = (await service.view(true)).rows[0]?.key ?? "";
      // The timer alone drops it: no look asked.
      clock.t += RECENT_TTL_MS;
      await vi.advanceTimersByTimeAsync(RECENT_TTL_MS);
      // The page still shows the row: a click on it works (perf review 2026-11-24 W2).
      expect(service.take(key)).toEqual({ accountId: "g", sender: "x@one.example" });
      await service.view();
      expect(memos).toEqual([0, 1, 0]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("drops a row that landed after its look returned RECENT_TTL_MS after it landed, not when the whole round ends", async () => {
    vi.useFakeTimers();
    try {
      const landing = Promise.withResolvers<readonly RecentMail[]>();
      const late = source("late", () => landing.promise);
      // Hold the round open past the TTL (13 rounds of RECENT_CONCURRENCY at RECENT_TIMEOUT_MS each): a timer armed only when the
      // round ends would come too late.
      const hung = Array.from({ length: 13 * RECENT_CONCURRENCY }, (_, i) =>
        source(`h${String(i)}`, () => new Promise<readonly RecentMail[]>(() => undefined)),
      );
      const { service, clock } = rig([late, ...hung]);
      const look = service.view();
      await vi.advanceTimersByTimeAsync(RECENT_LOOK_WAIT_MS);
      await look;
      landing.resolve([mail("1", "x@one.example")]);
      await vi.advanceTimersByTimeAsync(0);
      // The round is still open (the hung account): this look waits its RECENT_LOOK_WAIT_MS.
      const again = service.view();
      await vi.advanceTimersByTimeAsync(RECENT_LOOK_WAIT_MS);
      const key = (await again).rows[0]?.key ?? "";
      expect(key).not.toBe("");
      // Landed at T0 + RECENT_LOOK_WAIT_MS; the round ends at the hung read's deadline, long before.
      clock.t += RECENT_TTL_MS;
      await vi.advanceTimersByTimeAsync(RECENT_TTL_MS - RECENT_LOOK_WAIT_MS);
      // The round is still open (it ends at 13 deadlines), so this look reads nothing: the row is gone only if its own timer ran.
      const after = service.view();
      await vi.advanceTimersByTimeAsync(RECENT_LOOK_WAIT_MS);
      expect((await after).rows).toEqual([]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("names every account of the round as still reading, also one waiting for a worker", async () => {
    vi.useFakeTimers();
    try {
      const hung = Array.from({ length: RECENT_CONCURRENCY + 2 }, (_, i) =>
        source(`h${String(i)}`, () => new Promise<readonly RecentMail[]>(() => undefined)),
      );
      const look = rig(hung).service.view();
      await vi.advanceTimersByTimeAsync(RECENT_LOOK_WAIT_MS);
      const view = await look;
      expect(view.problems).toHaveLength(RECENT_CONCURRENCY + 2);
      expect(view.problems.every((p) => p.status === "reading")).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it("asks a not-connected account again at the next look, and a failed one after the Refresh floor", async () => {
    let connected = false;
    const off = source("off", () =>
      Promise.resolve(connected ? [mail("1", "x@one.example")] : null),
    );
    const bad = source("bad", () => Promise.reject(new Error("socket")));
    const { service, clock } = rig([off, bad]);
    await service.view();
    connected = true;
    clock.t += 1;
    const view = await service.view();
    expect(view.rows.map((r) => r.from)).toEqual(["x@one.example"]);
    expect(off.reads).toBe(2);
    expect(bad.reads).toBe(1);
    clock.t += RECENT_REFRESH_MIN_MS;
    await service.view();
    expect(bad.reads).toBe(2);
  });

  it("says Senderban is still starting, and asks nobody, until the accounts are set up", async () => {
    let starting = true;
    const a = source("a", () => Promise.resolve([mail("1", "x@one.example")]));
    const { service } = rig([a], { starting: () => starting });
    expect(await service.view()).toEqual({ starting: true, rows: [], problems: [] });
    expect(a.reads).toBe(0);
    starting = false;
    const view = await service.view();
    expect(view.starting).toBe(false);
    expect(view.rows).toHaveLength(1);
  });

  it("never says not notified of mail that came before this run: what was shown then is not known", async () => {
    const a = source("a", () =>
      Promise.resolve([mail("1", "before@x.example", T0 - 1), mail("2", "after@x.example", T0)]),
    );
    const { service } = rig([a], { startedAt: T0 });
    const marks = (await service.view()).rows.map((r) => [r.from, r.mark]);
    expect(marks).toEqual([
      ["after@x.example", "missed"],
      ["before@x.example", "none"],
    ]);
  });

  it("lets the keys go when the page closes, and a look gives new ones", async () => {
    const { service } = rig([source("a", () => Promise.resolve([mail("1", "x@one.example")]))]);
    const first = (await service.view()).rows[0]?.key ?? "";
    service.release();
    expect(service.take(first)).toBeNull();
    const second = (await service.view()).rows[0]?.key ?? "";
    expect(service.take(second)).toEqual({ accountId: "a", sender: "x@one.example" });
  });

  it("keeps no keys from a look that was still waiting when the page closed", async () => {
    const gate = Promise.withResolvers<readonly RecentMail[]>();
    const { service } = rig([source("a", () => gate.promise)]);
    const look = service.view();
    service.release();
    gate.resolve([mail("1", "x@one.example")]);
    const key = (await look).rows[0]?.key ?? "";
    expect(key).not.toBe("");
    expect(service.take(key)).toBeNull();
  });

  it("drops an account that is gone", async () => {
    const sources = [source("a", () => Promise.resolve([mail("1", "x@one.example")]))];
    const { service } = rig(sources);
    await service.view();
    sources.pop();
    expect((await service.view()).rows).toEqual([]);
  });
});

describe("Announcements", () => {
  it("keeps ANNOUNCED_PER_ACCOUNT lines per account, newest kept", () => {
    const a = new Announcements();
    a.record("a", "first@x.example", T0);
    for (let i = 0; i < ANNOUNCED_PER_ACCOUNT; i += 1) a.record("a", "other@x.example", T0);
    expect(a.since("a", "first@x.example", T0)).toBe(false);
    expect(a.since("a", "other@x.example", T0)).toBe(true);
  });

  it("drops a line older than MISSED_WINDOW_MS and the slack when the next one comes: an address held for nothing", () => {
    const a = new Announcements();
    a.record("a", "old@x.example", T0);
    a.record("a", "kept@x.example", T0 + 1);
    const later = T0 + MISSED_WINDOW_MS + CLOCK_SLACK_MS + 1;
    a.record("a", "new@x.example", later);
    // since() with a mail time far back still finds a kept line, and no longer the dropped one.
    expect(a.since("a", "old@x.example", T0)).toBe(false);
    expect(a.since("a", "kept@x.example", T0)).toBe(true);
    expect(a.since("a", "new@x.example", later)).toBe(true);
  });

  it("forgets an account", () => {
    const a = new Announcements();
    a.record("a", "x@x.example", T0);
    a.forget("a");
    expect(a.since("a", "x@x.example", T0)).toBe(false);
  });
});

describe("recentMarks", () => {
  // A real top-level domain: Outlook refuses a domain entry under a name that is no top-level domain (graphMatchReaches).
  const dot = (a: string, b: string): string => `${a}.${b}`;
  const wide = dot("fabrikam", "com");
  const entry = (match: BlockEntry["match"], value: string): BlockEntry => ({
    id: "00000000-0000-4000-8000-000000000001",
    match,
    value,
    action: "junk",
    createdAt: "2026-11-01T00:00:00.000Z",
  });
  const marks = (list: BlockEntry[], over: Partial<RecentMarkInputs> = {}) =>
    recentMarks({
      list,
      own: { domains: new Set(), addresses: new Set(["me@home.example"]) },
      quiet: (sender) => sender === "quiet@spam.example",
      provider: (id) => (id === "g" ? "gmail" : id === "m" ? "microsoft" : "imap"),
      applied: () => true,
      ...over,
    });

  it("marks a sender under a blocked domain blocked on an IMAP account", () => {
    expect(marks([entry("subdomains", "spam.example")])("i", "news@x.spam.example")).toBe(
      "blocked",
    );
  });

  it("does not mark a Gmail row blocked when only a domain entry covers it: Gmail holds single addresses", () => {
    const of = marks([
      entry("subdomains", "spam.example"),
      entry("exactAddress", "a@spam.example"),
    ]);
    expect(of("g", "news@spam.example")).toBeNull();
    expect(of("g", "a@spam.example")).toBe("blocked");
  });

  it("does not mark an Outlook row blocked under a domain Outlook refuses, and does under one it takes", () => {
    // Its text match would also reach the person's own home.example mail.
    expect(marks([entry("exactDomain", "x.home.example")])("m", "a@x.home.example")).toBeNull();
    expect(marks([entry("exactDomain", wide)])("m", `a@${wide}`)).toBe("blocked");
  });

  it("does not mark blocked on an account whose rules are not known to be in place", () => {
    const of = marks([entry("exactAddress", "a@spam.example")], { applied: (id) => id !== "i" });
    expect(of("i", "a@spam.example")).toBeNull();
    expect(of("j", "a@spam.example")).toBe("blocked");
  });

  it("falls back to muted, and names the person's own address first", () => {
    const of = marks([entry("exactAddress", "quiet@spam.example")], { applied: () => false });
    expect(of("i", "quiet@spam.example")).toBe("muted");
    expect(of("i", "me@home.example")).toBe("own");
  });

  it("keeps the Block button of a Gmail row a domain covers", async () => {
    const { service } = rig(
      [
        {
          accountId: "g",
          provider: "gmail",
          read: () => Promise.resolve([mail("1", "news@spam.example")]),
        },
      ],
      { marks: () => marks([entry("subdomains", "spam.example")]) },
    );
    const view = await service.view();
    expect(view.rows[0]?.mark).not.toBe("blocked");
    expect(service.take(view.rows[0]?.key ?? "")).toEqual({
      accountId: "g",
      sender: "news@spam.example",
    });
  });
});
