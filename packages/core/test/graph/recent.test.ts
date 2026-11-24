import { describe, expect, it } from "vitest";
import {
  GRAPH_RECENT_LIMITS,
  GRAPH_RECENT_REQUESTS_PER_ACCOUNT_DAY,
  GRAPH_RECENT_REQUESTS_PER_DAY_ALL,
  GraphBudgetError,
  GraphBudgets,
} from "../../src/graph/budget.js";
import type { GraphBudgetEvent } from "../../src/graph/budget.js";
import { GRAPH_INBOX_URL, createGraphClient } from "../../src/graph/client.js";
import type { GraphRecentClient } from "../../src/graph/client.js";
import { MAX_ACCOUNTS } from "../../src/sync/engine.js";
import { RECENT_MAX } from "../../src/watcher/watcher.js";

interface Answer {
  readonly status?: number;
  readonly body?: unknown;
}

function rig(answers: Answer[]) {
  const urls: string[] = [];
  const client = createGraphClient({
    getAccessToken: () => Promise.resolve("access-token"),
    fetch: ((url: string) => {
      urls.push(url);
      const answer = answers.shift() ?? { body: { value: [] } };
      const text = typeof answer.body === "string" ? answer.body : JSON.stringify(answer.body);
      return Promise.resolve(new Response(text, { status: answer.status ?? 200 }));
    }) as unknown as typeof fetch,
  });
  return { client, urls };
}

const mail = (over: Record<string, unknown> = {}) => ({
  id: "AAMkAD=",
  receivedDateTime: "2026-11-23T12:00:05Z",
  subject: "WIN NOW",
  from: { emailAddress: { name: "Spam Co", address: "Spam@News.Example.com" } },
  ...over,
});

describe("Graph recent()", () => {
  it("asks the Inbox for the newest three fields only: no body, one request", async () => {
    const { client, urls } = rig([{ body: { value: [] } }]);
    await client.recent(RECENT_MAX);
    expect(urls).toEqual([
      `${GRAPH_INBOX_URL}?$top=${String(RECENT_MAX)}&$select=from,subject,receivedDateTime&$orderby=receivedDateTime+desc`,
    ]);
  });

  it("reads sender, subject and time, newest first, and counts what it cannot read", async () => {
    const { client } = rig([
      {
        body: {
          value: [
            mail({ id: "old", receivedDateTime: "2026-11-23T10:00:00Z" }),
            mail({ id: "new", receivedDateTime: "2026-11-23T11:00:00Z", subject: "a‮b" }),
            mail({ id: "odd", receivedDateTime: "not a time" }),
            mail({ id: "nobody", from: { emailAddress: { address: "not an address" } } }),
            { nope: true },
          ],
        },
      },
    ]);
    const page = await client.recent(RECENT_MAX);
    expect(page.unreadable).toBe(2);
    expect(page.mail.map((m) => m.id)).toEqual(["nobody", "new", "old"]);
    expect(page.mail[1]).toEqual({
      id: "new",
      from: "spam@news.example.com",
      subject: "a b",
      receivedMs: Date.UTC(2026, 10, 23, 11),
    });
    // A sender that cannot be matched stays, with nothing to click.
    expect(page.mail[0]?.from).toBeNull();
  });

  it("keeps only what was asked for", async () => {
    const value = Array.from({ length: 5 }, (_, i) =>
      mail({ id: `m${String(i)}`, receivedDateTime: `2026-11-23T1${String(i)}:00:00Z` }),
    );
    const { client } = rig([{ body: { value } }]);
    expect((await client.recent(2)).mail.map((m) => m.id)).toEqual(["m4", "m3"]);
  });

  it("refuses a count outside 1 to RECENT_MAX before asking", async () => {
    const { client, urls } = rig([]);
    for (const max of [0, RECENT_MAX + 1, 1.5]) {
      await expect(client.recent(max)).rejects.toThrow(RangeError);
    }
    expect(urls).toEqual([]);
  });

  it("treats a wrong shape as malformed and a refusal as a failure", async () => {
    const { client } = rig([
      { body: { value: "x" } },
      { status: 403, body: { error: { code: "ErrorAccessDenied" } } },
    ]);
    await expect(client.recent(1)).rejects.toThrow(/malformed/u);
    await expect(client.recent(1)).rejects.toThrow();
  });
});

describe("the Recent mail lane of the Microsoft budget", () => {
  const fake = (): GraphRecentClient & { calls: number } => {
    const state = {
      calls: 0,
      recent: () => {
        state.calls += 1;
        return Promise.resolve({ mail: [], unreadable: 0 });
      },
    };
    return state;
  };

  it("is named, and one runaway account stops before the ceiling", () => {
    expect(GRAPH_RECENT_LIMITS).toEqual({
      perAccountDay: GRAPH_RECENT_REQUESTS_PER_ACCOUNT_DAY,
      allAccountsDay: GRAPH_RECENT_REQUESTS_PER_DAY_ALL,
    });
    expect(GRAPH_RECENT_REQUESTS_PER_DAY_ALL).toBe(
      MAX_ACCOUNTS * GRAPH_RECENT_REQUESTS_PER_ACCOUNT_DAY,
    );
  });

  it("pays its own day line and leaves the poll's alone", async () => {
    const budgets = new GraphBudgets();
    const inner = fake();
    const reader = budgets.wrapRecent(inner, { key: "k", account: "acct-k" });
    await reader.recent(RECENT_MAX);
    expect(inner.calls).toBe(1);
    expect(budgets.remainingRecent("k").accountDay).toBe(GRAPH_RECENT_REQUESTS_PER_ACCOUNT_DAY - 1);
  });

  it("stops at its own line with no request sent, and logs the refusal", async () => {
    const events: GraphBudgetEvent[] = [];
    const budgets = new GraphBudgets({ recentLimits: { perAccountDay: 1, allAccountsDay: 10 } });
    const inner = fake();
    const reader = budgets.wrapRecent(inner, {
      key: "k",
      account: "acct-k",
      log: (e) => events.push(e),
    });
    await reader.recent(1);
    await expect(reader.recent(1)).rejects.toBeInstanceOf(GraphBudgetError);
    expect(inner.calls).toBe(1);
    expect(events).toMatchObject([
      { event: "graph-budget", op: "recent", limit: "recent-account-day" },
    ]);
  });

  it("refuses a limit that is not a whole number of requests", () => {
    for (const bad of [0, -1, 1.5, Number.NaN]) {
      expect(
        () => new GraphBudgets({ recentLimits: { perAccountDay: bad, allAccountsDay: 1 } }),
      ).toThrow(RangeError);
    }
  });
});
