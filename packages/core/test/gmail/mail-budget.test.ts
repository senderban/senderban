import { describe, expect, it } from "vitest";
import {
  GMAIL_LIMITS,
  GMAIL_MAIL_UNITS,
  GMAIL_POLL_UNITS_PER_ACCOUNT_DAY,
  GMAIL_POLL_UNITS_PER_DAY_ALL,
  GMAIL_READ_UNITS_PER_ACCOUNT_DAY,
  GMAIL_READ_UNITS_PER_DAY_ALL,
  GMAIL_UNITS_PER_MINUTE,
  GmailBudgetError,
  GmailBudgets,
} from "../../src/gmail/budget.js";
import type { GmailLimits, GmailLogEvent } from "../../src/gmail/budget.js";
import { createGmailClient } from "../../src/gmail/client.js";
import { createGmailMailClient } from "../../src/gmail/mail-client.js";
import { MAX_ACCOUNTS } from "../../src/sync/engine.js";
import { FakeGmail, MAIL_UNITS } from "./fake-gmail.js";

const SECOND = 1_000;
const MINUTE = 60 * SECOND;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

const limits = (over: Partial<GmailLimits> = {}): GmailLimits => ({ ...GMAIL_LIMITS, ...over });

function clock(start = Date.UTC(2026, 9, 27, 12, 0, 0)) {
  const state = { t: start };
  return { now: () => state.t, advance: (ms: number) => (state.t += ms) };
}

function wiredMail(budgets: GmailBudgets, key: string, fake = new FakeGmail()) {
  const events: GmailLogEvent[] = [];
  const options = { getAccessToken: () => Promise.resolve(fake.token), fetch: fake.fetch };
  const mail = budgets.wrapMail(createGmailMailClient(options), {
    key,
    account: `acct-${key}`,
    log: (e) => events.push(e),
  });
  const filters = budgets.wrap(createGmailClient(options), { key, account: `acct-${key}` });
  return { fake, mail, filters, events };
}

async function refusal(promise: Promise<unknown>): Promise<GmailBudgetError | null> {
  try {
    await promise;
    return null;
  } catch (error) {
    return error instanceof GmailBudgetError ? error : null;
  }
}

describe("the poll and read lanes' named limits", () => {
  it("charge what Google charges, and the fake counts the same", () => {
    expect(GMAIL_MAIL_UNITS).toEqual({ profile: 1, history: 2, message: 20 });
    expect(GMAIL_MAIL_UNITS).toEqual(MAIL_UNITS);
  });

  it("the poll line holds a day of polling even in the window's longest form (25 hourly buckets), and the ceiling holds every account", () => {
    const idleDay = 24 * 60 * GMAIL_MAIL_UNITS.history; // one history.list a minute
    expect(idleDay).toBe(2_880);
    const worstWindow = 25 * 60 * GMAIL_MAIL_UNITS.history;
    expect(worstWindow).toBeLessThan(GMAIL_POLL_UNITS_PER_ACCOUNT_DAY);
    // The 100,000 of the filter lane would be passed by the poll alone at 50 accounts: that is why the lane has its own ceiling.
    expect(MAX_ACCOUNTS * idleDay).toBeGreaterThan(GMAIL_LIMITS.allAccountsDay);
    expect(MAX_ACCOUNTS * GMAIL_POLL_UNITS_PER_ACCOUNT_DAY).toBeLessThanOrEqual(
      GMAIL_POLL_UNITS_PER_DAY_ALL,
    );
  });

  it("the read line is 300 mails and not the poll's leftover; the all-accounts read ceiling is the brake, below 50 full lines but above the assumed volume", () => {
    expect(GMAIL_READ_UNITS_PER_ACCOUNT_DAY / GMAIL_MAIL_UNITS.message).toBe(300);
    expect(MAX_ACCOUNTS * 50 * GMAIL_MAIL_UNITS.message).toBeLessThanOrEqual(
      GMAIL_READ_UNITS_PER_DAY_ALL,
    );
    expect(MAX_ACCOUNTS * GMAIL_READ_UNITS_PER_ACCOUNT_DAY).toBeGreaterThan(
      GMAIL_READ_UNITS_PER_DAY_ALL,
    );
  });

  it("one drain (profile, history, five messages) fits the shared minute line many times over", () => {
    const drain =
      GMAIL_MAIL_UNITS.profile + GMAIL_MAIL_UNITS.history + 5 * GMAIL_MAIL_UNITS.message;
    expect(drain).toBe(103);
    expect(drain * 10).toBeLessThanOrEqual(GMAIL_UNITS_PER_MINUTE);
  });

  it("must be whole numbers of one or more, like the others", () => {
    const names = [
      "pollPerAccountDay",
      "pollAllAccountsDay",
      "readPerAccountDay",
      "readAllAccountsDay",
    ] as const;
    for (const bad of [0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY]) {
      for (const name of names) {
        expect(() => new GmailBudgets({ limits: limits({ [name]: bad }) })).toThrow(RangeError);
      }
    }
  });
});

