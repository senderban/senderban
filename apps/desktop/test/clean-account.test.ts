import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FatalWatchError, MAX_ACCOUNTS } from "@senderban/core";
import type { AccountConfig, CleanAddInput, NewCleanAccount } from "@senderban/core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AccountAddSteps } from "../src/add-account.js";

vi.mock("electron", () => ({
  safeStorage: {
    isAsyncEncryptionAvailable: () => Promise.resolve(true),
    encryptStringAsync: () => Promise.resolve(Buffer.from("opaque-cipher-bytes")),
  },
}));

const { addCleanFromForm } = await import("../src/add-account.js");
const { checkCleanAccount } = await import("../src/account-check.js");
const { loadAccounts, saveAccounts } = await import("../src/accounts-file.js");
const { dropCleanAccount, removeCleanAccount } = await import("../src/remove-account.js");
const { collectOwnMail } = await import("../src/own-mail.js");

const CIPHER = Buffer.from("opaque-cipher-bytes").toString("base64");
const form: CleanAddInput = {
  address: "you@example.com",
  host: "imap.example.com",
  port: 993,
  password: "app-password",
};
const stored = (address = "you@example.com"): AccountConfig => ({
  id: address,
  clean: { address, host: "imap.example.com", port: 993, secure: true, user: address },
  passwordCipher: CIPHER,
});
const account: NewCleanAccount = {
  id: "you@example.com",
  clean: {
    address: "you@example.com",
    host: "imap.example.com",
    port: 993,
    secure: true,
    user: "you@example.com",
  },
  password: "app-password",
};

const steps = (
  over: Partial<AccountAddSteps<NewCleanAccount>> = {},
): AccountAddSteps<NewCleanAccount> => ({
  confirm: () => Promise.resolve(true),
  check: () => Promise.resolve("ok"),
  onSaved: () => Promise.resolve(false),
  signal: new AbortController().signal,
  ...over,
});

let dir: string;
let path: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "senderban-clean-"));
  path = join(dir, "accounts.json");
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe("addCleanFromForm", () => {
  it("stores the account with ciphertext only", async () => {
    expect(await addCleanFromForm(path, form, steps())).toBe("saved");
    const [saved] = await loadAccounts(path);
    expect(saved).toMatchObject({ id: "you@example.com", passwordCipher: CIPHER });
    expect(JSON.stringify(saved)).not.toContain("app-password");
  });

  it("stores nothing without the person's yes, and signs in to nothing", async () => {
    const check = vi.fn(() => Promise.resolve("ok" as const));
    const result = await addCleanFromForm(
      path,
      form,
      steps({ confirm: () => Promise.resolve(false), check }),
    );
    expect(result).toBe("cancelled");
    expect(check).not.toHaveBeenCalled();
    expect(await loadAccounts(path)).toEqual([]);
  });

  it("hands back why the check failed and stores nothing", async () => {
    const check = () => Promise.resolve("cannot-move" as const);
    expect(await addCleanFromForm(path, form, steps({ check }))).toBe("cannot-move");
    expect(await loadAccounts(path)).toEqual([]);
  });

  it("refuses a mailbox that is already set up, in any kind", async () => {
    await saveAccounts(path, [
      {
        id: "other",
        gmail: { email: "you@example.com" },
      },
    ]);
    expect(await addCleanFromForm(path, form, steps())).toBe("exists");
  });

  it("refuses past the account limit", async () => {
    const many = Array.from({ length: MAX_ACCOUNTS }, (_, i) =>
      stored(`u${String(i)}@example.com`),
    );
    await saveAccounts(path, many);
    expect(await addCleanFromForm(path, form, steps())).toBe("limit");
  });

  it("stops when the window closed during the check", async () => {
    const abort = new AbortController();
    const check = () => {
      abort.abort();
      return Promise.resolve("ok" as const);
    };
    const result = await addCleanFromForm(path, form, steps({ check, signal: abort.signal }));
    expect(result).toBe("cancelled");
    expect(await loadAccounts(path)).toEqual([]);
  });
});

