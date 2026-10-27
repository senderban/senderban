import { describe, expect, it } from "vitest";
import {
  GMAIL_LIMITS,
  GMAIL_MAIL_UNITS,
  GMAIL_MAIL_UNITS_PER_ACCOUNT_DAY,
  GMAIL_MAIL_UNITS_PER_DAY_ALL,
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

describe("the mail lane's named limits", () => {
  it("charge what Google charges, and the fake counts the same", () => {
    expect(GMAIL_MAIL_UNITS).toEqual({ profile: 1, history: 2, message: 20 });
    expect(GMAIL_MAIL_UNITS).toEqual(MAIL_UNITS);
  });

  it("fit the polling the ADR derives, with room for mail, and the ceiling fits every account", () => {
    const idleDay = 24 * 60 * GMAIL_MAIL_UNITS.history; // one history.list a minute
    expect(idleDay).toBe(2_880);
    // 50 mails a day (the assumed volume) are 1,000 more: the K8 figure of about 3,900 a day.
    expect(idleDay + 50 * GMAIL_MAIL_UNITS.message).toBeLessThanOrEqual(
      GMAIL_MAIL_UNITS_PER_ACCOUNT_DAY,
    );
    // The 100,000 of the filter lane would be passed by the poll alone at 50 accounts: that is why the lane has its own ceiling.
    expect(MAX_ACCOUNTS * idleDay).toBeGreaterThan(GMAIL_LIMITS.allAccountsDay);
    expect(MAX_ACCOUNTS * GMAIL_MAIL_UNITS_PER_ACCOUNT_DAY).toBeLessThanOrEqual(
      GMAIL_MAIL_UNITS_PER_DAY_ALL,
    );
  });

  it("one drain (profile, history, five messages) fits the shared minute line many times over", () => {
    const drain =
      GMAIL_MAIL_UNITS.profile + GMAIL_MAIL_UNITS.history + 5 * GMAIL_MAIL_UNITS.message;
    expect(drain).toBe(103);
    expect(drain * 10).toBeLessThanOrEqual(GMAIL_UNITS_PER_MINUTE);
  });

  it("must be whole numbers of one or more, like the others", () => {
    for (const bad of [0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(() => new GmailBudgets({ limits: limits({ mailPerAccountDay: bad }) })).toThrow(
        RangeError,
      );
      expect(() => new GmailBudgets({ limits: limits({ mailAllAccountsDay: bad }) })).toThrow(
        RangeError,
      );
    }
  });
});

describe("wrapMail", () => {
  it("pays every call before it leaves, logs a fixed event, and a refusal sends nothing", async () => {
    const c = clock();
    const budgets = new GmailBudgets({
      now: c.now,
      limits: limits({ mailPerAccountDay: 3 }),
    });
    const { fake, mail, events } = wiredMail(budgets, "a");
    await mail.profile(); // 1
    await mail.history("1000"); // 2 -> 3 in all
    const sent = fake.calls.length;
    const error = await refusal(mail.history("1000"));
    expect(error?.limit).toBe("mail-account-day");
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
    expect(budgets.remainingMail("a").accountDay).toBe(
      GMAIL_MAIL_UNITS_PER_ACCOUNT_DAY - GMAIL_MAIL_UNITS.history,
    );
  });

  it("a deleted message (404) is paid and reported as `gone`", async () => {
    const budgets = new GmailBudgets({ now: clock().now });
    const { mail, events } = wiredMail(budgets, "a");
    expect(await mail.message("deadbeef")).toBe("gone");
    expect(events[0]).toMatchObject({ op: "message", outcome: "gone", units: 20 });
  });
});

describe("two lanes, one minute line", () => {
  it("a busy inbox cannot starve a block: the filter lane's day line is untouched by mail", async () => {
    const budgets = new GmailBudgets({
      now: clock().now,
      limits: limits({ mailPerAccountDay: 20 }),
    });
    const { fake, mail, filters } = wiredMail(budgets, "a");
    const id = fake.deliver({ from: "a@x.example" });
    await mail.message(id); // the whole mail day line
    expect((await refusal(mail.profile()))?.limit).toBe("mail-account-day");
    await expect(filters.list()).resolves.toBeDefined();
    expect(budgets.remaining("a").accountDay).toBe(GMAIL_LIMITS.perAccountDay - 1);
  });

  it("a block round cannot silence the poll for the day: the filter lane's day line is not the mail lane's", async () => {
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

  it("each account has its own mail day line; the all-accounts ceiling is shared by the mail lane only", async () => {
    const budgets = new GmailBudgets({
      now: clock().now,
      limits: limits({ mailPerAccountDay: 100, mailAllAccountsDay: 3 }),
    });
    const a = wiredMail(budgets, "a");
    const b = wiredMail(budgets, "b");
    await a.mail.profile();
    await b.mail.profile();
    await a.mail.profile();
    expect((await refusal(b.mail.profile()))?.limit).toBe("mail-all-accounts-day");
    await expect(b.filters.list()).resolves.toBeDefined();
  });

  it("forget() drops the mail counters with the filter ones", async () => {
    const budgets = new GmailBudgets({ now: clock().now });
    const { mail } = wiredMail(budgets, "a");
    await mail.history("1000");
    budgets.forget("a");
    expect(budgets.remainingMail("a").accountDay).toBe(GMAIL_MAIL_UNITS_PER_ACCOUNT_DAY);
    // what an account spent stays in the shared ceiling: removing and adding an account is not a way round it
    expect(budgets.remainingMail("a").allAccountsDay).toBe(
      GMAIL_MAIL_UNITS_PER_DAY_ALL - GMAIL_MAIL_UNITS.history,
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
        budgets.charge("a", GMAIL_MAIL_UNITS.history, "mail");
        // 50 mails spread over the day
        if (minute % 29 === 0 && mails < 50) {
          budgets.charge("a", GMAIL_MAIL_UNITS.message, "mail");
          mails += 1;
        }
      } catch {
        refused += 1;
      }
      c.advance(MINUTE);
    }
    expect(mails).toBe(50);
    expect(refused).toBe(0);
    expect(budgets.remainingMail("a").accountDay).toBe(
      GMAIL_MAIL_UNITS_PER_ACCOUNT_DAY - 2_880 - 1_000,
    );
  });

  it("a mail flood (500 a day) is stopped at the account's line, never beyond it, and the poll resumes the next day", () => {
    const c = clock();
    const budgets = new GmailBudgets({ now: c.now });
    let spent = 0;
    let peakDay = 0;
    const log: { t: number; units: number }[] = [];
    for (let minute = 0; minute < 3 * 24 * 60; minute += 1) {
      const attempts = [
        GMAIL_MAIL_UNITS.history,
        ...(minute % 3 === 0 ? [GMAIL_MAIL_UNITS.message] : []),
      ];
      for (const units of attempts) {
        try {
          budgets.charge("a", units, "mail");
          spent += units;
          log.push({ t: c.now(), units });
        } catch (error) {
          expect(error).toBeInstanceOf(GmailBudgetError);
        }
      }
      c.advance(MINUTE);
    }
    for (const point of log) {
      const day = log
        .filter((p) => p.t >= point.t - DAY + 1 && p.t <= point.t)
        .reduce((sum, p) => sum + p.units, 0);
      peakDay = Math.max(peakDay, day);
    }
    expect(peakDay).toBeLessThanOrEqual(GMAIL_MAIL_UNITS_PER_ACCOUNT_DAY);
    expect(peakDay).toBeGreaterThan(GMAIL_MAIL_UNITS_PER_ACCOUNT_DAY * 0.9);
    // served on every day, not only the first: the line empties as the window rolls
    const start = log[0]?.t ?? 0;
    for (const day of [0, 1, 2]) {
      expect(log.some((p) => p.t >= start + day * DAY && p.t < start + (day + 1) * DAY)).toBe(true);
    }
    expect(spent).toBeGreaterThan(GMAIL_MAIL_UNITS_PER_ACCOUNT_DAY);
  });

  it("50 accounts polling once a minute for a day stay under the mail ceiling and none is refused", () => {
    const c = clock();
    const budgets = new GmailBudgets({ now: c.now });
    let refused = 0;
    for (let minute = 0; minute < 24 * 60; minute += 1) {
      for (let account = 0; account < MAX_ACCOUNTS; account += 1) {
        try {
          budgets.charge(`k${String(account)}`, GMAIL_MAIL_UNITS.history, "mail");
        } catch {
          refused += 1;
        }
      }
      c.advance(MINUTE);
    }
    expect(refused).toBe(0);
    expect(budgets.remainingMail("k0").allAccountsDay).toBe(
      GMAIL_MAIL_UNITS_PER_DAY_ALL - MAX_ACCOUNTS * 2_880,
    );
  });

  it("the same 50 accounts at the FILTER lane's ceiling (100,000) would have been refused: the reason for a lane of its own", () => {
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