describe("wrapMail", () => {
  it("pays every call before it leaves, logs a fixed event, and a refusal sends nothing", async () => {
    const c = clock();
    const budgets = new GmailBudgets({
      now: c.now,
      limits: limits({ pollPerAccountDay: 3 }),
    });
    const { fake, mail, events } = wiredMail(budgets, "a");
    await mail.profile(); // 1
    await mail.history("1000"); // 2 -> 3 in all
    const sent = fake.calls.length;
    const error = await refusal(mail.history("1000"));
    expect(error?.limit).toBe("poll-account-day");
    expect(fake.calls).toHaveLength(sent);
    expect(error?.code).toBe("QUOTA_EXCEEDED");
    expect(events.map((e) => e.event)).toEqual(["gmail-call", "gmail-call", "gmail-budget"]);
    expect(events.map((e) => e.op)).toEqual(["profile", "history", "history"]);
    expect(JSON.stringify(events)).not.toMatch(/@|ya29/u);
  });

  it("a failed call is paid too (Google counts it)", async () => {
    const budgets = new GmailBudgets({ now: clock().now });
    const { fake, mail } = wiredMail(budgets, "a");
    fake.forced.push(503);
    await expect(mail.history("1000")).rejects.toThrow();
    expect(budgets.remainingPoll("a").accountDay).toBe(
      GMAIL_POLL_UNITS_PER_ACCOUNT_DAY - GMAIL_MAIL_UNITS.history,
    );
    expect(budgets.remainingRead("a").accountDay).toBe(GMAIL_READ_UNITS_PER_ACCOUNT_DAY);
  });

  it("a deleted message (404) is paid on the read line and reported as `gone`", async () => {
    const budgets = new GmailBudgets({ now: clock().now });
    const { mail, events } = wiredMail(budgets, "a");
    expect(await mail.message("deadbeef")).toBe("gone");
    expect(events[0]).toMatchObject({ op: "message", outcome: "gone", units: 20 });
    expect(budgets.remainingRead("a").accountDay).toBe(GMAIL_READ_UNITS_PER_ACCOUNT_DAY - 20);
    expect(budgets.remainingPoll("a").accountDay).toBe(GMAIL_POLL_UNITS_PER_ACCOUNT_DAY);
  });
});