describe("checkCleanAccount", () => {
  it("is ok only when the mailbox can move mail", async () => {
    expect(await checkCleanAccount(account, () => Promise.resolve(true))).toBe("ok");
    expect(await checkCleanAccount(account, () => Promise.resolve(false))).toBe("cannot-move");
  });

  it("gives a fixed word for a refused login and for anything else", async () => {
    const refused = new FatalWatchError("authentication failed", {
      cause: { authenticationFailed: true },
    });
    expect(await checkCleanAccount(account, () => Promise.reject(refused))).toBe("login-refused");
    expect(await checkCleanAccount(account, () => Promise.reject(new Error("no")))).toBe(
      "unreachable",
    );
  });

  it("answers cancelled once the person gave up", async () => {
    const abort = new AbortController();
    abort.abort();
    const result = await checkCleanAccount(account, () => Promise.reject(new Error("x")), {
      signal: abort.signal,
    });
    expect(result).toBe("cancelled");
  });

  it("logs the stage with no address in it", async () => {
    const stages: unknown[] = [];
    await checkCleanAccount(account, () => Promise.resolve(true), {
      onStage: (stage) => stages.push(stage),
    });
    expect(stages).toMatchObject([{ stage: "imap", timedOut: false }]);
    expect(JSON.stringify(stages)).not.toContain("example");
  });
});

describe("removeCleanAccount", () => {
  const removal = (over = {}) => ({
    confirm: () => Promise.resolve(true),
    retire: vi.fn(() => Promise.resolve()),
    onRemoved: vi.fn(() => Promise.resolve()),
    ...over,
  });

  it("takes the account off the file, then stops the lane", async () => {
    await saveAccounts(path, [stored(), stored("other@example.com")]);
    const steps = removal();
    expect(await removeCleanAccount(path, "you@example.com", steps)).toBe("removed");
    expect((await loadAccounts(path)).map((a) => a.id)).toEqual(["other@example.com"]);
    expect(steps.retire).toHaveBeenCalledWith("you@example.com");
    expect(steps.onRemoved).toHaveBeenCalledTimes(1);
  });

  it("changes nothing without a yes", async () => {
    await saveAccounts(path, [stored()]);
    const steps = removal({ confirm: () => Promise.resolve(false) });
    expect(await removeCleanAccount(path, "you@example.com", steps)).toBe("cancelled");
    expect(await loadAccounts(path)).toHaveLength(1);
    expect(steps.retire).not.toHaveBeenCalled();
  });

  it("knows only its own kind", async () => {
    await saveAccounts(path, [{ id: "g", gmail: { email: "g@example.com" } }]);
    expect(await removeCleanAccount(path, "g", removal())).toBe("unknown-account");
  });
});

describe("dropCleanAccount", () => {
  it("stops everything, and forgets the state after the last round", async () => {
    const retire = vi.fn();
    const stop = vi.fn(() => Promise.resolve());
    const forgetAccount = vi.fn();
    const dropAccount = vi.fn();
    let finish = (): void => undefined;
    const round = new Promise<void>((resolve) => {
      finish = resolve;
    });
    const live = {
      cleanLanes: new Map([["a", { retire }]]),
      lanes: ["a", "b"],
      labels: new Map([["a", "a@example.com"]]),
      pending: { dropAccount },
      store: { forgetAccount, forgetCursor: vi.fn() },
      settled: () => round,
      watchers: new Map([["a", { stop }]]),
      states: new Map<string, unknown>([["a", "watching"]]),
    };
    dropCleanAccount("a", live);
    expect(retire).toHaveBeenCalledTimes(1);
    expect(stop).toHaveBeenCalledTimes(1);
    expect(dropAccount).toHaveBeenCalledWith("a");
    expect(live.lanes).toEqual(["b"]);
    expect(live.labels.size).toBe(0);
    expect(live.states.size).toBe(0);
    expect(forgetAccount).not.toHaveBeenCalled();
    finish();
    await vi.waitFor(() => {
      expect(forgetAccount).toHaveBeenCalledWith("a");
    });
  });
});

describe("collectOwnMail", () => {
  it("counts a cleaning account's address, and its domain unless it is shared", () => {
    const own = collectOwnMail([stored("me@mydomain.example"), stored("me@icloud.com")]);
    expect(own.addresses.has("me@mydomain.example")).toBe(true);
    expect(own.addresses.has("me@icloud.com")).toBe(true);
    expect(own.domains.has("mydomain.example")).toBe(true);
    expect(own.domains.has("icloud.com")).toBe(false);
  });
});
