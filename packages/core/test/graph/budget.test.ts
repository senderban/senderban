import { describe, expect, it } from "vitest";
import {
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
