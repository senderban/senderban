import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AdapterError, FatalWatchError, MAX_ACCOUNTS } from "@senderban/core";
import type { AccountConfig, NewAccount } from "@senderban/core";
import type { AccountAddSteps } from "../src/add-account.js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("electron", () => ({
  safeStorage: {
    isAsyncEncryptionAvailable: () => Promise.resolve(true),
    encryptStringAsync: () => Promise.resolve(Buffer.from("opaque-cipher-bytes")),
  },
}));

const { AddAccountError, addAccountFromFile, addAccountFromForm } =
  await import("../src/add-account.js");
const { ACCOUNT_CHECK_IMAP_MS, ACCOUNT_CHECK_SIEVE_MS, checkAccount } =
  await import("../src/account-check.js");
const { loadAccounts, saveAccounts } = await import("../src/accounts-file.js");

const PASSWORD = "not-a-real-password";
const form = { address: "you@example.com", host: "mail.example.com", password: PASSWORD };
const CIPHER = Buffer.from("opaque-cipher-bytes").toString("base64");

function imapAccount(user: string, id = user): AccountConfig {
  return {
    id,
    imap: { host: "mail.example.com", port: 993, secure: true, user },
    sieve: { host: "mail.example.com", port: 4190, user },
    passwordCipher: CIPHER,
  };
}

/** The form's steps with a yes from the person, and no list entry affected. */
const steps = (
  check: AccountAddSteps["check"],
  over: Partial<AccountAddSteps> = {},
): AccountAddSteps => ({
  confirm: () => Promise.resolve(true),
  check,
  onSaved: () => Promise.resolve(false),
  signal: new AbortController().signal,
  ...over,
});

let dir: string;
let path: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "senderban-account-add-"));
  path = join(dir, "accounts.json");
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe("addAccountFromForm", () => {
  it("stores the account with the MXroute ports, encrypted, after the check", async () => {
    const check = vi.fn(() => Promise.resolve("ok" as const));
    expect(await addAccountFromForm(path, form, steps(check))).toBe("saved");
    expect(check).toHaveBeenCalledTimes(1);
    expect(await loadAccounts(path)).toEqual([imapAccount(form.address)]);
    expect(await readFile(path, "utf8")).not.toContain(PASSWORD);
  });

  it.each(["login-refused", "sieve-missing", "unreachable"] as const)(
    "stores nothing on %s",
    async (result) => {
      expect(
        await addAccountFromForm(
          path,
          form,
          steps(() => Promise.resolve(result)),
        ),
      ).toBe(result);
      expect(await loadAccounts(path)).toEqual([]);
    },
  );

  it("refuses a mailbox that is already set up before any login", async () => {
    await saveAccounts(path, [imapAccount(form.address, "other-id")]);
    const check = vi.fn(() => Promise.resolve("ok" as const));
    expect(await addAccountFromForm(path, form, steps(check))).toBe("exists");
    expect(check).not.toHaveBeenCalled();
  });

  it("refuses a mailbox that is only the ManageSieve login of another account", async () => {
    const other = imapAccount("other@example.com");
    if (!("sieve" in other)) throw new Error("not an IMAP account");
    await saveAccounts(path, [{ ...other, sieve: { ...other.sieve, user: form.address } }]);
    const check = vi.fn(() => Promise.resolve("ok" as const));
    expect(await addAccountFromForm(path, form, steps(check))).toBe("exists");
    expect(check).not.toHaveBeenCalled();
  });

  it("stores nothing when the password cannot be encrypted", async () => {
    const { safeStorage } = await import("electron");
    const encrypt = vi
      .spyOn(safeStorage, "encryptStringAsync")
      .mockRejectedValueOnce(new Error("no OS store"));
    await expect(
      addAccountFromForm(
        path,
        form,
        steps(() => Promise.resolve("ok")),
      ),
    ).rejects.toThrow();
    encrypt.mockRestore();
    expect(await loadAccounts(path)).toEqual([]);
  });

  it("refuses the same mailbox as a Gmail account, compared by mailbox", async () => {
    await saveAccounts(path, [{ id: "g", gmail: { email: "me@gmail.com" } }]);
    const check = vi.fn(() => Promise.resolve("ok" as const));
    const input = { ...form, address: "m.e@gmail.com" };
    expect(await addAccountFromForm(path, input, steps(check))).toBe("exists");
    expect(check).not.toHaveBeenCalled();
  });

  it("refuses the account past MAX_ACCOUNTS before any login", async () => {
    const full = Array.from({ length: MAX_ACCOUNTS }, (_, n) =>
      imapAccount(`user${String(n)}@example.com`),
    );
    await saveAccounts(path, full);
    const check = vi.fn(() => Promise.resolve("ok" as const));
    expect(await addAccountFromForm(path, form, steps(check))).toBe("limit");
    expect(check).not.toHaveBeenCalled();
  });

  it("reads the list again after the check: a mailbox added meanwhile is not stored twice", async () => {
    const check = async () => {
      await saveAccounts(path, [imapAccount(form.address)]);
      return "ok" as const;
    };
    expect(await addAccountFromForm(path, form, steps(check))).toBe("exists");
    expect(await loadAccounts(path)).toHaveLength(1);
  });

  it("keeps a change another writer made during the check", async () => {
    const other = imapAccount("other@example.com");
    const check = async () => {
      await saveAccounts(path, [other]);
      return "ok" as const;
    };
    expect(await addAccountFromForm(path, form, steps(check))).toBe("saved");
    expect((await loadAccounts(path)).map((a) => a.id)).toEqual([other.id, form.address]);
  });
});

