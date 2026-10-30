import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
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

const {
  blacklistOutlives,
  keysFromAccounts,
  listMxroute,
  loadMxrouteKeys,
  migrateMxrouteKeys,
  mxrouteGroups,
  strandedOnBlacklist,
  removeMxroute,
  saveMxroute,
  setMxrouteEnabled,
} = await import("../src/mxroute-settings.js");
const { AdapterError, isImapAccount } = await import("@senderban/core");
const { loadAccounts, saveAccounts } = await import("../src/accounts-file.js");

const account = (id: string, domain = "example.com") => ({
  id,
  imap: { host: "mail.example.com", port: 993, secure: true, user: `${id}@${domain}` },
  sieve: { host: "mail.example.com", port: 4190, user: `${id}@${domain}` },
  passwordCipher: "AAECAw==",
});
// The key check talks to MXroute; tests give it a stand-in.
const ok = () => Promise.resolve();
const yes = () => Promise.resolve(true);
const KEY = "test-mxroute-key-not-real-0000";
const login = { server: "mx.example.net", username: "exampleuser" };
const input = { ...login, apiKey: KEY };
const onDomain = (domain: string, enabled: boolean) => ({ ...login, domain, enabled });

let dir: string;
let file: string;
let keys: string;
const seed = (stored: unknown[]) => writeFile(keys, JSON.stringify({ version: 1, keys: stored }));
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "senderban-mxroute-"));
  file = join(dir, "accounts.json");
  keys = join(dir, "mxroute-keys.json");
  await saveAccounts(file, [account("a"), account("b")]);
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe("MXroute key storage", () => {
  it("stores only ciphertext, in its own file, and shows the page no key", async () => {
    const accountsBefore = await readFile(file, "utf8");
    expect(await saveMxroute(keys, input, ok)).toBe("saved");
    const onDisk = await readFile(keys, "utf8");
    expect(onDisk).not.toContain(KEY);
    expect(onDisk).toContain("apiKeyCipher");
    expect(await readFile(file, "utf8")).toBe(accountsBefore);

    const page = await listMxroute(keys, file);
    expect(page.keys).toEqual([{ ...login, domains: [{ domain: "example.com", enabled: false }] }]);
    expect(page.accounts).toEqual([
      { accountId: "a", label: "a@example.com" },
      { accountId: "b", label: "b@example.com" },
    ]);
    expect(JSON.stringify(page)).not.toContain("apiKeyCipher");
    expect(JSON.stringify(page)).not.toContain(KEY);
  });

  it("works with no mailbox set up at all: a key belongs to the login", async () => {
    await saveAccounts(file, []);
    expect(await saveMxroute(keys, input, ok)).toBe("saved");
    expect((await listMxroute(keys, file)).keys).toEqual([{ ...login, domains: [] }]);
  });

  it("replaces the key of the same login and keeps its domains", async () => {
    await saveMxroute(keys, input, ok);
    await setMxrouteEnabled(keys, file, onDomain("example.com", true), ok);
    const [before] = await loadMxrouteKeys(keys);
    await saveMxroute(keys, { ...input, apiKey: "another-key-not-real-1111" }, ok);
    const stored = await loadMxrouteKeys(keys);
    expect(stored).toHaveLength(1);
    expect(stored[0]?.apiKeyCipher).not.toBe(before?.apiKeyCipher);
    expect(stored[0]?.domains).toEqual([{ domain: "example.com", enabled: true }]);
  });

  it("keeps a second login apart", async () => {
    await saveMxroute(keys, input, ok);
    await saveMxroute(keys, { ...input, username: "other" }, ok);
    expect((await loadMxrouteKeys(keys)).map((k) => k.username)).toEqual(["exampleuser", "other"]);
  });

  it("removes a key on request and touches no mailbox", async () => {
    await saveMxroute(keys, input, ok);
    const accountsBefore = await readFile(file, "utf8");
    expect(await removeMxroute(keys, file, login, yes)).toBe("saved");
    expect(await loadMxrouteKeys(keys)).toEqual([]);
    expect(await readFile(keys, "utf8")).not.toContain("apiKeyCipher");
    expect(await readFile(file, "utf8")).toBe(accountsBefore);
  });

  it("takes a copy left inside a mailbox with it, so the next start cannot bring the key back", async () => {
    await saveMxroute(keys, input, ok);
    const legacy = { ...login, apiKeyCipher: "AAECAw==", enabled: true };
    const otherLogin = { ...legacy, username: "other" };
    await saveAccounts(file, [
      { ...account("a"), mxroute: legacy },
      { ...account("b"), mxroute: otherLogin },
    ]);
    expect(await removeMxroute(keys, file, login, yes)).toBe("saved");
    const left = (await loadAccounts(file)).filter(isImapAccount);
    expect(left[0]?.mxroute).toBeUndefined();
    expect(left[1]?.mxroute).toEqual(otherLogin);
    expect(keysFromAccounts(left.slice(0, 1), await loadMxrouteKeys(keys))).toEqual([]);
  });

  it("keeps the key when the person says no", async () => {
    await saveMxroute(keys, input, ok);
    expect(await removeMxroute(keys, file, login, () => Promise.resolve(false))).toBe("cancelled");
    expect(await loadMxrouteKeys(keys)).toHaveLength(1);
  });

  it("answers for a key that went while the question was open", async () => {
    await saveMxroute(keys, input, ok);
    const reply = await removeMxroute(keys, file, login, async () => {
      await removeMxroute(keys, file, login, yes);
      return true;
    });
    expect(reply).toBe("unknown-key");
  });

  it("refuses a key that is not there and writes nothing", async () => {
    await saveMxroute(keys, input, ok);
    const before = await readFile(keys, "utf8");
    const other = { ...login, username: "zzz" };
    const ask = vi.fn(yes);
    expect(await removeMxroute(keys, file, other, ask)).toBe("unknown-key");
    expect(ask).not.toHaveBeenCalled();
    expect(
      await setMxrouteEnabled(keys, file, { ...onDomain("example.com", true), ...other }),
    ).toBe("unknown-key");
    expect(await readFile(keys, "utf8")).toBe(before);
  });

  it("does not lose a key when two are saved at the same time", async () => {
    await Promise.all([
      saveMxroute(keys, input, ok),
      saveMxroute(keys, { ...input, username: "other" }, ok),
    ]);
    expect(await loadMxrouteKeys(keys)).toHaveLength(2);
  });

  it("does not store a key that MXroute refuses or cannot be asked about", async () => {
    const refused = () => Promise.reject(new AdapterError("AUTH_REQUIRED", "refused"));
    const down = () => Promise.reject(new AdapterError("TRANSIENT", "busy"));
    const odd = () => Promise.reject(new Error("boom"));
    expect(await saveMxroute(keys, input, refused)).toBe("key-refused");
    expect(await saveMxroute(keys, input, down)).toBe("unreachable");
    expect(await saveMxroute(keys, input, odd)).toBe("unreachable");
    expect(await loadMxrouteKeys(keys)).toEqual([]);
  });

  it("refuses a further key at the limit", async () => {
    // Written in one go: 50 saves are 50 flushes to disk, too slow for a loaded machine.
    await seed(
      Array.from({ length: 50 }, (_, i) => ({
        ...login,
        username: `user${String(i)}`,
        apiKeyCipher: "AAECAw==",
        domains: [],
      })),
    );
    expect(await saveMxroute(keys, input, ok)).toBe("full");
    expect(await saveMxroute(keys, { ...input, username: "user0" }, ok)).toBe("saved");
    expect(await loadMxrouteKeys(keys)).toHaveLength(50);
  });

  it("reads a key file that is not valid as an error, and a missing one as no key", async () => {
    expect(await loadMxrouteKeys(keys)).toEqual([]);
    await writeFile(keys, JSON.stringify({ version: 1, keys: [{ ...login, secret: KEY }] }));
    await expect(loadMxrouteKeys(keys)).rejects.toThrow("failed validation");
  });

  it("still lists the mailboxes when the key file cannot be read", async () => {
    await writeFile(keys, "not json");
    const page = await listMxroute(keys, file);
    expect(page.keysUnreadable).toBe(true);
    expect(page.accounts).toHaveLength(2);
  });
});