describe("three lanes, one minute line", () => {
  it("a busy inbox cannot starve a block: the filter lane's day line is untouched by mail", async () => {
    const budgets = new GmailBudgets({
      now: clock().now,
      limits: limits({ readPerAccountDay: 20 }),
    });
    const { fake, mail, filters } = wiredMail(budgets, "a");
    const id = fake.deliver({ from: "a@x.example" });
    await mail.message(id); // the whole read day line
    expect((await refusal(mail.message(id)))?.limit).toBe("read-account-day");
    await expect(filters.list()).resolves.toBeDefined();
    expect(budgets.remaining("a").accountDay).toBe(GMAIL_LIMITS.perAccountDay - 1);
  });

  it("a flood of mail cannot silence the poll: reading is refused, polling goes on", async () => {
    const budgets = new GmailBudgets({
      now: clock().now,
      limits: limits({ readPerAccountDay: 20 }),
    });
    const { fake, mail } = wiredMail(budgets, "a");
    const id = fake.deliver({ from: "a@x.example" });
    await mail.message(id);
    expect((await refusal(mail.message(id)))?.limit).toBe("read-account-day");
    await expect(mail.profile()).resolves.toBeDefined();
    await expect(mail.history("1000")).resolves.toBeDefined();
  });

  it("polling cannot eat the read line: a day of polls leaves every read unit", async () => {
    const budgets = new GmailBudgets({
      now: clock().now,
      limits: limits({ pollPerAccountDay: 3 }),
    });
    const { fake, mail } = wiredMail(budgets, "a");
    await mail.profile();
    await mail.history("1000");
    expect((await refusal(mail.history("1000")))?.limit).toBe("poll-account-day");
    const id = fake.deliver({ from: "a@x.example" });
    await expect(mail.message(id)).resolves.toBeDefined();
  });

  it("a block round cannot silence the poll for the day: the filter lane's day line is not the poll lane's", async () => {
    const budgets = new GmailBudgets({
      now: clock().now,
      limits: limits({ perAccountDay: 1, perMinute: 1_000 }),
    });
    const { mail, filters } = wiredMail(budgets, "a");
    await filters.list();
    expect((await refusal(filters.list()))?.limit).toBe("account-day");
    await expect(mail.profile()).resolves.toBeDefined();
  });

  it("the minute line is shared: a long filter round holds the poll back for that minute only", async () => {
    const c = clock();
    const budgets = new GmailBudgets({ now: c.now, limits: limits({ perMinute: 30 }) });
    const { mail, filters } = wiredMail(budgets, "a");
    for (let i = 0; i < 30; i += 1) await filters.list(); // 30 units
    expect((await refusal(mail.profile()))?.limit).toBe("minute");
    c.advance(MINUTE + SECOND);
    await expect(mail.profile()).resolves.toBeDefined();
  });

  it("each account has its own poll day line; the all-accounts poll ceiling is shared by the poll lane only", async () => {
    const budgets = new GmailBudgets({
      now: clock().now,
      limits: limits({ pollPerAccountDay: 100, pollAllAccountsDay: 3 }),
    });
    const a = wiredMail(budgets, "a");
    const b = wiredMail(budgets, "b");
    await a.mail.profile();
    await b.mail.profile();
    await a.mail.profile();
    expect((await refusal(b.mail.profile()))?.limit).toBe("poll-all-accounts-day");
    await expect(b.filters.list()).resolves.toBeDefined();
    const id = b.fake.deliver({ from: "a@x.example" });
    await expect(b.mail.message(id)).resolves.toBeDefined();
  });

  it("the read ceiling is shared by the read lane only", async () => {
    const budgets = new GmailBudgets({
      now: clock().now,
      limits: limits({ readPerAccountDay: 1_000, readAllAccountsDay: 20 }),
    });
    const a = wiredMail(budgets, "a");
    const b = wiredMail(budgets, "b");
    const ida = a.fake.deliver({ from: "a@x.example" });
    const idb = b.fake.deliver({ from: "a@x.example" });
    await a.mail.message(ida);
    expect((await refusal(b.mail.message(idb)))?.limit).toBe("read-all-accounts-day");
    await expect(b.mail.profile()).resolves.toBeDefined();
  });

  it("forget() drops the poll and read counters with the filter ones", async () => {
    const budgets = new GmailBudgets({ now: clock().now });
    const { fake, mail } = wiredMail(budgets, "a");
    await mail.history("1000");
    await mail.message(fake.deliver({ from: "a@x.example" }));
    budgets.forget("a");
    expect(budgets.remainingPoll("a").accountDay).toBe(GMAIL_POLL_UNITS_PER_ACCOUNT_DAY);
    expect(budgets.remainingRead("a").accountDay).toBe(GMAIL_READ_UNITS_PER_ACCOUNT_DAY);
    // what an account spent stays in the shared ceilings: removing and adding an account is not a way round them
    expect(budgets.remainingPoll("a").allAccountsDay).toBe(
      GMAIL_POLL_UNITS_PER_DAY_ALL - GMAIL_MAIL_UNITS.history,
    );
    expect(budgets.remainingRead("a").allAccountsDay).toBe(
      GMAIL_READ_UNITS_PER_DAY_ALL - GMAIL_MAIL_UNITS.message,
    );
  });
});

