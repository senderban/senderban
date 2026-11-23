import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { BlockEntry, SyncOutcome, VerifyOutcome } from "@senderban/core";
import {
  FIRST_CHECK_MS,
  LEAK_CHECK_EVERY_MS,
  NEXT_CHECK_MS,
  REPAIR_EVERY_MS,
  RETRY_CHECK_MS,
  RULE_GRACE_MS,
  blockedArrival,
  createRuleChecks,
  screenBlocked,
} from "../src/rule-check.js";

const CREATED = "2026-01-05T10:00:00.000Z";
const created = Date.parse(CREATED);

describe("blockedArrival", () => {
  it.each([
    ["before the block, moved back ten hours later", created - 18_000, "earlier"],
    ["at the edge of the grace", created + RULE_GRACE_MS, "earlier"],
    ["just past it", created + RULE_GRACE_MS + 1, "leak"],
    ["the next day", created + 86_400_000, "leak"],
    ["with no usable delivery time", null, "leak"],
  ] as const)("a mail delivered %s", (_name, deliveredAt, expected) => {
    expect(blockedArrival({ createdAt: CREATED }, deliveredAt)).toBe(expected);
  });
});

describe("screenBlocked", () => {
  const entry: BlockEntry = {
    id: "entry-1",
    match: "exactDomain",
    value: "spam.example",
    action: "trash",
    createdAt: CREATED,
  };
  const screen = (covering: () => BlockEntry | null, deliveredAt: number | null) => {
    const leak = vi.fn();
    const log = vi.fn();
    const result = screenBlocked(
      { accountId: "a", uid: 7, domain: "spam.example", deliveredAt },
      { covering, leak, tagOf: (id) => `tag-${id}`, log },
    );
    return { result, leak, log };
  };

  it("announces a mail nobody blocked, with no line", () => {
    const t = screen(() => null, created);
    expect(t.result).toBe("announce");
    expect(t.leak).not.toHaveBeenCalled();
    expect(t.log).not.toHaveBeenCalled();
  });

  it("is silent about one older than its block, and only writes that down", () => {
    const t = screen(() => entry, created - 18_000);
    expect(t.result).toBe("silent");
    expect(t.leak).not.toHaveBeenCalled();
    expect(t.log).toHaveBeenCalledExactlyOnceWith("blocked-arrival", {
      account: "tag-a",
      uid: 7,
      domain: "spam.example",
      arrival: "earlier",
      match: "exactDomain",
      action: "trash",
      afterBlockS: -18,
    });
  });

  it.each([
    ["later", created + 86_400_000, 86_400],
    ["at no known time", null, null],
  ])("reports a leak and announces it (%s)", (_name, deliveredAt, afterBlockS) => {
    const t = screen(() => entry, deliveredAt);
    expect(t.result).toBe("announce");
    expect(t.leak).toHaveBeenCalledExactlyOnceWith("a", "entry-1");
    expect(t.log.mock.calls[0]?.[1]).toMatchObject({ arrival: "leak", afterBlockS });
  });

  it("announces the mail when the list cannot be read: never lost, and the log says why", () => {
    const t = screen(() => {
      throw new TypeError("row of me@own.example");
    }, created);
    expect(t.result).toBe("announce");
    expect(t.log).toHaveBeenCalledExactlyOnceWith("blocked-arrival", {
      account: "tag-a",
      uid: 7,
      result: "error",
      detail: "TypeError",
    });
  });
});

const verified = (id: string): VerifyOutcome => ({ accountId: id, status: "verified" });
const drifted = (id: string, ...failed: string[]): VerifyOutcome => ({
  accountId: id,
  status: "drifted",
  detail: "d",
  failed,
});
const unreachable = (id: string): VerifyOutcome => ({
  accountId: id,
  status: "failed",
  code: "TRANSIENT",
  message: "no",
});