describe("switching a domain's blacklist", () => {
  beforeEach(async () => {
    await saveMxroute(keys, input, ok);
  });

  it("asks MXroute once, with the stored key, the first time a domain goes on", async () => {
    const check = vi.fn(ok);
    await setMxrouteEnabled(keys, file, onDomain("example.com", true), check);
    expect(check).toHaveBeenCalledTimes(1);
    expect(check.mock.calls[0]).toEqual([
      expect.objectContaining({ username: "exampleuser" }),
      "example.com",
    ]);
    await setMxrouteEnabled(keys, file, onDomain("example.com", false), check);
    await setMxrouteEnabled(keys, file, onDomain("example.com", true), check);
    expect(check).toHaveBeenCalledTimes(1);
  });

  it("keeps a switched-off domain on the key, so its lane can take back what it added", async () => {
    await setMxrouteEnabled(keys, file, onDomain("example.com", true), ok);
    await setMxrouteEnabled(keys, file, onDomain("example.com", false), ok);
    expect((await loadMxrouteKeys(keys))[0]?.domains).toEqual([
      { domain: "example.com", enabled: false },
    ]);
  });

  it("writes nothing for switching off a domain the key never held", async () => {
    const before = await readFile(keys, "utf8");
    const check = vi.fn(ok);
    expect(await setMxrouteEnabled(keys, file, onDomain("example.com", false), check)).toBe(
      "saved",
    );
    expect(check).not.toHaveBeenCalled();
    expect(await readFile(keys, "utf8")).toBe(before);
  });

  it("does not take a domain from the page without a mailbox on it", async () => {
    const check = vi.fn(ok);
    expect(await setMxrouteEnabled(keys, file, onDomain("elsewhere.example", true), check)).toBe(
      "unknown-domain",
    );
    expect(check).not.toHaveBeenCalled();
  });

  it("does not let two keys hold one domain", async () => {
    await setMxrouteEnabled(keys, file, onDomain("example.com", true), ok);
    await saveMxroute(keys, { ...input, username: "other" }, ok);
    const check = vi.fn(ok);
    expect(
      await setMxrouteEnabled(
        keys,
        file,
        { ...onDomain("example.com", true), username: "other" },
        check,
      ),
    ).toBe("unknown-domain");
    expect(check).not.toHaveBeenCalled();
  });

  it("answers in words when another key took the domain during the check", async () => {
    await saveMxroute(keys, { ...input, username: "other" }, ok);
    const reply = await setMxrouteEnabled(keys, file, onDomain("example.com", true), async () => {
      await setMxrouteEnabled(
        keys,
        file,
        { ...onDomain("example.com", true), username: "other" },
        ok,
      );
    });
    expect(reply).toBe("unknown-domain");
  });

  it("does not attach a domain this key cannot reach", async () => {
    const refused = () => Promise.reject(new AdapterError("AUTH_REQUIRED", "refused"));
    const down = () => Promise.reject(new AdapterError("TRANSIENT", "busy"));
    expect(await setMxrouteEnabled(keys, file, onDomain("example.com", true), refused)).toBe(
      "key-refused",
    );
    expect(await setMxrouteEnabled(keys, file, onDomain("example.com", true), down)).toBe(
      "unreachable",
    );
    expect((await loadMxrouteKeys(keys))[0]?.domains).toEqual([]);
  });

  it("refuses a further domain at the limit", async () => {
    await seed([
      {
        ...login,
        apiKeyCipher: "AAECAw==",
        domains: Array.from({ length: 50 }, (_, i) => ({
          domain: `d${String(i)}.example.com`,
          enabled: true,
        })),
      },
    ]);
    await saveAccounts(file, [account("late", "late.example.com")]);
    expect(await setMxrouteEnabled(keys, file, onDomain("late.example.com", true), ok)).toBe(
      "full",
    );
    expect((await loadMxrouteKeys(keys))[0]?.domains).toHaveLength(50);
  });
});

