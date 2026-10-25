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

const { listMxroute, removeMxroute, saveMxroute, setMxrouteEnabled } =
  await import("../src/mxroute-settings.js");
const { AdapterError } = await import("@senderban/core");
const { loadAccounts, saveAccounts } = await import("../src/accounts-file.js");

const account = (id: string) => ({
  id,
  imap: { host: "mail.example.com", port: 993, secure: true, user: `${id}@example.com` },
  sieve: { host: "mail.example.com", port: 4190, user: `${id}@example.com` },
  passwordCipher: "AAECAw==",
});
// The key check talks to MXroute; tests give it a stand-in.
const ok = () => Promise.resolve();
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
    expect(await saveMxroute(file, input("a"), ok)).toBe("saved");
    const onDisk = await readFile(file, "utf8");
    expect(onDisk).not.toContain(KEY);
    expect(onDisk).toContain("apiKeyCipher");

    const page = await listMxroute(file);
    expect(page.find((a) => a.accountId === "a")).toEqual({
      accountId: "a",
      label: "a@example.com",
      hasKey: true,
      enabled: false,
      server: "mx.example.net",
      username: "exampleuser",
    });
    expect(page.find((a) => a.accountId === "b")?.hasKey).toBe(false);
    expect(JSON.stringify(page)).not.toContain("apiKeyCipher");
    expect(JSON.stringify(page)).not.toContain(KEY);
  });

  it("changes only the account it was given, and keeps the mail password", async () => {
    await saveMxroute(file, input("a"), ok);
    const [a, b] = await loadAccounts(file);
    expect(a?.mxroute?.username).toBe("exampleuser");
    expect(a?.passwordCipher).toBe("AAECAw==");
    expect(b?.mxroute).toBeUndefined();
  });

  it("replaces an earlier key and removes it on request", async () => {
    await saveMxroute(file, input("a"), ok);
    await saveMxroute(file, { ...input("a"), username: "other" }, ok);
    expect((await loadAccounts(file))[0]?.mxroute?.username).toBe("other");
    expect(await removeMxroute(file, "a")).toBe("saved");
    // Back to exactly the account that was there before the key, so nothing else was dropped.
    expect((await loadAccounts(file))[0]).toEqual(account("a"));
    expect(await readFile(file, "utf8")).not.toContain("apiKeyCipher");
  });

  it("refuses an account that does not exist and writes nothing", async () => {
    const before = await readFile(file, "utf8");
    expect(await saveMxroute(file, input("zzz"), ok)).toBe("unknown-account");
    expect(await removeMxroute(file, "zzz")).toBe("unknown-account");
    expect(await readFile(file, "utf8")).toBe(before);
  });

  it("does not lose a key when two accounts are saved at the same time", async () => {
    await Promise.all([saveMxroute(file, input("a"), ok), saveMxroute(file, input("b"), ok)]);
    const accounts = await loadAccounts(file);
    expect(accounts.map((a) => a.mxroute !== undefined)).toEqual([true, true]);
  });

  it("does not store a key that MXroute refuses or cannot be asked about", async () => {
    const before = await readFile(file, "utf8");
    const refused = () => Promise.reject(new AdapterError("AUTH_REQUIRED", "refused"));
    const down = () => Promise.reject(new AdapterError("TRANSIENT", "busy"));
    const odd = () => Promise.reject(new Error("boom"));
    expect(await saveMxroute(file, input("a"), refused)).toBe("key-refused");
    expect(await saveMxroute(file, input("a"), down)).toBe("unreachable");
    expect(await saveMxroute(file, input("a"), odd)).toBe("unreachable");
    expect(await readFile(file, "utf8")).toBe(before);
  });

  it("asks MXroute about the account's own mail domain, with the typed key", async () => {
    const seen: unknown[] = [];
    await saveMxroute(file, input("a"), (typed, domain) => {
      seen.push([typed.apiKey, domain]);
      return Promise.resolve();
    });
    expect(seen).toEqual([[KEY, "example.com"]]);
  });

  it("refuses an account whose login is not an address", async () => {
    await saveAccounts(file, [
      { ...account("plain"), imap: { ...account("plain").imap, user: "plainuser" } },
    ]);
    const check = vi.fn(ok);
    expect(await saveMxroute(file, input("plain"), check)).toBe("no-domain");
    expect(check).not.toHaveBeenCalled();
  });

  it("switches the blacklist on and off, keeps that choice when the key is replaced", async () => {
    expect(await setMxrouteEnabled(file, "a", true)).toBe("no-key");
    await saveMxroute(file, input("a"), ok);
    expect(await setMxrouteEnabled(file, "a", true)).toBe("saved");
    expect((await listMxroute(file))[0]?.enabled).toBe(true);
    await saveMxroute(file, { ...input("a"), username: "other" }, ok);
    expect((await listMxroute(file))[0]).toMatchObject({ enabled: true, username: "other" });
    expect(await setMxrouteEnabled(file, "a", false)).toBe("saved");
    expect((await listMxroute(file))[0]?.enabled).toBe(false);
    expect(await setMxrouteEnabled(file, "zzz", true)).toBe("unknown-account");
  });
});