function setup(
  answers: ((id: string) => VerifyOutcome | Promise<VerifyOutcome>)[],
  options: { accounts?: string[]; sync?: SyncOutcome["status"]; holds?: boolean } = {},
) {
  const queue = [...answers];
  const verify = vi.fn((id: string) => {
    const next = queue.length > 1 ? queue.shift() : queue[0];
    if (next === undefined) throw new Error("no answer");
    return Promise.resolve(next(id));
  });
  const reinstall = vi.fn((id: string): Promise<SyncOutcome> =>
    Promise.resolve(
      options.sync === "failed"
        ? { accountId: id, status: "failed", code: "REMOTE_CHANGED", message: "m" }
        : { accountId: id, status: "applied", applied: 1, failed: 0 },
    ),
  );
  const notice = vi.fn<(title: string, body: string) => void>();
  const log = vi.fn();
  const accounts = vi.fn(() => options.accounts ?? ["a"]);
  const hasWork = vi.fn<(id: string) => boolean>(() => true);
  const onResult = vi.fn<(id: string, running: boolean) => void>();
  const checks = createRuleChecks({
    accounts,
    hasWork,
    holds: () => options.holds ?? true,
    onResult,
    verify,
    reinstall,
    labelOf: (id) => `${id}@own.example`,
    tagOf: (id) => `tag-${id}`,
    notice,
    log,
    random: () => 0,
  });
  return { checks, verify, reinstall, notice, log, accounts, hasWork, onResult };
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(Date.UTC(2026, 10, 22, 12));
});
afterEach(() => {
  vi.useRealTimers();
});
const tick = (ms: number) => vi.advanceTimersByTimeAsync(ms);

