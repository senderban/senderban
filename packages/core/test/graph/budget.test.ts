import { describe, expect, it, vi } from "vitest";
import {
  GRAPH_POLL_REQUESTS_PER_ACCOUNT_DAY,
  GRAPH_POLL_REQUESTS_PER_DAY_ALL,
  GRAPH_REQUESTS_PER_ACCOUNT_DAY,
  GRAPH_REQUESTS_PER_MINUTE,
  GraphBudgetError,
  GraphBudgets,
} from "../../src/graph/budget.js";
import { GRAPH_MAX_RULES } from "../../src/graph/adapter.js";
import { MAX_ACCOUNTS } from "../../src/sync/engine.js";

const limits = { perMinute: 2, perAccountDay: 3, allAccountsDay: 4 };

describe("GraphBudgets", () => {
  it("has room for the largest uninstall in one minute", () => {
    expect(GRAPH_MAX_RULES + 1).toBeLessThanOrEqual(GRAPH_REQUESTS_PER_MINUTE);
    expect(GRAPH_REQUESTS_PER_MINUTE * 10).toBeLessThan(10_000);
    expect(GRAPH_REQUESTS_PER_ACCOUNT_DAY).toBeGreaterThan(GRAPH_MAX_RULES);
  });

  it("stops at the minute line and opens again after it", () => {
    let t = 0;
    const budgets = new GraphBudgets({ limits, now: () => t });
    budgets.charge("a");
    budgets.charge("a");
    expect(() => {
      budgets.charge("a");
    }).toThrow(GraphBudgetError);
    t = 62_000;
    budgets.charge("a");
    expect(() => {
      t = 124_000;
      budgets.charge("a");
    }).toThrow(/account-day/u);
  });

  it("holds one account apart from the others, and all of them under one ceiling", () => {
    let t = 0;
    const budgets = new GraphBudgets({ limits, now: () => t });
    budgets.charge("a");
    budgets.charge("a");
    t = 62_000;
    budgets.charge("b");
    budgets.charge("b");
    expect(() => {
      t = 124_000;
      budgets.charge("c");
    }).toThrow(/all-accounts-day/u);
  });

  it("has room for a poll a minute on every account, at the fastest gap", () => {
    const fastest = (24 * 60 * 60) / 50;
    expect(fastest).toBeLessThan(GRAPH_POLL_REQUESTS_PER_ACCOUNT_DAY);
    expect(GRAPH_POLL_REQUESTS_PER_ACCOUNT_DAY * MAX_ACCOUNTS).toBeLessThanOrEqual(
      GRAPH_POLL_REQUESTS_PER_DAY_ALL,
    );
  });

  it("keeps polls off the rule lines, and rules off the poll lines", () => {
    const budgets = new GraphBudgets({
      limits: { perMinute: 100, perAccountDay: 2, allAccountsDay: 100 },
      pollLimits: { perAccountDay: 2, allAccountsDay: 100 },
      now: () => 0,
    });
    budgets.chargePoll("a");
    budgets.chargePoll("a");
    expect(() => {
      budgets.chargePoll("a");
    }).toThrow(/poll-account-day/u);
    budgets.charge("a");
    budgets.charge("a");
    expect(() => {
      budgets.charge("a");
    }).toThrow(/\(account-day\)/u);
  });

  it("shares the minute line between polls and rules", () => {
    const budgets = new GraphBudgets({
      limits: { perMinute: 1, perAccountDay: 100, allAccountsDay: 100 },
      now: () => 0,
    });
    budgets.chargePoll("a");
    expect(() => {
      budgets.charge("a");
    }).toThrow(/minute/u);
  });

  it("holds all accounts' polls under one ceiling", () => {
    const budgets = new GraphBudgets({
      pollLimits: { perAccountDay: 100, allAccountsDay: 1 },
      now: () => 0,
    });
    budgets.chargePoll("a");
    expect(() => {
      budgets.chargePoll("b");
    }).toThrow(/poll-all-accounts-day/u);
  });

  it("pays a poll before it leaves, and logs a refusal in fixed words", async () => {
    const events: unknown[] = [];
    const delta = vi.fn(() =>
      Promise.resolve({ mail: [], unreadable: 0, link: "https://x.example/", more: false }),
    );
    const budgets = new GraphBudgets({
      pollLimits: { perAccountDay: 1, allAccountsDay: 100 },
      now: () => 0,
    });
    const client = budgets.wrapMail(
      { delta },
      { key: "a", account: "tag", log: (e) => void events.push(e) },
    );
    await client.delta({ sinceMs: 0 });
    await expect(client.delta({ sinceMs: 0 })).rejects.toBeInstanceOf(GraphBudgetError);
    expect(delta).toHaveBeenCalledTimes(1);
    expect(events).toEqual([
      {
        event: "graph-budget",
        account: "tag",
        op: "delta",
        limit: "poll-account-day",
        used: 1,
        cap: 1,
      },
    ]);
  });

  it("takes all windows or none", () => {
    const budgets = new GraphBudgets({ limits, now: () => 0 });
    budgets.charge("a");
    budgets.charge("a");
    expect(() => {
      budgets.charge("a");
    }).toThrow(GraphBudgetError);
    // The refused call was not paid on the shared line.
    budgets.charge("b");
    budgets.charge("b");
  });

  it("is bounded by the account count, and a removed account frees its place", () => {
    const budgets = new GraphBudgets({ now: () => 0 });
    for (let i = 0; i < MAX_ACCOUNTS; i += 1) budgets.charge(`a${String(i)}`);
    expect(() => {
      budgets.charge("one-more");
    }).toThrow("too many");
    budgets.forget("a0");
    budgets.charge("one-more");
  });
});
