import { describe, expect, it } from "vitest";
import { AccountsFileSchema, withSpamFilter } from "../src/accounts.js";
import type { AccountConfig } from "../src/accounts.js";
import {
  SPAM_LIMITS,
  SpamFilterRequestSchema,
  SpamFilterSchema,
  overSpamLimit,
  spamRule,
} from "../src/spam-filter.js";

const mailbox = (id: string): AccountConfig => ({
  id,
  imap: { host: "mail.example.com", port: 993, secure: true, user: `${id}@example.com` },
  sieve: { host: "mail.example.com", port: 4190, user: `${id}@example.com` },
  passwordCipher: "AAECAw==",
});

describe("SpamFilterSchema", () => {
  it.each([5, 10, 15])("takes the limit %i", (limit) => {
    expect(SpamFilterSchema.safeParse({ limit, action: "junk" }).success).toBe(true);
  });

  it("offers nothing under the score the server itself calls spam", () => {
    expect(Math.min(...SPAM_LIMITS)).toBe(5);
  });

  it.each([
    ["a limit under 5", { limit: 4, action: "junk" }],
    ["a limit between the steps", { limit: 7, action: "junk" }],
    ["a limit as text", { limit: "5", action: "junk" }],
    ["a fraction", { limit: 5.5, action: "junk" }],
    ["a limit that would write Sieve", { limit: '5"; discard; #', action: "junk" }],
    ["refusing at the server", { limit: 5, action: "reject" }],
    ["deleting", { limit: 5, action: "discard" }],
    ["an unknown key", { limit: 5, action: "junk", folder: "x" }],
  ])("refuses %s", (_name, value) => {
    expect(SpamFilterSchema.safeParse(value).success).toBe(false);
  });
});

describe("SpamFilterRequestSchema", () => {
  it("takes an account and a filter, or null to turn it off", () => {
    const filter = { limit: 10, action: "trash" };
    expect(SpamFilterRequestSchema.safeParse({ accountId: "main", filter }).success).toBe(true);
    expect(SpamFilterRequestSchema.safeParse({ accountId: "main", filter: null }).success).toBe(
      true,
    );
  });

  it.each([
    ["no filter key", { accountId: "main" }],
    ["an id with a line break", { accountId: "a\r\nb", filter: null }],
    ["an unknown key", { accountId: "main", filter: null, extra: 1 }],
  ])("refuses %s", (_name, value) => {
    expect(SpamFilterRequestSchema.safeParse(value).success).toBe(false);
  });
});

describe("spamRule", () => {
  it("puts a rule on the server for a filter that moves mail", () => {
    expect(spamRule({ limit: 5, action: "trash" })).toEqual({ limit: 5, action: "trash" });
  });

  it("puts none for ask or for no filter", () => {
    expect(spamRule({ limit: 5, action: "ask" })).toBeNull();
    expect(spamRule(null)).toBeNull();
  });
});

describe("overSpamLimit", () => {
  const ask = { limit: 5, action: "ask" } as const;

  it("holds from the limit up", () => {
    expect(overSpamLimit(ask, 4.9)).toBe(false);
    expect(overSpamLimit(ask, 5)).toBe(true);
    expect(overSpamLimit(ask, 12.3)).toBe(true);
  });

  it("does not hold with no score, no filter, or a filter that moves the mail", () => {
    expect(overSpamLimit(ask, null)).toBe(false);
    expect(overSpamLimit(null, 50)).toBe(false);
    expect(overSpamLimit({ limit: 5, action: "junk" }, 50)).toBe(false);
  });
});

describe("withSpamFilter", () => {
  it("sets it on one mailbox and leaves the others", () => {
    const filter = { limit: 10, action: "junk" } as const;
    const [first, second] = withSpamFilter([mailbox("one"), mailbox("two")], "one", filter);
    expect(first).toMatchObject({ spamFilter: filter });
    expect(second).toEqual(mailbox("two"));
  });

  it("takes the key out when turned off, so the file reads as it did", () => {
    const on = withSpamFilter([mailbox("one")], "one", { limit: 5, action: "junk" });
    expect(withSpamFilter(on, "one", null)).toEqual([mailbox("one")]);
  });

  it("leaves a mailbox that is not on a mail server alone", () => {
    const gmail = {
      id: "g",
      gmail: { email: "me@example.com" },
    } as unknown as AccountConfig;
    expect(withSpamFilter([gmail], "g", { limit: 5, action: "junk" })).toEqual([gmail]);
  });

  it("reads a file written before the filter existed, and one with a filter", () => {
    const before = { version: 1, accounts: [mailbox("one")] };
    expect(AccountsFileSchema.safeParse(before).success).toBe(true);
    const after = {
      version: 1,
      accounts: withSpamFilter([mailbox("one")], "one", { limit: 15, action: "ask" }),
    };
    expect(AccountsFileSchema.safeParse(after).success).toBe(true);
  });

  it("refuses a file with a limit under 5", () => {
    const file = {
      version: 1,
      accounts: [{ ...mailbox("one"), spamFilter: { limit: 1, action: "junk" } }],
    };
    expect(AccountsFileSchema.safeParse(file).success).toBe(false);
  });
});
