import { describe, expect, it } from "vitest";
import {
  AccountsFileSchema,
  MXROUTE_LIMITS,
  MxrouteInputSchema,
  NewAccountSchema,
} from "../src/accounts.js";
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

describe("MXroute key (advanced)", () => {
  const stored = {
    server: "mx.example.net",
    username: "exampleuser",
    apiKeyCipher: "AAECAw==",
  };
  const typed = {
    accountId: "main",
    server: "mx.example.net",
    username: "reseller|exampleuser",
    apiKey: "k".repeat(MXROUTE_LIMITS.apiKey.min),
  };

  it("is optional and stored as ciphertext only", () => {
    expect(AccountsFileSchema.safeParse(file([{ ...account(), mxroute: stored }])).success).toBe(
      true,
    );
    const plain = { ...stored, apiKey: "secret-key-1234" };
    expect(AccountsFileSchema.safeParse(file([{ ...account(), mxroute: plain }])).success).toBe(
      false,
    );
    expect(
      AccountsFileSchema.safeParse(
        file([{ ...account(), mxroute: { ...stored, apiKeyCipher: "not base64!" } }]),
      ).success,
    ).toBe(false);
  });

  it("is not accepted when adding an account from a file", () => {
    const added = { ...account(), password: "pw" };
    delete (added as { passwordCipher?: string }).passwordCipher;
    expect(NewAccountSchema.safeParse(added).success).toBe(true);
    expect(NewAccountSchema.safeParse({ ...added, mxroute: stored }).success).toBe(false);
  });

  it("bounds the typed key, user name and server in their own units", () => {
    expect(MxrouteInputSchema.safeParse(typed).success).toBe(true);
    const bad = [
      { ...typed, apiKey: "k".repeat(MXROUTE_LIMITS.apiKey.min - 1) },
      { ...typed, apiKey: "k".repeat(MXROUTE_LIMITS.apiKey.max + 1) },
      { ...typed, apiKey: "has space in key" },
      { ...typed, apiKey: "line\nbreak-key" },
      { ...typed, apiKey: "nul\u0000-in-the-key" },
      { ...typed, apiKey: "ключ-не-ascii-ключ" },
      { ...typed, username: "" },
      { ...typed, username: "u".repeat(MXROUTE_LIMITS.username.max + 1) },
      { ...typed, username: "a\nX-Evil: 1" },
      { ...typed, server: "mail.example.com/path" },
      { ...typed, server: "a b" },
      { ...typed, accountId: "bad id" },
      { ...typed, extra: true },
    ];
    for (const input of bad) expect(MxrouteInputSchema.safeParse(input).success).toBe(false);
  });
});
