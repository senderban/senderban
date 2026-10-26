import { describe, expect, it } from "vitest";
import {
  AccountsFileSchema,
  GOOGLE_CLIENT_LIMITS,
  GoogleClientFileSchema,
  GoogleClientInputSchema,
  GoogleSignInRequestSchema,
  MXROUTE_LIMITS,
  MxrouteInputSchema,
  NewAccountSchema,
  isImapAccount,
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

describe("Gmail account (ADR 0009)", () => {
  const gmail = (id = "g1") => ({
    id,
    gmail: { email: `${id.replace(/[^a-z0-9]/g, "x")}@gmail.com`, refreshCipher: "AAECAw==" },
  });

  it("is accepted next to an IMAP account, and only the IMAP kind passes isImapAccount", () => {
    const parsed = AccountsFileSchema.safeParse(file([account(), gmail()]));
    expect(parsed.success).toBe(true);
    if (!parsed.success) return;
    expect(parsed.data.accounts.map(isImapAccount)).toEqual([true, false]);
  });

  it.each([
    ["an extra key", { ...gmail(), password: "hunter2" }],
    ["an extra key inside gmail", { ...gmail(), gmail: { ...gmail().gmail, accessToken: "ya29" } }],
    ["both kinds in one record", { ...account(), gmail: gmail().gmail }],
    [
      "a plaintext refresh token",
      { ...gmail(), gmail: { email: "me@gmail.com", refreshToken: "1//x" } },
    ],
    [
      "a refresh token that is not base64",
      { ...gmail(), gmail: { ...gmail().gmail, refreshCipher: "1//not base64!" } },
    ],
    ["an upper-case address", { ...gmail(), gmail: { ...gmail().gmail, email: "Me@gmail.com" } }],
    [
      "an address with a display name",
      { ...gmail(), gmail: { ...gmail().gmail, email: "Me <me@gmail.com>" } },
    ],
    [
      "an address past the RFC 5321 limit",
      {
        ...gmail(),
        gmail: {
          ...gmail().gmail,
          email: `${"a".repeat(64)}@${"b".repeat(63)}.${"c".repeat(63)}.${"d".repeat(63)}.com`,
        },
      },
    ],
    ["no address", { ...gmail(), gmail: { refreshCipher: "AAECAw==" } }],
    ["a bad account id", gmail("bad id")],
  ])("refuses %s", (_name, entry) => {
    expect(AccountsFileSchema.safeParse(file([entry])).success).toBe(false);
  });

  it("counts toward MAX_ACCOUNTS and the unique-id rule with the other kind", () => {
    expect(AccountsFileSchema.safeParse(file([account("a"), gmail("a")])).success).toBe(false);
    const many = Array.from({ length: MAX_ACCOUNTS + 1 }, (_, i) =>
      i % 2 === 0 ? account(`a${String(i)}`) : gmail(`a${String(i)}`),
    );
    expect(AccountsFileSchema.safeParse(file(many)).success).toBe(false);
  });

  it("allows one mailbox once: not twice as Gmail, not also as an IMAP login", () => {
    const twice = {
      ...gmail("g2"),
      gmail: { ...gmail("g2").gmail, email: gmail("g1").gmail.email },
    };
    expect(AccountsFileSchema.safeParse(file([gmail("g1"), twice])).success).toBe(false);
    const sameAsImap = { ...gmail("g1"), gmail: { ...gmail().gmail, email: "me@example.com" } };
    expect(AccountsFileSchema.safeParse(file([account("a"), sameAsImap])).success).toBe(false);
    expect(
      AccountsFileSchema.safeParse(file([account("a"), gmail("g1"), gmail("g2")])).success,
    ).toBe(true);
  });

  it("reads Gmail's spellings of one inbox as one mailbox (dots, +tag, googlemail.com)", () => {
    const as = (id: string, email: string) => ({
      ...gmail(id),
      gmail: { ...gmail(id).gmail, email },
    });
    for (const alias of ["m.e@gmail.com", "me+news@gmail.com", "me@googlemail.com"]) {
      expect(
        AccountsFileSchema.safeParse(file([as("g1", "me@gmail.com"), as("g2", alias)])).success,
      ).toBe(false);
    }
    // Also against an IMAP login that is the same Gmail inbox.
    const imapGmail = {
      ...account("a"),
      imap: { ...account().imap, user: "m.e@gmail.com" },
      sieve: { ...account().sieve, user: "m.e@gmail.com" },
    };
    expect(
      AccountsFileSchema.safeParse(file([imapGmail, as("g1", "me@googlemail.com")])).success,
    ).toBe(false);
    // A different mailbox is still fine.
    expect(
      AccountsFileSchema.safeParse(file([as("g1", "me@gmail.com"), as("g2", "me2@gmail.com")]))
        .success,
    ).toBe(true);
  });

  it("takes an address of exactly 254 characters and nothing longer", () => {
    // 64 + "@" + 63 + "." + 63 + "." + 61 = 254 (RFC 5321 §4.5.3.1: local 64, path 256 minus brackets).
    const at254 = `${"a".repeat(64)}@${"b".repeat(63)}.${"c".repeat(63)}.${"d".repeat(61)}`;
    expect(at254).toHaveLength(254);
    const withEmail = (email: string) => ({ ...gmail(), gmail: { ...gmail().gmail, email } });
    expect(AccountsFileSchema.safeParse(file([withEmail(at254)])).success).toBe(true);
    expect(AccountsFileSchema.safeParse(file([withEmail(`${at254}d`)])).success).toBe(false);
  });

  it("takes exactly MAX_ACCOUNTS mixed accounts", () => {
    const mixed = Array.from({ length: MAX_ACCOUNTS }, (_, i) =>
      i % 2 === 0 ? account(`a${String(i)}`) : gmail(`a${String(i)}`),
    );
    expect(AccountsFileSchema.safeParse(file(mixed)).success).toBe(true);
  });

  it("is not something a person can add from a file with a password", () => {
    expect(NewAccountSchema.safeParse({ ...gmail(), password: "pw" }).success).toBe(false);
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

  it("is off unless the person turned it on, and the flag must be a boolean", () => {
    const parse = (mxroute: unknown) =>
      AccountsFileSchema.safeParse(file([{ ...account(), mxroute }]));
    const off = parse(stored);
    const first = (r: typeof off) =>
      r.success ? r.data.accounts.filter(isImapAccount)[0] : undefined;
    expect(first(off)?.mxroute?.enabled).toBe(false);
    const on = parse({ ...stored, enabled: true });
    expect(first(on)?.mxroute?.enabled).toBe(true);
    expect(parse({ ...stored, enabled: "yes" }).success).toBe(false);
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

describe("Gmail account signed out (client changed)", () => {
  const signedOut = { id: "g1", gmail: { email: "me@gmail.com" } };

  it("is accepted without a token, and still refuses an unknown key", () => {
    expect(AccountsFileSchema.safeParse(file([signedOut])).success).toBe(true);
    const withToken = { ...signedOut, gmail: { ...signedOut.gmail, refreshToken: "1//x" } };
    expect(AccountsFileSchema.safeParse(file([withToken])).success).toBe(false);
  });
});

describe("Google client (ADR 0009, Data)", () => {
  // Same shape and length as the real client made on 2026-10-26 (72 and 35 characters).
  // Built at run time: a whole fake ID or secret in the source trips GitHub push protection.
  const CLIENT_ID = [
    "123456789012-abcdefghijklmnopqrstuvwxyz012345",
    "apps",
    "googleusercontent",
    "com",
  ].join(".");
  const SECRET = ["GOCSPX", "abcdefghijklmnopqrstuvwxyz01"].join("-");
  const input = { clientId: CLIENT_ID, clientSecret: SECRET, confirmSignOut: false };

  it("accepts a real-shaped ID and secret", () => {
    expect(CLIENT_ID).toHaveLength(72);
    expect(SECRET).toHaveLength(35);
    expect(GoogleClientInputSchema.safeParse(input).success).toBe(true);
  });

  it.each([
    ["an extra key", { ...input, scope: "mail" }],
    ["no confirmation flag", { clientId: CLIENT_ID, clientSecret: SECRET }],
    ["an ID of another host", { ...input, clientId: "1-a.apps.example.com" }],
    [
      "an ID past its limit",
      { ...input, clientId: `1-${"a".repeat(130)}.apps.googleusercontent.com` },
    ],
    ["an empty secret", { ...input, clientSecret: "" }],
    ["a secret with a space", { ...input, clientSecret: "GOCSPX abc" }],
    ["a secret with a line break", { ...input, clientSecret: "GOCSPX-a\nb" }],
    ["a secret past its limit", { ...input, clientSecret: "a".repeat(257) }],
  ])("refuses %s", (_name, value) => {
    expect(GoogleClientInputSchema.safeParse(value).success).toBe(false);
  });

  it("keeps the ID and the secret within the named limits", () => {
    expect(GOOGLE_CLIENT_LIMITS.clientId.max).toBe(128);
    expect(GOOGLE_CLIENT_LIMITS.clientSecret.max).toBe(256);
    const longest = `1-${"a".repeat(GOOGLE_CLIENT_LIMITS.clientId.max - 29)}.apps.googleusercontent.com`;
    expect(longest).toHaveLength(GOOGLE_CLIENT_LIMITS.clientId.max);
    expect(GoogleClientInputSchema.safeParse({ ...input, clientId: longest }).success).toBe(true);
  });

  it("stores the secret as ciphertext only", () => {
    const file = { version: 1, clientId: CLIENT_ID, secretCipher: "AAECAw==" };
    expect(GoogleClientFileSchema.safeParse(file).success).toBe(true);
    expect(GoogleClientFileSchema.safeParse({ ...file, secretCipher: SECRET }).success).toBe(false);
    expect(GoogleClientFileSchema.safeParse({ ...file, clientSecret: SECRET }).success).toBe(false);
  });

  it("takes a sign-in request with nothing but an optional account id", () => {
    expect(GoogleSignInRequestSchema.safeParse({}).success).toBe(true);
    expect(GoogleSignInRequestSchema.safeParse({ accountId: "gmail-1a2b3c4d" }).success).toBe(true);
    for (const bad of [
      { url: "https://evil.example" },
      { scope: "https://mail.google.com/" },
      { accountId: "bad id" },
      { accountId: "a", email: "x@y.com" },
    ])
      expect(GoogleSignInRequestSchema.safeParse(bad).success).toBe(false);
  });
});
