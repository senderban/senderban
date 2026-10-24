import { describe, expect, it } from "vitest";
import { AccountsFileSchema } from "../src/accounts.js";
import { MAX_ACCOUNTS } from "../src/sync/engine.js";

const account = (id = "main") => ({
  id,
  imap: { host: "mail.example.com", port: 993, secure: true, user: "me@example.com" },
  sieve: { host: "mail.example.com", port: 4190, user: "me@example.com" },
  passwordCipher: "AAECAw==",
});
const file = (accounts: unknown[]) => ({ version: 1, accounts });

describe("AccountsFileSchema", () => {
  it("accepts a well-formed file", () => {
    expect(AccountsFileSchema.safeParse(file([account()])).success).toBe(true);
  });

  it("rejects unknown keys, so a plaintext password cannot ride along", () => {
    const withPassword = { ...account(), password: "hunter2" };
    expect(AccountsFileSchema.safeParse(file([withPassword])).success).toBe(false);
  });

  it("rejects duplicate ids and more than MAX_ACCOUNTS accounts", () => {
    expect(AccountsFileSchema.safeParse(file([account("a"), account("a")])).success).toBe(false);
    const many = Array.from({ length: MAX_ACCOUNTS + 1 }, (_, i) => account(`a${String(i)}`));
    expect(AccountsFileSchema.safeParse(file(many)).success).toBe(false);
  });

  it("bounds ports, hosts and users in their own units", () => {
    const bad = [
      { ...account(), imap: { ...account().imap, port: 0 } },
      { ...account(), imap: { ...account().imap, port: 65_536 } },
      { ...account(), imap: { ...account().imap, host: "a b" } },
      { ...account(), imap: { ...account().imap, host: "x".repeat(254) } },
      { ...account(), sieve: { ...account().sieve, user: "a\nb" } },
      { ...account(), sieve: { ...account().sieve, user: "u".repeat(256) } },
      { ...account(), passwordCipher: "not base64!" },
      { ...account("bad id") },
    ];
    for (const entry of bad)
      expect(AccountsFileSchema.safeParse(file([entry])).success).toBe(false);
  });
});