describe("the scheduled read-back", () => {
  it("reads each account once, one after another, then again a day later", async () => {
    let open = 0;
    let most = 0;
    const t = setup(
      [
        async (id) => {
          open += 1;
          most = Math.max(most, open);
          await new Promise((resolve) => setTimeout(resolve, 10));
          open -= 1;
          return verified(id);
        },
      ],
      { accounts: ["a", "b", "c"] },
    );
    t.checks.start();
    await tick(FIRST_CHECK_MS.min - 1);
    expect(t.verify).not.toHaveBeenCalled();
    await tick(1_000);
    expect(t.verify.mock.calls.map((c) => c[0])).toEqual(["a", "b", "c"]);
    expect(most).toBe(1);
    expect(t.notice).not.toHaveBeenCalled();
    await tick(NEXT_CHECK_MS.min);
    expect(t.verify).toHaveBeenCalledTimes(6);
    t.checks.stop();
    expect(vi.getTimerCount()).toBe(0);
    await tick(NEXT_CHECK_MS.max * 2);
    expect(t.verify).toHaveBeenCalledTimes(6);
  });

  it("goes on after a round that threw, and after one with nothing to read (paused)", async () => {
    const t = setup([verified]);
    t.accounts.mockImplementationOnce(() => {
      throw new Error("no");
    });
    t.accounts.mockImplementationOnce(() => []);
    t.checks.start();
    await tick(FIRST_CHECK_MS.min);
    await tick(NEXT_CHECK_MS.min);
    expect(t.verify).not.toHaveBeenCalled();
    await tick(NEXT_CHECK_MS.min);
    expect(t.verify).toHaveBeenCalledTimes(1);
    t.checks.stop();
  });

  it("switches the rules back on when another script runs instead, reads that back, and says so", async () => {
    const t = setup([(id) => drifted(id, "include-active"), verified]);
    t.checks.start();
    await tick(FIRST_CHECK_MS.min);
    expect(t.reinstall).toHaveBeenCalledExactlyOnceWith("a");
    expect(t.notice).toHaveBeenCalledTimes(1);
    expect(t.notice.mock.calls[0]?.[1]).toContain("They are on again");
    expect(t.log).toHaveBeenCalledWith("rule-repair", {
      account: "tag-a",
      sync: "applied",
      result: "verified",
    });
    t.checks.stop();
  });

  it("does not fight: a second time within the limit it only tells", async () => {
    const t = setup([
      (id) => drifted(id, "include-active"),
      verified,
      (id) => drifted(id, "include-active"),
    ]);
    t.checks.start();
    await tick(FIRST_CHECK_MS.min);
    await tick(LEAK_CHECK_EVERY_MS);
    t.checks.leak("a", "entry-1");
    await tick(0);
    expect(t.reinstall).toHaveBeenCalledTimes(1);
    expect(t.notice.mock.calls.at(-1)?.[0]).toBe("Some blocks are not working");
    await tick(NEXT_CHECK_MS.min);
    expect(t.reinstall).toHaveBeenCalledTimes(2);
    expect(REPAIR_EVERY_MS).toBeLessThan(NEXT_CHECK_MS.min);
    t.checks.stop();
  });

  it.each([
    ["edited", ["rules-unchanged"]],
    ["deleted", ["rules-present", "include-active"]],
    ["edited and switched off", ["rules-unchanged", "include-active"]],
    ["switched off with nothing else on", ["none-active"]],
    ["taken out of the main script", ["main-edited"]],
    ["taken out of the person's own script", ["include-removed"]],
    ["behind a script nobody can read", ["active-unreadable"]],
    ["a check it does not know", ["something-new"]],
  ])("never writes over rules that were %s: it tells the person", async (_name, failed) => {
    const t = setup([(id) => drifted(id, ...failed)]);
    t.checks.start();
    await tick(FIRST_CHECK_MS.min);
    expect(t.reinstall).not.toHaveBeenCalled();
    expect(t.notice.mock.calls).toEqual([
      ["Some blocks are not working", expect.stringContaining("a@own.example: ")],
    ]);
    expect(t.onResult.mock.calls).toEqual([["a", false]]);
    t.checks.stop();
  });

  it.each([
    [["include-removed"], true],
    [["main-edited"], true],
    [["rules-unchanged", "include-removed"], false],
    [["none-active"], false],
  ])("says that a block puts the rules back only when it does (%s)", async (failed, says) => {
    const t = setup([(id) => drifted(id, ...failed)]);
    t.checks.start();
    await tick(FIRST_CHECK_MS.min);
    expect(t.notice.mock.calls[0]?.[1].includes("the next block puts them back")).toBe(says);
    t.checks.stop();
  });

  it("does not claim a repair that the server refused or that did not hold", async () => {
    for (const t of [
      setup([(id) => drifted(id, "include-active")], { sync: "failed" }),
      setup([(id) => drifted(id, "include-active")]),
    ]) {
      t.checks.start();
      await tick(FIRST_CHECK_MS.min);
      expect(t.notice.mock.calls.map((c) => c[0])).toEqual(["Some blocks are not working"]);
      t.checks.stop();
    }
  });

  it("says nothing when a server cannot be reached: that is not news about the rules", async () => {
    const t = setup([unreachable]);
    t.checks.start();
    await tick(FIRST_CHECK_MS.min);
    expect(t.notice).not.toHaveBeenCalled();
    expect(t.log).toHaveBeenCalledWith("rule-check", {
      account: "tag-a",
      why: "scheduled",
      result: "failed",
      code: "TRANSIENT",
    });
    t.checks.stop();
  });
});

describe("what the list may say", () => {
  it("is told after a read-back that held, a repair that held, and one that did not", async () => {
    for (const [answers, sync, expected] of [
      [[verified], "applied", [["a", true]]],
      [[(id: string) => drifted(id, "include-active"), verified], "applied", [["a", true]]],
      [[(id: string) => drifted(id, "include-active")], "failed", [["a", false]]],
      [[unreachable], "applied", []],
    ] as const) {
      const t = setup([...answers], { sync });
      t.checks.start();
      await tick(FIRST_CHECK_MS.min);
      expect(t.onResult.mock.calls).toEqual(expected);
      t.checks.stop();
    }
  });
});

