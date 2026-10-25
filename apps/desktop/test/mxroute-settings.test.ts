import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// A stand-in for the OS store: reversible, and never the plaintext, so a test can tell if one leaks to disk.
vi.mock("electron", () => ({
  safeStorage: {
    isAsyncEncryptionAvailable: () => Promise.resolve(true),
    encryptStringAsync: (plain: string) => Promise.resolve(Buffer.from(plain, "utf8").reverse()),
    decryptStringAsync: (data: Buffer) =>
      Promise.resolve({ result: Buffer.from(data).reverse().toString("utf8") }),
  },
}));

const { listMxroute, removeMxroute, saveMxroute } = await import("../src/mxroute-settings.js");
const { loadAccounts, saveAccounts } = await import("../src/accounts-file.js");

const account = (id: string) => ({
  id,
  imap: { host: "mail.example.com", port: 993, secure: true, user: `${id}@example.com` },
  sieve: { host: "mail.example.com", port: 4190, user: `${id}@example.com` },
  passwordCipher: "AAECAw==",
});
const KEY = "Zk3-very-secret-api-key-0123456789";
const input = (accountId: string) => ({
  accountId,
  server: "mx.example.net",
  username: "exampleuser",
  apiKey: KEY,
});

let dir: string;
let file: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "senderban-mxroute-"));
  file = join(dir, "accounts.json");
  await saveAccounts(file, [account("a"), account("b")]);
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe("MXroute key storage", () => {
  it("stores only ciphertext on disk and shows the page no key", async () => {
    expect(await saveMxroute(file, input("a"))).toBe("saved");
    const onDisk = await readFile(file, "utf8");
    expect(onDisk).not.toContain(KEY);
    expect(onDisk).toContain("apiKeyCipher");

    const page = await listMxroute(file);
    expect(page.find((a) => a.accountId === "a")).toEqual({
      accountId: "a",
      label: "a@example.com",
      hasKey: true,
      server: "mx.example.net",
      username: "exampleuser",
    });
    expect(page.find((a) => a.accountId === "b")?.hasKey).toBe(false);
    expect(JSON.stringify(page)).not.toContain("apiKeyCipher");
    expect(JSON.stringify(page)).not.toContain(KEY);
  });

  it("changes only the account it was given, and keeps the mail password", async () => {
    await saveMxroute(file, input("a"));
    const [a, b] = await loadAccounts(file);
    expect(a?.mxroute?.username).toBe("exampleuser");
    expect(a?.passwordCipher).toBe("AAECAw==");
    expect(b?.mxroute).toBeUndefined();
  });

  it("replaces an earlier key and removes it on request", async () => {
    await saveMxroute(file, input("a"));
    await saveMxroute(file, { ...input("a"), username: "other" });
    expect((await loadAccounts(file))[0]?.mxroute?.username).toBe("other");
    expect(await removeMxroute(file, "a")).toBe("saved");
    // Back to exactly the account that was there before the key, so nothing else was dropped.
    expect((await loadAccounts(file))[0]).toEqual(account("a"));
    expect(await readFile(file, "utf8")).not.toContain("apiKeyCipher");
  });

  it("refuses an account that does not exist and writes nothing", async () => {
    const before = await readFile(file, "utf8");
    expect(await saveMxroute(file, input("zzz"))).toBe("unknown-account");
    expect(await removeMxroute(file, "zzz")).toBe("unknown-account");
    expect(await readFile(file, "utf8")).toBe(before);
  });

  it("does not lose a key when two accounts are saved at the same time", async () => {
    await Promise.all([saveMxroute(file, input("a")), saveMxroute(file, input("b"))]);
    const accounts = await loadAccounts(file);
    expect(accounts.map((a) => a.mxroute !== undefined)).toEqual([true, true]);
  });
});