describe("unreadable files", () => {
  const MARK = "fragment-of-the-file";

  it("never quotes a damaged key file in the error", async () => {
    await writeFile(keys, `{"version":1,"keys":${MARK}`);
    const failure: unknown = await loadMxrouteKeys(keys).catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(Error);
    expect((failure as Error).message).not.toContain("fragment");
  });

  it("never quotes a damaged accounts file in the error", async () => {
    await writeFile(file, `{"version":1,"accounts":${MARK}`);
    const failure: unknown = await loadAccounts(file).catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(Error);
    expect((failure as Error).message).not.toContain("fragment");
  });
});

describe("strandedOnBlacklist", () => {
  const VALUE = "x@sender.example";
  const state = (applied: string[]) => ({
    adapterId: "mxroute",
    data: {
      domain: "example.com",
      applied: applied.map((value) => ({
        id: "6f1c1a52-7f0e-4c55-9d2a-3b0f4a9e1c10",
        match: "exactAddress",
        value,
        action: "reject",
        createdAt: "2026-10-30T00:00:00.000Z",
      })),
      rejected: [],
    },
  });
  const held = (id: string) => (id === "a.mxroute" ? state([VALUE]) : undefined);

  it("is true when a lane that is gone had put the address there", () => {
    expect(strandedOnBlacklist(VALUE, ["a", "b"], ["a", "b"], held)).toBe(true);
  });

  it("is false while the lane runs: it takes the address off itself", () => {
    expect(strandedOnBlacklist(VALUE, ["a", "b"], ["a", "a.mxroute", "b"], held)).toBe(false);
  });

  it("is false for an address the lane never held, or no lane at all", () => {
    expect(strandedOnBlacklist("y@sender.example", ["a"], ["a"], held)).toBe(false);
    expect(strandedOnBlacklist(VALUE, ["a"], ["a"], () => undefined)).toBe(false);
  });

  it("says so when the record cannot be read", () => {
    const broken = () => ({ adapterId: "mxroute", data: { nonsense: true } });
    expect(strandedOnBlacklist(VALUE, ["a"], ["a"], broken)).toBe(true);
  });
});