describe("which accounts are read", () => {
  it("passes over one with nothing to do, and one whose state cannot be read costs only itself", async () => {
    const t = setup([verified], { accounts: ["empty", "bad", "a"] });
    t.hasWork.mockImplementation((id) => {
      if (id === "bad") throw new Error("state failed");
      return id !== "empty";
    });
    t.checks.start();
    await tick(FIRST_CHECK_MS.min);
    expect(t.verify.mock.calls.map((c) => c[0])).toEqual(["a"]);
    expect(t.log).toHaveBeenCalledWith("rule-check", {
      account: "tag-bad",
      why: "scheduled",
      result: "error",
      detail: "Error",
    });
    t.checks.stop();
  });

  it("drops the answer about one that a removal took hold of meanwhile", async () => {
    const t = setup([(id) => drifted(id, "include-active")]);
    t.accounts.mockReturnValueOnce(["a"]).mockReturnValueOnce(["a"]).mockReturnValue([]);
    t.checks.start();
    await tick(FIRST_CHECK_MS.min);
    expect(t.verify).toHaveBeenCalledTimes(1);
    expect(t.reinstall).not.toHaveBeenCalled();
    expect(t.notice).not.toHaveBeenCalled();
    t.checks.leak("a", "entry-1");
    await tick(0);
    expect(t.verify).toHaveBeenCalledTimes(1);
    t.checks.stop();
  });

  it("asks one whose server could not be reached once more the same hour, then the next day", async () => {
    const t = setup([unreachable], { accounts: ["a", "b"] });
    t.verify.mockImplementation((id) =>
      Promise.resolve(id === "a" ? unreachable(id) : verified(id)),
    );
    t.checks.start();
    await tick(FIRST_CHECK_MS.min);
    expect(t.verify.mock.calls.map((c) => c[0])).toEqual(["a", "b"]);
    await tick(RETRY_CHECK_MS.min);
    expect(t.verify.mock.calls.map((c) => c[0])).toEqual(["a", "b", "a"]);
    await tick(NEXT_CHECK_MS.min - 1);
    expect(t.verify).toHaveBeenCalledTimes(3);
    await tick(1);
    expect(t.verify).toHaveBeenCalledTimes(5);
    t.checks.stop();
  });

  it("does not ask a refused sign-in once more", async () => {
    const t = setup([
      (id) => ({ accountId: id, status: "failed", code: "AUTH_REQUIRED", message: "no" }),
    ]);
    t.checks.start();
    await tick(FIRST_CHECK_MS.min);
    await tick(RETRY_CHECK_MS.max);
    expect(t.verify).toHaveBeenCalledTimes(1);
    t.checks.stop();
  });

  it("a pause does not forget when it last repaired", async () => {
    const t = setup([
      (id) => drifted(id, "include-active"),
      verified,
      (id) => drifted(id, "include-active"),
    ]);
    t.checks.start();
    await tick(FIRST_CHECK_MS.min);
    expect(t.reinstall).toHaveBeenCalledTimes(1);
    vi.setSystemTime(Date.now() - NEXT_CHECK_MS.min + LEAK_CHECK_EVERY_MS);
    t.accounts.mockReturnValueOnce([]);
    await tick(NEXT_CHECK_MS.min);
    t.checks.leak("a", "entry-1");
    await tick(0);
    expect(t.verify).toHaveBeenCalledTimes(3);
    expect(t.reinstall).toHaveBeenCalledTimes(1);
    t.checks.stop();
  });
});