describe("a day of polling on the fake clock, at the real limits", () => {
  it("one poll a minute is never refused, with and without the assumed 50 mails a day", () => {
    const c = clock();
    const budgets = new GmailBudgets({ now: c.now });
    let refused = 0;
    let mails = 0;
    for (let minute = 0; minute < 24 * 60; minute += 1) {
      try {
        budgets.charge("a", GMAIL_MAIL_UNITS.history, "poll");
        // 50 mails spread over the day
        if (minute % 29 === 0 && mails < 50) {
          budgets.charge("a", GMAIL_MAIL_UNITS.message, "read");
          mails += 1;
        }
      } catch {
        refused += 1;
      }
      c.advance(MINUTE);
    }
    expect(mails).toBe(50);
    expect(refused).toBe(0);
    expect(budgets.remainingPoll("a").accountDay).toBe(GMAIL_POLL_UNITS_PER_ACCOUNT_DAY - 2_880);
    expect(budgets.remainingRead("a").accountDay).toBe(GMAIL_READ_UNITS_PER_ACCOUNT_DAY - 1_000);
  });

  it("a mail flood (480 a day) is stopped at the read line, never beyond it, and the poll is never refused", () => {
    const c = clock();
    const budgets = new GmailBudgets({ now: c.now });
    let refusedPolls = 0;
    let peakDay = 0;
    const reads: { t: number; units: number }[] = [];
    for (let minute = 0; minute < 3 * 24 * 60; minute += 1) {
      try {
        budgets.charge("a", GMAIL_MAIL_UNITS.history, "poll");
      } catch {
        refusedPolls += 1;
      }
      if (minute % 3 === 0) {
        try {
          budgets.charge("a", GMAIL_MAIL_UNITS.message, "read");
          reads.push({ t: c.now(), units: GMAIL_MAIL_UNITS.message });
        } catch (error) {
          expect(error).toBeInstanceOf(GmailBudgetError);
        }
      }
      c.advance(MINUTE);
    }
    for (const point of reads) {
      const day = reads
        .filter((p) => p.t >= point.t - DAY + 1 && p.t <= point.t)
        .reduce((sum, p) => sum + p.units, 0);
      peakDay = Math.max(peakDay, day);
    }
    expect(refusedPolls).toBe(0);
    expect(peakDay).toBeLessThanOrEqual(GMAIL_READ_UNITS_PER_ACCOUNT_DAY);
    expect(peakDay).toBeGreaterThan(GMAIL_READ_UNITS_PER_ACCOUNT_DAY * 0.9);
    // served on every day, not only the first: the line empties as the window rolls
    const start = reads[0]?.t ?? 0;
    for (const day of [0, 1, 2]) {
      expect(reads.some((p) => p.t >= start + day * DAY && p.t < start + (day + 1) * DAY)).toBe(
        true,
      );
    }
  });

  it("50 accounts polling once a minute for a day stay under the poll ceiling and none is refused", () => {
    const c = clock();
    const budgets = new GmailBudgets({ now: c.now });
    let refused = 0;
    for (let minute = 0; minute < 24 * 60; minute += 1) {
      for (let account = 0; account < MAX_ACCOUNTS; account += 1) {
        try {
          budgets.charge(`k${String(account)}`, GMAIL_MAIL_UNITS.history, "poll");
        } catch {
          refused += 1;
        }
      }
      c.advance(MINUTE);
    }
    expect(refused).toBe(0);
    expect(budgets.remainingPoll("k0").allAccountsDay).toBe(
      GMAIL_POLL_UNITS_PER_DAY_ALL - MAX_ACCOUNTS * 2_880,
    );
    // the poll left the read ceiling alone
    expect(budgets.remainingRead("k0").allAccountsDay).toBe(GMAIL_READ_UNITS_PER_DAY_ALL);
  });

  it("the same 50 accounts at the FILTER lane's ceiling (100,000) would have been refused: the reason for lanes of their own", () => {
    const c = clock();
    const budgets = new GmailBudgets({ now: c.now });
    let refused = 0;
    for (let minute = 0; minute < 24 * 60; minute += 1) {
      for (let account = 0; account < MAX_ACCOUNTS; account += 1) {
        try {
          budgets.charge(`k${String(account)}`, GMAIL_MAIL_UNITS.history, "filters");
        } catch {
          refused += 1;
        }
      }
      c.advance(MINUTE);
    }
    expect(refused).toBeGreaterThan(0);
  });
});