describe("addAccountFromForm: the person's say", () => {
  const ok = () => Promise.resolve("ok" as const);

  it("signs in to nothing until the person said yes in the main process", async () => {
    const check = vi.fn(ok);
    const confirm = vi.fn(() => Promise.resolve(false));
    expect(await addAccountFromForm(path, form, steps(check, { confirm }))).toBe("cancelled");
    expect(confirm).toHaveBeenCalledTimes(1);
    expect(check).not.toHaveBeenCalled();
    expect(await loadAccounts(path)).toEqual([]);
  });

  it("asks nothing for a mailbox it would refuse anyway", async () => {
    await saveAccounts(path, [imapAccount(form.address)]);
    const confirm = vi.fn(() => Promise.resolve(true));
    expect(await addAccountFromForm(path, form, steps(ok, { confirm }))).toBe("exists");
    expect(confirm).not.toHaveBeenCalled();
  });

  it("stores nothing when the window closes during the check, even if the login then works", async () => {
    const abort = new AbortController();
    const check = () => {
      abort.abort();
      return Promise.resolve("ok" as const);
    };
    const onSaved = vi.fn(() => Promise.resolve(false));
    const { safeStorage } = await import("electron");
    const encrypt = vi.spyOn(safeStorage, "encryptStringAsync");
    const reply = await addAccountFromForm(
      path,
      form,
      steps(check, { signal: abort.signal, onSaved }),
    );
    const encrypted = encrypt.mock.calls.length;
    encrypt.mockRestore();
    expect(reply).toBe("cancelled");
    expect(encrypted).toBe(0);
    expect(onSaved).not.toHaveBeenCalled();
    expect(await loadAccounts(path)).toEqual([]);
  });

  it("does not start the check after the window closed during the question", async () => {
    const abort = new AbortController();
    const check = vi.fn(ok);
    const confirm = () => {
      abort.abort();
      return Promise.resolve(true);
    };
    const reply = await addAccountFromForm(
      path,
      form,
      steps(check, { confirm, signal: abort.signal }),
    );
    expect(reply).toBe("cancelled");
    expect(check).not.toHaveBeenCalled();
  });

  it("stores nothing when the window closes during the encryption", async () => {
    const { safeStorage } = await import("electron");
    const abort = new AbortController();
    const encrypt = vi.spyOn(safeStorage, "encryptStringAsync").mockImplementationOnce(() => {
      abort.abort();
      return Promise.resolve(Buffer.from("opaque-cipher-bytes"));
    });
    const reply = await addAccountFromForm(path, form, steps(ok, { signal: abort.signal }));
    encrypt.mockRestore();
    expect(reply).toBe("cancelled");
    expect(await loadAccounts(path)).toEqual([]);
  });

  it("refreshes once after a save, with the account already stored", async () => {
    const onSaved = vi.fn(async () => {
      expect(await loadAccounts(path)).toHaveLength(1);
      return false;
    });
    expect(await addAccountFromForm(path, form, steps(ok, { onSaved }))).toBe("saved");
    expect(onSaved).toHaveBeenCalledTimes(1);
  });

  it.each(["login-refused", "sieve-missing", "unreachable", "tls-refused", "cancelled"] as const)(
    "does not refresh on %s",
    async (result) => {
      const onSaved = vi.fn(() => Promise.resolve(false));
      const check = () => Promise.resolve(result);
      expect(await addAccountFromForm(path, form, steps(check, { onSaved }))).toBe(result);
      expect(onSaved).not.toHaveBeenCalled();
    },
  );

  it("says so when list entries stopped applying", async () => {
    const onSaved = () => Promise.resolve(true);
    const reply = await addAccountFromForm(path, form, steps(ok, { onSaved }));
    expect(reply).toBe("saved-own-entries");
  });
});