describe("mxrouteGroups", () => {
  const key = (domains: { domain: string; enabled: boolean }[], username = "exampleuser") => ({
    ...login,
    username,
    apiKeyCipher: "AAECAw==",
    domains,
  });

  it("gives a domain one lane, owned by its first mailbox, for every mailbox on it", () => {
    const groups = mxrouteGroups(
      [key([{ domain: "example.com", enabled: true }])],
      [account("a"), account("b"), account("c", "example.org")],
    );
    expect(groups.get("a")).toMatchObject({
      owner: "a",
      domain: "example.com",
      members: ["a", "b"],
      mirror: true,
    });
    expect(groups.get("b")).toBe(groups.get("a"));
    expect(groups.has("c")).toBe(false);
  });

  it("leaves the lane with the mailbox that has its record", () => {
    const groups = mxrouteGroups(
      [key([{ domain: "example.com", enabled: true }])],
      [account("a"), account("b")],
      (id) => id === "b",
    );
    expect(groups.get("a")?.owner).toBe("b");
    expect(groups.get("a")?.members).toEqual(["a", "b"]);
  });

  it("hands the lane to the next mailbox once the first is gone", () => {
    const groups = mxrouteGroups([key([{ domain: "example.com", enabled: true }])], [account("b")]);
    expect(groups.get("b")).toMatchObject({ owner: "b", members: ["b"] });
  });

  it("runs a switched-off domain as a lane that does not mirror", () => {
    const groups = mxrouteGroups(
      [key([{ domain: "example.com", enabled: false }])],
      [account("a")],
    );
    expect(groups.get("a")?.mirror).toBe(false);
  });

  it("starts no lane for a domain with no mailbox, and still sees the domains after it", () => {
    expect(mxrouteGroups([key([{ domain: "example.com", enabled: true }])], []).size).toBe(0);
    const groups = mxrouteGroups(
      [
        key([
          { domain: "example.org", enabled: true },
          { domain: "example.com", enabled: true },
        ]),
      ],
      [account("a")],
    );
    expect(groups.get("a")?.domain).toBe("example.com");
  });
});

describe("blacklistOutlives", () => {
  beforeEach(async () => {
    await saveMxroute(keys, input, ok);
    await setMxrouteEnabled(keys, file, onDomain("example.com", true), ok);
  });

  it("is false while another mailbox is on the domain", async () => {
    await saveAccounts(file, [account("b")]);
    expect(await blacklistOutlives(keys, file, account("a"))).toBe(false);
  });

  it("is true for the last mailbox on the domain", async () => {
    await saveAccounts(file, []);
    expect(await blacklistOutlives(keys, file, account("a"))).toBe(true);
  });

  it("is false for a domain no key holds", async () => {
    await saveAccounts(file, []);
    expect(await blacklistOutlives(keys, file, account("a", "example.org"))).toBe(false);
  });
});

