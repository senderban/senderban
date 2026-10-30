import { describe, expect, it } from "vitest";
import {
  AccountsFileSchema,
  CLEAN_ADD_LIMITS,
  CleanAddSchema,
  accountLogins,
  cleanAccountFromForm,
  isCleanAccount,
  isGmailAccount,
  isImapAccount,
} from "../../src/accounts.js";

const CIPHER = Buffer.from("opaque").toString("base64");
const clean = (address = "you@example.com", id = address) => ({
  id,
  clean: { address, host: "imap.example.com", port: 993, secure: true, user: address },
  passwordCipher: CIPHER,
});
const form = {
  address: "you@example.com",
  host: "imap.example.com",
  port: 993,
  password: "app-password",
};

describe("a cleaning account in accounts.json", () => {
  it("is its own kind", () => {
    const file = AccountsFileSchema.parse({ version: 1, accounts: [clean()] });
    const [account] = file.accounts;
    if (account === undefined) throw new Error("no account");
    expect(isCleanAccount(account)).toBe(true);
    expect(isImapAccount(account)).toBe(false);
    expect(isGmailAccount(account)).toBe(false);
    expect(accountLogins(account)).toEqual(["you@example.com"]);
  });

  it("rejects a plaintext password riding along", () => {
    const bad = { ...clean(), password: "x" };
    expect(AccountsFileSchema.safeParse({ version: 1, accounts: [bad] }).success).toBe(false);
  });

  it("holds a mailbox once, next to any other kind", () => {
    const imap = {
      id: "other",
      imap: { host: "mail.example.com", port: 993, secure: true, user: "you@example.com" },
      sieve: { host: "mail.example.com", port: 4190, user: "you@example.com" },
      passwordCipher: CIPHER,
    };
    const gmail = { id: "g", gmail: { email: "you@example.com" } };
    for (const other of [imap, gmail]) {
      const file = { version: 1, accounts: [clean(), other] };
      expect(AccountsFileSchema.safeParse(file).success).toBe(false);
    }
    const two = { version: 1, accounts: [clean(), clean("you@example.com", "second")] };
    expect(AccountsFileSchema.safeParse(two).success).toBe(false);
  });
});

describe("the Other (IMAP) form", () => {
  it("defaults the login to the address and uses implicit TLS", () => {
    const account = cleanAccountFromForm(CleanAddSchema.parse(form));
    expect(account.id).toBe("you@example.com");
    expect(account.clean).toEqual({
      address: "you@example.com",
      host: "imap.example.com",
      port: 993,
      secure: true,
      user: "you@example.com",
    });
  });

  it("uses STARTTLS on 143, and never plain IMAP", () => {
    const account = cleanAccountFromForm(CleanAddSchema.parse({ ...form, port: 143 }));
    expect(account.clean.secure).toBe(false);
  });

  it("takes a login that is only the part before the @, as iCloud's page says", () => {
    const account = cleanAccountFromForm(CleanAddSchema.parse({ ...form, login: "you" }));
    expect(account.clean.user).toBe("you");
    expect(account.clean.address).toBe("you@example.com");
  });

  it("lower-cases the address and the host", () => {
    const parsed = CleanAddSchema.parse({
      ...form,
      address: "You@Example.com",
      host: "IMAP.Example.COM",
    });
    expect(parsed.address).toBe("you@example.com");
    expect(parsed.host).toBe("imap.example.com");
  });

  it.each([
    ["a port below the range", { port: CLEAN_ADD_LIMITS.port.min - 1 }],
    ["a port above the range", { port: CLEAN_ADD_LIMITS.port.max + 1 }],
    ["a fractional port", { port: 993.5 }],
    ["a port given as text", { port: "993" }],
    ["a private host", { host: "mail.local" }],
    ["an IP address", { host: "192.0.2.1" }],
    ["a login with a space", { login: "you x" }],
    ["a login past the bound", { login: "a".repeat(CLEAN_ADD_LIMITS.login.max + 1) }],
    ["an empty login", { login: "" }],
    ["a line break in the password", { password: "a\r\nb" }],
    ["an unknown key", { extra: 1 }],
    ["an id ending like a lane", { address: "you@example.mxroute" }],
  ])("refuses %s", (_, over) => {
    expect(CleanAddSchema.safeParse({ ...form, ...over }).success).toBe(false);
  });
});
