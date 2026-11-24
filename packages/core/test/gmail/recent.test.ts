import { describe, expect, it } from "vitest";
import {
  GMAIL_LIMITS,
  GMAIL_MAIL_UNITS,
  GMAIL_RECENT_UNITS_PER_ACCOUNT_DAY,
  GMAIL_RECENT_UNITS_PER_DAY_ALL,
  GMAIL_UNITS_PER_MINUTE,
  GmailBudgetError,
  GmailBudgets,
} from "../../src/gmail/budget.js";
import type { GmailLogEvent } from "../../src/gmail/budget.js";
import {
  GMAIL_USER_URL,
  INBOX_FIELDS,
  createGmailMailClient,
} from "../../src/gmail/mail-client.js";
import { MAX_ACCOUNTS } from "../../src/sync/engine.js";
import { RECENT_MAX } from "../../src/watcher/watcher.js";
import { FakeGmail, MAIL_UNITS } from "./fake-gmail.js";

function setup(fake = new FakeGmail()) {
  const client = createGmailMailClient({
    getAccessToken: () => Promise.resolve(fake.token),
    fetch: fake.fetch,
  });
  return { fake, client };
}

describe("Gmail inbox list (Recent mail)", () => {
  it("asks for the Inbox by label, never with q, cut to ids, and charges 5 units", async () => {
    const { fake, client } = setup();
    fake.deliver({ from: "a@x.example" });
    await client.inbox(RECENT_MAX);
    const url = new URL(fake.calls[0]?.url ?? "");
    expect(url.origin + url.pathname).toBe(`${GMAIL_USER_URL}/messages`);
    expect(Object.fromEntries(url.searchParams)).toEqual({
      labelIds: "INBOX",
      maxResults: String(RECENT_MAX),
      fields: INBOX_FIELDS,
      prettyPrint: "false",
    });
    expect(fake.mailUnits).toBe(MAIL_UNITS.inbox);
  });

  it("hands back the newest Inbox ids, leaving out mail outside the Inbox", async () => {
    const { fake, client } = setup();
    const first = fake.deliver({ from: "a@x.example" });
    fake.deliver({ from: "b@x.example", labels: ["SENT"] });
    const third = fake.deliver({ from: "c@x.example" });
    expect(await client.inbox(RECENT_MAX)).toEqual([third, first]);
  });

  it("answers an empty Inbox with no ids", async () => {
    const { client } = setup();
    expect(await client.inbox(1)).toEqual([]);
  });

  it("keeps only what was asked for, once each, and skips an odd id", async () => {
    const { fake, client } = setup();
    fake.forced.push({
      status: 200,
      body: {
        messages: [{ id: "aaa" }, { id: "aaa" }, { id: "bad id!" }, { id: "bbb" }, { id: "ccc" }],
      },
    });
    expect(await client.inbox(2)).toEqual(["aaa", "bbb"]);
  });

  it("refuses a count outside 1 to RECENT_MAX before asking", async () => {
    const { fake, client } = setup();
    for (const max of [0, RECENT_MAX + 1, 2.5]) {
      await expect(client.inbox(max)).rejects.toThrow(RangeError);
    }
    expect(fake.calls).toHaveLength(0);
  });

  it("treats a wrong shape as malformed and a refusal as a failure", async () => {
    const { fake, client } = setup();
    fake.forced.push({ status: 200, body: { messages: "nope" } });
    await expect(client.inbox(1)).rejects.toThrow(/malformed/u);
    fake.forced.push(403);
    await expect(client.inbox(1)).rejects.toThrow();
  });

  it("reads when Gmail received the message, and nothing it cannot trust", async () => {
    const { fake, client } = setup();
    const id = fake.deliver({ from: "a@x.example" });
    const message = await client.message(id);
    expect(message !== "gone" && message.receivedMs).toBe(fake.mail.get(id)?.receivedMs);
    for (const internalDate of ["abc", "99999999999999999", "0", 5, null]) {
      fake.forced.push({ status: 200, body: { id, internalDate, payload: { headers: [] } } });
      const odd = await client.message(id);
      expect(odd !== "gone" && odd.receivedMs).toBeNull();
    }
  });
});

describe("the Recent mail lane", () => {
  it("is named, and its first look fits the minute line many times over", () => {
    const firstLook = GMAIL_MAIL_UNITS.inbox + RECENT_MAX * GMAIL_MAIL_UNITS.message;
    expect(firstLook).toBe(205);
    expect(GMAIL_RECENT_UNITS_PER_ACCOUNT_DAY).toBe(firstLook * 10);
    expect(firstLook * 5).toBeLessThanOrEqual(GMAIL_UNITS_PER_MINUTE);
    // One runaway account stops at its own line; the ceiling is for a bug on every account.
    expect(GMAIL_RECENT_UNITS_PER_DAY_ALL).toBeLessThan(
      MAX_ACCOUNTS * GMAIL_RECENT_UNITS_PER_ACCOUNT_DAY,
    );
    expect(GMAIL_LIMITS.recentPerAccountDay).toBe(GMAIL_RECENT_UNITS_PER_ACCOUNT_DAY);
  });

  it("pays its own 24-hour line, so looking at the view leaves the reading of new mail alone", async () => {
    const budgets = new GmailBudgets();
    const fake = new FakeGmail();
    const options = { getAccessToken: () => Promise.resolve(fake.token), fetch: fake.fetch };
    const events: GmailLogEvent[] = [];
    const recent = budgets.wrapRecent(createGmailMailClient(options), {
      key: "k",
      account: "acct-k",
      log: (e) => events.push(e),
    });
    const id = fake.deliver({ from: "a@x.example" });
    await recent.inbox(RECENT_MAX);
    await recent.message(id);
    expect(budgets.remainingRecent("k").accountDay).toBe(
      GMAIL_RECENT_UNITS_PER_ACCOUNT_DAY - GMAIL_MAIL_UNITS.inbox - GMAIL_MAIL_UNITS.message,
    );
    expect(budgets.remainingRead("k").accountDay).toBe(GMAIL_LIMITS.readPerAccountDay);
    expect(events.map((e) => e.event === "gmail-call" && e.op)).toEqual(["inbox", "message"]);
  });

  it("stops at its own line with no request sent", async () => {
    const budgets = new GmailBudgets({
      limits: { ...GMAIL_LIMITS, recentPerAccountDay: GMAIL_MAIL_UNITS.inbox },
    });
    const fake = new FakeGmail();
    const recent = budgets.wrapRecent(
      createGmailMailClient({
        getAccessToken: () => Promise.resolve(fake.token),
        fetch: fake.fetch,
      }),
      { key: "k", account: "acct-k" },
    );
    await recent.inbox(1);
    const id = fake.deliver({ from: "a@x.example" });
    const sent = fake.calls.length;
    await expect(recent.message(id)).rejects.toBeInstanceOf(GmailBudgetError);
    await expect(recent.message(id)).rejects.toMatchObject({ limit: "recent-account-day" });
    expect(fake.calls).toHaveLength(sent);
  });

  it("refuses a limit that is not a whole number of units", () => {
    for (const bad of [0, -1, 1.5, Number.NaN]) {
      expect(
        () => new GmailBudgets({ limits: { ...GMAIL_LIMITS, recentAllAccountsDay: bad } }),
      ).toThrow(RangeError);
    }
  });
});