describe("addAccountFromFile", () => {
  const file = (id: string, user: string) => ({
    id,
    imap: { host: "mail.example.com", port: 993, secure: true, user },
    sieve: { host: "mail.example.com", port: 4190, user },
    password: PASSWORD,
  });

  it("refuses the same mailbox under a new id: two lanes must not share one Sieve script", async () => {
    await saveAccounts(path, [imapAccount("you@example.com", "first")]);
    const input = join(dir, "new.json");
    await writeFile(input, JSON.stringify(file("second", "you@example.com")));
    await expect(addAccountFromFile(input, path)).rejects.toBeInstanceOf(AddAccountError);
    expect((await stat(input)).isFile()).toBe(true);
    expect(await loadAccounts(path)).toHaveLength(1);
  });

  it("refuses an id that ends like a lane id", async () => {
    const input = join(dir, "new.json");
    await writeFile(input, JSON.stringify(file("you@example.com.mxroute", "you@example.com")));
    await expect(addAccountFromFile(input, path)).rejects.toThrow("failed validation");
  });
});

describe("checkAccount", () => {
  const account = {
    id: form.address,
    imap: { host: form.host, port: 993, secure: true, user: form.address },
    sieve: { host: form.host, port: 4190, user: form.address },
    password: PASSWORD,
  } satisfies NewAccount;
  const ok = () => Promise.resolve();
  const refused = new FatalWatchError("authentication failed", {
    cause: { authenticationFailed: true },
  });

  it("answers ok only when both logins worked, IMAP first", async () => {
    const order: string[] = [];
    const reply = await checkAccount(account, {
      imap: () => {
        order.push("imap");
        return Promise.resolve();
      },
      sieve: () => {
        order.push("sieve");
        return Promise.resolve();
      },
    });
    expect(reply).toBe("ok");
    expect(order).toEqual(["imap", "sieve"]);
  });

  it("says a refused IMAP login, and never tries ManageSieve after it", async () => {
    const sieve = vi.fn(ok);
    const imap = () => Promise.reject(refused);
    expect(await checkAccount(account, { imap, sieve })).toBe("login-refused");
    expect(sieve).not.toHaveBeenCalled();
  });

  it("does not call another fatal IMAP answer a refused password", async () => {
    const imap = () => Promise.reject(new FatalWatchError("server did not report UIDNEXT"));
    expect(await checkAccount(account, { imap, sieve: ok })).toBe("unreachable");
  });

  it("gives up on a login that never answers, at the deadline of each step", async () => {
    vi.useFakeTimers();
    try {
      const hung = () => new Promise<void>(() => undefined);
      const imap = checkAccount(account, { imap: hung, sieve: ok });
      await vi.advanceTimersByTimeAsync(ACCOUNT_CHECK_IMAP_MS);
      expect(await imap).toBe("unreachable");
      const sieve = checkAccount(account, { imap: ok, sieve: hung });
      await vi.advanceTimersByTimeAsync(ACCOUNT_CHECK_SIEVE_MS);
      expect(await sieve).toBe("sieve-missing");
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it("tells a refused certificate from a dead server, on either login", async () => {
    const tls = Object.assign(new Error("certificate"), { code: "CERT_HAS_EXPIRED" });
    const imap = () => Promise.reject(tls);
    const sieve = () => Promise.reject(new AdapterError("TRANSIENT", "TLS error", { cause: tls }));
    expect(await checkAccount(account, { imap, sieve: ok })).toBe("tls-refused");
    expect(await checkAccount(account, { imap: ok, sieve })).toBe("tls-refused");
  });

  it("hands each probe a signal that ends at the deadline, so its socket closes with the answer", async () => {
    vi.useFakeTimers();
    try {
      let seen: AbortSignal | undefined;
      const sieve = (_: NewAccount, signal: AbortSignal) => {
        seen = signal;
        return new Promise<void>(() => undefined);
      };
      const reply = checkAccount(account, { imap: ok, sieve });
      await vi.advanceTimersByTimeAsync(ACCOUNT_CHECK_SIEVE_MS);
      expect(await reply).toBe("sieve-missing");
      expect(seen?.aborted).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it("answers cancelled at once when the person gives up, on either login", async () => {
    const hung = () => new Promise<void>(() => undefined);
    for (const probes of [
      { imap: hung, sieve: ok },
      { imap: ok, sieve: hung },
    ]) {
      const abort = new AbortController();
      const reply = checkAccount(account, probes, { signal: abort.signal });
      await Promise.resolve();
      await Promise.resolve();
      abort.abort();
      expect(await reply).toBe("cancelled");
    }
  });

  it("reports each step's cost, and whether it ran out of time", async () => {
    vi.useFakeTimers();
    try {
      const stages: string[] = [];
      const reply = checkAccount(
        account,
        { imap: ok, sieve: () => new Promise<void>(() => undefined) },
        {
          onStage: (stage) => {
            stages.push(`${stage.stage}:${String(stage.timedOut)}`);
          },
        },
      );
      await vi.advanceTimersByTimeAsync(ACCOUNT_CHECK_SIEVE_MS);
      await reply;
      expect(stages).toEqual(["imap:false", "sieve:true"]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("calls a network failure unreachable", async () => {
    const imap = () => Promise.reject(new Error("ECONNREFUSED"));
    expect(await checkAccount(account, { imap, sieve: ok })).toBe("unreachable");
  });

  it("tells a refused ManageSieve login from a server without ManageSieve", async () => {
    const auth = () => Promise.reject(new AdapterError("AUTH_REQUIRED", "refused"));
    const gone = () => Promise.reject(new AdapterError("TRANSIENT", "connection error"));
    expect(await checkAccount(account, { imap: ok, sieve: auth })).toBe("login-refused");
    expect(await checkAccount(account, { imap: ok, sieve: gone })).toBe("sieve-missing");
  });
});

describe("the page's sentences", () => {
  it("has one for every word main can answer", async () => {
    const page = await readFile(join(import.meta.dirname, "../assets/manage/accounts.js"), "utf8");
    const words = [
      "saved",
      "saved-own-entries",
      "exists",
      "limit",
      "login-refused",
      "sieve-missing",
      "unreachable",
      "tls-refused",
      "cancelled",
      "busy",
      "invalid",
      "denied",
      "failed",
    ];
    for (const word of words) {
      expect(page).toMatch(new RegExp(`^  "?${word}"?: \\[`, "mu"));
    }
  });
});