describe("a leak", () => {
  it.each([
    ["the rules read back clean", verified],
    ["nothing was ever written there", null],
  ])("does not claim a rule that was never written (%s)", async (_name, answer) => {
    const t = setup([answer ?? verified], { holds: false });
    if (answer === null) t.hasWork.mockReturnValue(false);
    t.checks.start();
    t.checks.leak("a", "entry-1");
    await tick(0);
    expect(t.verify).toHaveBeenCalledTimes(answer === null ? 0 : 1);
    expect(t.notice.mock.calls[0]?.[1]).toContain("The block is not on that mail server yet");
    t.checks.stop();
  });

  it("is answered by a read-back already under way for that account", async () => {
    let answer: (value: VerifyOutcome) => void = () => undefined;
    const t = setup([
      () =>
        new Promise<VerifyOutcome>((resolve) => {
          answer = resolve;
        }),
    ]);
    t.checks.start();
    await tick(FIRST_CHECK_MS.min);
    expect(t.verify).toHaveBeenCalledTimes(1);
    t.checks.leak("a", "entry-1");
    answer(verified("a"));
    await tick(0);
    expect(t.verify).toHaveBeenCalledTimes(1);
    expect(t.notice).toHaveBeenCalledTimes(1);
    expect(t.notice.mock.calls[0]?.[1]).toContain("The rule is on the mail server");
    // Answered once: the next scheduled read-back says nothing.
    await tick(NEXT_CHECK_MS.min);
    answer(verified("a"));
    await tick(0);
    expect(t.verify).toHaveBeenCalledTimes(2);
    expect(t.notice).toHaveBeenCalledTimes(1);
    t.checks.stop();
  });

  it("50 at once wait in one line: one read-back at a time", async () => {
    const accounts = Array.from({ length: 50 }, (_, i) => `acct-${String(i)}`);
    let open = 0;
    let most = 0;
    const t = setup(
      [
        async (id) => {
          open += 1;
          most = Math.max(most, open);
          await new Promise((resolve) => setTimeout(resolve, 10));
          open -= 1;
          return verified(id);
        },
      ],
      { accounts },
    );
    t.checks.start();
    for (const id of accounts) t.checks.leak(id, "entry-1");
    await tick(1_000);
    expect(t.verify).toHaveBeenCalledTimes(50);
    expect(most).toBe(1);
    t.checks.stop();
  });

  it("reads the rules back at once and tells the person they are in place", async () => {
    const t = setup([verified]);
    t.checks.start();
    t.checks.leak("a", "entry-1");
    await tick(0);
    expect(t.verify).toHaveBeenCalledTimes(1);
    expect(t.notice.mock.calls[0]?.[1]).toContain("The rule is on the mail server");
    t.checks.stop();
  });

  it("starts one read-back an hour per account, whatever comes in", async () => {
    const t = setup([verified]);
    t.checks.start();
    t.accounts.mockReturnValue(["a", "b"]);
    for (let i = 0; i < 20; i += 1) t.checks.leak("a", "entry-1");
    t.checks.leak("b", "entry-1");
    await tick(0);
    expect(t.verify.mock.calls.map((c) => c[0])).toEqual(["a", "b"]);
    // The first read-back is done: it is the hour that holds the next one back, not the one in flight.
    t.checks.leak("a", "entry-1");
    await tick(0);
    expect(t.verify).toHaveBeenCalledTimes(2);
    await tick(FIRST_CHECK_MS.min - 1);
    vi.setSystemTime(Date.now() + LEAK_CHECK_EVERY_MS);
    t.checks.leak("a", "entry-1");
    await tick(0);
    expect(t.verify).toHaveBeenCalledTimes(3);
    t.checks.stop();
  });

  it("does nothing after stop, also when the answer comes later", async () => {
    let answer: (value: VerifyOutcome) => void = () => undefined;
    const t = setup([
      () =>
        new Promise<VerifyOutcome>((resolve) => {
          answer = resolve;
        }),
    ]);
    t.checks.start();
    t.checks.leak("a", "entry-1");
    await tick(0);
    t.checks.stop();
    answer(drifted("a", "include-active"));
    await tick(0);
    expect(t.reinstall).not.toHaveBeenCalled();
    expect(t.notice).not.toHaveBeenCalled();
    t.checks.leak("b", "entry-1");
    expect(t.verify).toHaveBeenCalledTimes(1);
  });

  it.each([["a", "b"], ["a"]])(
    "a stop in the middle of a scheduled round leaves no timer and asks no further account (%s)",
    async (...accounts) => {
      let answer: (value: VerifyOutcome) => void = () => undefined;
      const t = setup(
        [
          () =>
            new Promise<VerifyOutcome>((resolve) => {
              answer = resolve;
            }),
        ],
        { accounts },
      );
      t.checks.start();
      await tick(FIRST_CHECK_MS.min);
      t.checks.stop();
      answer(verified("a"));
      await tick(0);
      expect(t.verify).toHaveBeenCalledTimes(1);
      expect(vi.getTimerCount()).toBe(0);
    },
  );

  it("outlives a read-back that throws", async () => {
    const t = setup([
      () => {
        throw new Error("boom me@own.example");
      },
    ]);
    t.checks.start();
    t.checks.leak("a", "entry-1");
    await tick(0);
    expect(t.log).toHaveBeenCalledWith("rule-check", {
      account: "tag-a",
      why: "leak",
      result: "error",
      detail: "Error",
    });
    t.checks.stop();
  });
});