describe("moving keys out of the mailboxes (0.1.2 and older)", () => {
  const legacy = (
    id: string,
    enabled: boolean,
    domain = "example.com",
    username = "exampleuser",
  ) => ({
    ...account(id, domain),
    mxroute: { ...login, username, apiKeyCipher: `QUJD${id}A==`.slice(0, 8), enabled },
  });

  it("moves the key and the choice, drops them from the mailbox, and keeps the rest", async () => {
    const gmail = { id: "g", gmail: { email: "me@gmail.com", refreshCipher: "AAECAw==" } };
    await saveAccounts(file, [legacy("a", true), gmail]);
    expect(await migrateMxrouteKeys(keys, file)).toBe(1);

    expect(await loadMxrouteKeys(keys)).toEqual([
      {
        ...login,
        apiKeyCipher: legacy("a", true).mxroute.apiKeyCipher,
        domains: [{ domain: "example.com", enabled: true }],
      },
    ]);
    const after = await loadAccounts(file);
    expect(after).toEqual([account("a"), gmail]);
  });

  it("writes no key file when no mailbox holds a key", async () => {
    expect(await migrateMxrouteKeys(keys, file)).toBe(0);
    await expect(readFile(keys, "utf8")).rejects.toThrow("ENOENT");
  });

  it("does nothing the second time", async () => {
    await saveAccounts(file, [legacy("a", true)]);
    await migrateMxrouteKeys(keys, file);
    const before = await readFile(keys, "utf8");
    expect(await migrateMxrouteKeys(keys, file)).toBe(0);
    expect(await readFile(keys, "utf8")).toBe(before);
  });

  it("merges mailboxes of one login: one key, on when any of them was on", async () => {
    await saveAccounts(file, [
      legacy("a", false),
      legacy("b", true),
      legacy("c", false, "example.org"),
    ]);
    await migrateMxrouteKeys(keys, file);
    const stored = await loadMxrouteKeys(keys);
    expect(stored).toHaveLength(1);
    expect(stored[0]?.apiKeyCipher).toBe(legacy("a", false).mxroute.apiKeyCipher);
    expect(stored[0]?.domains).toEqual([
      { domain: "example.com", enabled: true },
      { domain: "example.org", enabled: false },
    ]);
  });

  it("keeps two logins apart and gives a shared domain to the first", () => {
    const moved = keysFromAccounts(
      [legacy("a", true), legacy("b", true, "example.com", "other")].filter(isImapAccount),
      [],
    );
    expect(moved.map((k) => k.username)).toEqual(["exampleuser", "other"]);
    expect(moved[1]?.domains).toEqual([]);
  });

  it("turns a shared domain on when the second login had it on", () => {
    const moved = keysFromAccounts(
      [legacy("a", false), legacy("b", true, "example.com", "other")].filter(isImapAccount),
      [],
    );
    expect(moved[0]?.domains).toEqual([{ domain: "example.com", enabled: true }]);
    expect(moved[1]?.domains).toEqual([]);
  });

  it("does not switch a domain back on that the key file has off", () => {
    const stored = {
      ...login,
      apiKeyCipher: "AAECAw==",
      domains: [{ domain: "example.com", enabled: false }],
    };
    const moved = keysFromAccounts([legacy("a", true)].filter(isImapAccount), [stored]);
    expect(moved[0]?.domains).toEqual([{ domain: "example.com", enabled: false }]);
  });

  it("merges into a key file left by a start that stopped halfway, and finishes the job", async () => {
    await saveAccounts(file, [legacy("a", true)]);
    await saveMxroute(keys, input, ok);
    const [kept] = await loadMxrouteKeys(keys);
    expect(await migrateMxrouteKeys(keys, file)).toBe(1);
    const stored = await loadMxrouteKeys(keys);
    expect(stored).toHaveLength(1);
    expect(stored[0]?.apiKeyCipher).toBe(kept?.apiKeyCipher);
    expect(stored[0]?.domains).toEqual([{ domain: "example.com", enabled: true }]);
    expect((await loadAccounts(file)).filter(isImapAccount)[0]?.mxroute).toBeUndefined();
  });

  it("keeps a mailbox's key when the key file cannot be read", async () => {
    await saveAccounts(file, [legacy("a", true)]);
    await writeFile(keys, "not json");
    await expect(migrateMxrouteKeys(keys, file)).rejects.toThrow();
    expect((await loadAccounts(file)).filter(isImapAccount)[0]?.mxroute).toBeDefined();
  });
});
