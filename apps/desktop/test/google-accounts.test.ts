import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { GoogleDeps } from "../src/google-accounts.js";
import type { OAuthClient } from "@senderban/core";
import type { SignInOptions, SignInResult } from "@senderban/core/node";

// A stand-in for the OS store: reversible, and never the plaintext, so a test can tell if one leaks to disk.
vi.mock("electron", () => ({
  safeStorage: {
    isAsyncEncryptionAvailable: () => Promise.resolve(true),
    encryptStringAsync: (plain: string) => Promise.resolve(Buffer.from(plain, "utf8").reverse()),
    decryptStringAsync: (data: Buffer) =>
      Promise.resolve({ result: Buffer.from(data).reverse().toString("utf8") }),
  },
}));

const { AdapterError, canRejectSender, isGmailAccount } = await import("@senderban/core");
const { collectOwnMail, createOwnMail } = await import("../src/own-mail.js");
const { decryptPassword, encryptPassword, loadAccounts, saveAccounts, serialized } =
  await import("../src/accounts-file.js");
const { loadGoogleClient, saveGoogleClient } = await import("../src/google-client.js");
const {
  MAX_CONCURRENT_REVOKES,
  cancelGoogleSignIn,
  googleState,
  removeGoogleAccount,
  saveGoogleClientSettings,
  signInGoogle,
} = await import("../src/google-accounts.js");

// Built at run time: a whole client ID in the source trips GitHub push protection, and these are fakes.
const fakeClientId = (project: string, name: string) =>
  [`${project}-${name}`, "apps", "googleusercontent", "com"].join(".");
const OLD_ID = fakeClientId("111111111111", "oldclient");
const NEW_ID = fakeClientId("222222222222", "newclient");
const SECRET = ["GOCSPX", "the-client-secret-0123456789"].join("-");
const TOKEN = "1//refresh-token-of-me";

let dir: string;
let accountsPath: string;
let clientPath: string;
let signInFake: ReturnType<typeof vi.fn<(options: SignInOptions) => Promise<SignInResult>>>;
let revoke: ReturnType<typeof vi.fn<(token: string) => Promise<"revoked" | "already-invalid">>>;
let madeFor: string[];
let deps: GoogleDeps;

const signedIn = (email: string, refreshToken = TOKEN, extra = {}): SignInResult => ({
  status: "signed-in",
  refreshToken,
  email,
  historyId: "1",
  ...extra,
});

const gmailAccount = async (id: string, email: string, token: string | null) => ({
  id,
  gmail: {
    email,
    ...(token === null ? {} : { refreshCipher: await encryptPassword(token) }),
  },
});

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "senderban-google-"));
  accountsPath = join(dir, "accounts.json");
  clientPath = join(dir, "google-client.json");
  signInFake = vi.fn(() => Promise.resolve(signedIn("me@gmail.com")));
  revoke = vi.fn(() => Promise.resolve("revoked" as const));
  madeFor = [];
  deps = {
    accountsPath,
    clientPath,
    makeOAuth: (clientId) => {
      madeFor.push(clientId);
      return { revoke } as unknown as OAuthClient;
    },
    signIn: signInFake,
    openBrowser: () => Promise.resolve(),
  };
  await saveGoogleClient(clientPath, OLD_ID, SECRET);
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe("sign in", () => {
  it("stores a new account with the token as ciphertext only", async () => {
    const outcome = await signInGoogle(deps, {});
    expect(outcome).toEqual({ reply: "signed-in" });

    const onDisk = await readFile(accountsPath, "utf8");
    expect(onDisk).not.toContain(TOKEN);
    expect(onDisk).toContain("refreshCipher");
    const [account] = await loadAccounts(accountsPath);
    expect(account && isGmailAccount(account) ? account.gmail.email : null).toBe("me@gmail.com");
    expect(account?.id).toMatch(/^gmail-[0-9a-f]{8}$/u);
    // The page gets the address and a flag, nothing else.
    expect(JSON.stringify(await googleState(deps))).not.toMatch(/Cipher|1\/\/|GOCSPX/u);
  });

  it("hands the sign-in the stored client and a secret read from its ciphertext", async () => {
    await signInGoogle(deps, {});
    const options = signInFake.mock.calls[0]?.[0];
    expect(options?.clientId).toBe(OLD_ID);
    expect(options?.expectEmail).toBeUndefined();
    expect(madeFor).toEqual([OLD_ID]);
    const client = await loadGoogleClient(clientPath);
    expect(await decryptPassword(client?.secretCipher ?? "")).toBe(SECRET);
    expect(await readFile(clientPath, "utf8")).not.toContain(SECRET);
  });

  it("says when Google limits the access in time", async () => {
    signInFake.mockResolvedValue(
      signedIn("me@gmail.com", TOKEN, { refreshTokenExpiresInSeconds: 604_799 }),
    );
    expect(await signInGoogle(deps, {})).toEqual({ reply: "signed-in", accessEndsInDays: 7 });
  });

  it("needs a client first and does not open the browser without one", async () => {
    await rm(clientPath);
    expect(await signInGoogle(deps, {})).toEqual({ reply: "no-client" });
    expect(signInFake).not.toHaveBeenCalled();
  });

  it.each([
    [{ status: "cancelled" }, "cancelled"],
    [{ status: "timeout" }, "timeout"],
    [{ status: "aborted" }, "aborted"],
    [{ status: "busy" }, "busy"],
    [{ status: "browser-failed" }, "browser-failed"],
    [{ status: "scope", reason: "extra-scope" }, "scope"],
    [{ status: "wrong-account" }, "wrong-account"],
    [{ status: "failed", code: "REJECTED" }, "client-refused"],
    [{ status: "failed", code: "AUTH_REQUIRED" }, "client-refused"],
    [{ status: "failed", code: "TRANSIENT" }, "unreachable"],
    [{ status: "failed", code: "QUOTA_EXCEEDED" }, "unreachable"],
  ] as const)("stores nothing when the sign-in ends as %j", async (result, reply) => {
    signInFake.mockResolvedValue(result);
    expect(await signInGoogle(deps, {})).toEqual({ reply });
    expect(await loadAccounts(accountsPath)).toEqual([]);
  });

  it("refuses a mailbox that is already set up, in any of Gmail's spellings, and does not revoke", async () => {
    await saveAccounts(accountsPath, [await gmailAccount("g1", "me@gmail.com", TOKEN)]);
    signInFake.mockResolvedValue(signedIn("m.e@googlemail.com"));
    expect(await signInGoogle(deps, {})).toEqual({ reply: "duplicate" });
    expect((await loadAccounts(accountsPath)).length).toBe(1);
    // Revoking would remove the grant of the account that is already set up.
    expect(revoke).not.toHaveBeenCalled();
  });

  it("refuses a mailbox that an IMAP login already uses", async () => {
    await saveAccounts(accountsPath, [
      {
        id: "imap",
        imap: { host: "mail.example.com", port: 993, secure: true, user: "me@gmail.com" },
        sieve: { host: "mail.example.com", port: 4190, user: "me@gmail.com" },
        passwordCipher: "AAECAw==",
      },
    ]);
    expect(await signInGoogle(deps, {})).toEqual({ reply: "duplicate" });
  });

  it("refuses a 51st account", async () => {
    await saveAccounts(
      accountsPath,
      await Promise.all(
        Array.from({ length: 50 }, (_, i) =>
          gmailAccount(`g${String(i)}`, `user${String(i)}@gmail.com`, TOKEN),
        ),
      ),
    );
    expect(await signInGoogle(deps, {})).toEqual({ reply: "full" });
  });

  it("signs an existing account in again, bound to its own address", async () => {
    await saveAccounts(accountsPath, [await gmailAccount("g1", "me@gmail.com", null)]);
    signInFake.mockResolvedValue(signedIn("me@gmail.com", "1//new-token"));
    expect(await signInGoogle(deps, { accountId: "g1" })).toEqual({ reply: "signed-in" });
    expect(signInFake.mock.calls[0]?.[0].expectEmail).toBe("me@gmail.com");
    const [account] = await loadAccounts(accountsPath);
    expect(account && isGmailAccount(account) && account.gmail.refreshCipher).toBeTruthy();
    expect((await googleState(deps)).accounts).toEqual([
      {
        accountId: "g1",
        email: "me@gmail.com",
        signedIn: true,
        expired: false,
        accessEndsAt: null,
      },
    ]);
    expect(await readFile(accountsPath, "utf8")).not.toContain("1//new-token");
  });

  it("keeps an account as it was when the re-sign-in ends in another mailbox", async () => {
    await saveAccounts(accountsPath, [await gmailAccount("g1", "me@gmail.com", TOKEN)]);
    const before = await readFile(accountsPath, "utf8");
    signInFake.mockResolvedValue({ status: "wrong-account" });
    expect(await signInGoogle(deps, { accountId: "g1" })).toEqual({ reply: "wrong-account" });
    expect(await readFile(accountsPath, "utf8")).toBe(before);
  });

  it("does not sign in an account that is not there", async () => {
    expect(await signInGoogle(deps, { accountId: "missing" })).toEqual({
      reply: "unknown-account",
    });
    expect(signInFake).not.toHaveBeenCalled();
  });

  it("answers busy to a second step while one runs, and frees the slot afterwards", async () => {
    let finish: (value: SignInResult) => void = () => undefined;
    signInFake.mockReturnValueOnce(
      new Promise<SignInResult>((resolve) => {
        finish = resolve;
      }),
    );
    const first = signInGoogle(deps, {});
    await vi.waitFor(() => {
      expect(signInFake).toHaveBeenCalled();
    });
    expect(await signInGoogle(deps, {})).toEqual({ reply: "busy" });
    expect(
      await saveGoogleClientSettings(deps, {
        clientId: NEW_ID,
        clientSecret: SECRET,
        confirmSignOut: true,
      }),
    ).toBe("busy");
    finish(signedIn("me@gmail.com"));
    expect(await first).toEqual({ reply: "signed-in" });
    expect(await signInGoogle(deps, { accountId: "none" })).toEqual({ reply: "unknown-account" });
  });
});

describe("the app-wide client", () => {
  it("saves the first client with the secret as ciphertext", async () => {
    await rm(clientPath);
    const reply = await saveGoogleClientSettings(deps, {
      clientId: NEW_ID,
      clientSecret: SECRET,
      confirmSignOut: false,
    });
    expect(reply).toBe("saved");
    expect((await loadGoogleClient(clientPath))?.clientId).toBe(NEW_ID);
    expect(await readFile(clientPath, "utf8")).not.toContain(SECRET);
  });

  it("keeps the tokens when only the secret changes", async () => {
    await saveAccounts(accountsPath, [await gmailAccount("g1", "me@gmail.com", TOKEN)]);
    const reply = await saveGoogleClientSettings(deps, {
      clientId: OLD_ID,
      clientSecret: ["GOCSPX", "a-new-secret-for-the-same-client"].join("-"),
      confirmSignOut: false,
    });
    expect(reply).toBe("saved");
    expect(revoke).not.toHaveBeenCalled();
    expect((await googleState(deps)).accounts[0]?.signedIn).toBe(true);
  });

  it("asks before another client signs the accounts out, and changes nothing until told", async () => {
    await saveAccounts(accountsPath, [await gmailAccount("g1", "me@gmail.com", TOKEN)]);
    const before = await readFile(accountsPath, "utf8");
    const reply = await saveGoogleClientSettings(deps, {
      clientId: NEW_ID,
      clientSecret: SECRET,
      confirmSignOut: false,
    });
    expect(reply).toBe("needs-confirm");
    expect(revoke).not.toHaveBeenCalled();
    expect(await readFile(accountsPath, "utf8")).toBe(before);
    expect((await loadGoogleClient(clientPath))?.clientId).toBe(OLD_ID);
  });

  it("revokes with the old client, signs the accounts out, then saves the new client", async () => {
    await saveAccounts(accountsPath, [
      await gmailAccount("g1", "me@gmail.com", TOKEN),
      await gmailAccount("g2", "you@gmail.com", "1//second"),
      await gmailAccount("g3", "out@gmail.com", null),
    ]);
    const reply = await saveGoogleClientSettings(deps, {
      clientId: NEW_ID,
      clientSecret: SECRET,
      confirmSignOut: true,
    });
    expect(reply).toBe("saved");
    expect(madeFor).toEqual([OLD_ID]);
    expect(revoke.mock.calls.map(([token]) => token).sort()).toEqual([
      "1//refresh-token-of-me",
      "1//second",
    ]);
    expect((await googleState(deps)).accounts.map((a) => a.signedIn)).toEqual([
      false,
      false,
      false,
    ]);
    expect((await googleState(deps)).accounts.map((a) => a.email)).toEqual([
      "me@gmail.com",
      "you@gmail.com",
      "out@gmail.com",
    ]);
    expect((await loadGoogleClient(clientPath))?.clientId).toBe(NEW_ID);
  });

  it("leaves the client as it was when a revoke fails, and signs out only the accounts that were revoked", async () => {
    await saveAccounts(accountsPath, [
      await gmailAccount("g1", "me@gmail.com", TOKEN),
      await gmailAccount("g2", "you@gmail.com", "1//second"),
    ]);
    revoke.mockImplementation((token) =>
      token === "1//second"
        ? Promise.reject(new AdapterError("TRANSIENT", "Google could not be reached (revoke)"))
        : Promise.resolve("revoked"),
    );
    const reply = await saveGoogleClientSettings(deps, {
      clientId: NEW_ID,
      clientSecret: SECRET,
      confirmSignOut: true,
    });
    expect(reply).toBe("revoke-failed");
    expect((await loadGoogleClient(clientPath))?.clientId).toBe(OLD_ID);
    expect((await googleState(deps)).accounts.map((a) => a.signedIn)).toEqual([false, true]);
  });

  it("revokes at most MAX_CONCURRENT_REVOKES tokens at a time", async () => {
    await saveAccounts(
      accountsPath,
      await Promise.all(
        Array.from({ length: 12 }, (_, i) =>
          gmailAccount(`g${String(i)}`, `user${String(i)}@gmail.com`, `1//token-${String(i)}`),
        ),
      ),
    );
    let running = 0;
    let peak = 0;
    revoke.mockImplementation(async () => {
      running += 1;
      peak = Math.max(peak, running);
      await new Promise((resolve) => setTimeout(resolve, 5));
      running -= 1;
      return "revoked";
    });
    const reply = await saveGoogleClientSettings(deps, {
      clientId: NEW_ID,
      clientSecret: SECRET,
      confirmSignOut: true,
    });
    expect(reply).toBe("saved");
    expect(revoke).toHaveBeenCalledTimes(12);
    expect(peak).toBe(MAX_CONCURRENT_REVOKES);
  });
});

describe("remove an account", () => {
  it("revokes the token, then deletes the account", async () => {
    await saveAccounts(accountsPath, [
      await gmailAccount("g1", "me@gmail.com", TOKEN),
      await gmailAccount("g2", "you@gmail.com", "1//second"),
    ]);
    expect(await removeGoogleAccount(deps, "g1")).toBe("removed");
    expect(revoke).toHaveBeenCalledWith(TOKEN);
    expect((await loadAccounts(accountsPath)).map((a) => a.id)).toEqual(["g2"]);
  });

  it("counts Google's 'already invalid' as gone", async () => {
    await saveAccounts(accountsPath, [await gmailAccount("g1", "me@gmail.com", TOKEN)]);
    revoke.mockResolvedValue("already-invalid");
    expect(await removeGoogleAccount(deps, "g1")).toBe("removed");
  });

  it("keeps the account and its token when the revoke fails", async () => {
    await saveAccounts(accountsPath, [await gmailAccount("g1", "me@gmail.com", TOKEN)]);
    revoke.mockRejectedValue(new AdapterError("TRANSIENT", "Google could not be reached (revoke)"));
    expect(await removeGoogleAccount(deps, "g1")).toBe("revoke-failed");
    expect((await googleState(deps)).accounts[0]?.signedIn).toBe(true);
  });

  it("keeps a token it cannot revoke because the client is gone", async () => {
    await saveAccounts(accountsPath, [await gmailAccount("g1", "me@gmail.com", TOKEN)]);
    await rm(clientPath);
    expect(await removeGoogleAccount(deps, "g1")).toBe("revoke-failed");
    expect((await loadAccounts(accountsPath)).length).toBe(1);
  });

  it("removes a signed-out account without calling Google, and does not say it revoked anything", async () => {
    await saveAccounts(accountsPath, [await gmailAccount("g1", "me@gmail.com", null)]);
    expect(await removeGoogleAccount(deps, "g1")).toBe("removed-not-revoked");
    expect(revoke).not.toHaveBeenCalled();
  });

  it("knows no account it does not have", async () => {
    expect(await removeGoogleAccount(deps, "nope")).toBe("unknown-account");
  });
});

describe("races and cancel", () => {
  const imapAccount = {
    id: "imap",
    imap: { host: "mail.example.com", port: 993, secure: true, user: "me@example.com" },
    sieve: { host: "mail.example.com", port: 4190, user: "me@example.com" },
    passwordCipher: "AAECAw==",
  };

  it("shares one queue with the other writers of accounts.json: neither change is lost", async () => {
    // What an MXroute key save does: read, wait, write the whole file back. A sign-in store at the same time
    // must wait its turn, or whichever writes last wins.
    const slow = serialized(async () => {
      const accounts = await loadAccounts(accountsPath);
      await new Promise((resolve) => setTimeout(resolve, 80));
      await saveAccounts(accountsPath, [...accounts, imapAccount]);
    });
    const outcome = signInGoogle(deps, {});
    await Promise.all([slow, outcome]);
    expect((await outcome).reply).toBe("signed-in");
    const ids = (await loadAccounts(accountsPath)).map((a) => a.id);
    expect(ids).toContain("imap");
    expect(ids.some((id) => id.startsWith("gmail-"))).toBe(true);
  });

  it("frees the slot when a step throws", async () => {
    signInFake.mockRejectedValueOnce(new Error("boom"));
    await expect(signInGoogle(deps, {})).rejects.toThrow("boom");
    expect(await signInGoogle(deps, { accountId: "none" })).toEqual({ reply: "unknown-account" });
  });

  it("cancels the waiting sign-in, and a refused second call does not take its place", async () => {
    let seen: AbortSignal | undefined;
    signInFake.mockImplementationOnce(
      (options) =>
        new Promise<SignInResult>((resolve) => {
          seen = options.signal;
          options.signal?.addEventListener("abort", () => {
            resolve({ status: "aborted" });
          });
        }),
    );
    const first = signInGoogle(deps, {});
    await vi.waitFor(() => {
      expect(seen).toBeDefined();
    });
    // The second call is turned away; Cancel must still stop the FIRST one.
    expect(await signInGoogle(deps, {})).toEqual({ reply: "busy" });
    expect(seen?.aborted).toBe(false);
    cancelGoogleSignIn();
    expect(seen?.aborted).toBe(true);
    expect(await first).toEqual({ reply: "aborted" });
    // Nothing waits any more: a cancel now is a no-op.
    expect(() => {
      cancelGoogleSignIn();
    }).not.toThrow();
  });

  it("turns a removal away while a sign-in waits", async () => {
    await saveAccounts(accountsPath, [await gmailAccount("g1", "me@gmail.com", TOKEN)]);
    let finish: (value: SignInResult) => void = () => undefined;
    signInFake.mockReturnValueOnce(
      new Promise<SignInResult>((resolve) => {
        finish = resolve;
      }),
    );
    const first = signInGoogle(deps, { accountId: "g1" });
    await vi.waitFor(() => {
      expect(signInFake).toHaveBeenCalled();
    });
    expect(await removeGoogleAccount(deps, "g1")).toBe("busy");
    expect(revoke).not.toHaveBeenCalled();
    finish({ status: "cancelled" });
    await first;
  });

  it("revokes a removed account's token with the stored client", async () => {
    await saveAccounts(accountsPath, [await gmailAccount("g1", "me@gmail.com", TOKEN)]);
    await removeGoogleAccount(deps, "g1");
    expect(madeFor).toEqual([OLD_ID]);
  });

  it("sees a mailbox that only the Sieve login names", async () => {
    await saveAccounts(accountsPath, [
      {
        ...imapAccount,
        imap: { ...imapAccount.imap, user: "other@example.com" },
        sieve: { ...imapAccount.sieve, user: "me@gmail.com" },
      },
    ]);
    expect(await signInGoogle(deps, {})).toEqual({ reply: "duplicate" });
  });
});

describe("a client file that cannot be read", () => {
  it("shows as no client, so the page can save one over it", async () => {
    await writeFile(clientPath, "{ not json");
    expect((await googleState(deps)).client).toBeNull();
    const reply = await saveGoogleClientSettings(deps, {
      clientId: NEW_ID,
      clientSecret: SECRET,
      confirmSignOut: false,
    });
    expect(reply).toBe("saved");
    expect((await loadGoogleClient(clientPath))?.clientId).toBe(NEW_ID);
  });

  it("signs the accounts out after a confirmation, without a revoke it cannot make, and says so", async () => {
    await saveAccounts(accountsPath, [await gmailAccount("g1", "me@gmail.com", TOKEN)]);
    await writeFile(clientPath, "{ not json");
    const input = { clientId: NEW_ID, clientSecret: SECRET, confirmSignOut: false };
    expect(await saveGoogleClientSettings(deps, input)).toBe("needs-confirm");
    expect(await saveGoogleClientSettings(deps, { ...input, confirmSignOut: true })).toBe(
      "saved-left-access",
    );
    expect(revoke).not.toHaveBeenCalled();
    expect((await googleState(deps)).accounts[0]?.signedIn).toBe(false);
    expect((await loadGoogleClient(clientPath))?.clientId).toBe(NEW_ID);
  });
});

describe("access that ends (Google's 7 days in Testing)", () => {
  const DAY = 86_400_000;
  const T0 = 1_800_000_000_000;

  it("keeps the date of the sign-in and shows the account as expired once it has passed", async () => {
    deps = { ...deps, now: () => T0 };
    signInFake.mockResolvedValue(
      signedIn("me@gmail.com", TOKEN, { refreshTokenExpiresInSeconds: 604_799 }),
    );
    expect(await signInGoogle(deps, {})).toEqual({ reply: "signed-in", accessEndsInDays: 7 });

    const endsAt = T0 / 1000 + 604_799;
    let [account] = (await googleState(deps)).accounts;
    expect(account).toMatchObject({ signedIn: true, expired: false, accessEndsAt: endsAt });

    deps = { ...deps, now: () => T0 + 6 * DAY };
    [account] = (await googleState(deps)).accounts;
    expect(account?.expired).toBe(false);
    deps = { ...deps, now: () => T0 + 8 * DAY };
    [account] = (await googleState(deps)).accounts;
    expect(account).toMatchObject({ signedIn: true, expired: true, accessEndsAt: endsAt });
  });

  it("drops the old date when the new sign-in has none (Google no longer limits it)", async () => {
    deps = { ...deps, now: () => T0 };
    signInFake.mockResolvedValue(
      signedIn("me@gmail.com", TOKEN, { refreshTokenExpiresInSeconds: 604_799 }),
    );
    await signInGoogle(deps, {});
    const id = (await googleState(deps)).accounts[0]?.accountId ?? "";
    signInFake.mockResolvedValue(signedIn("me@gmail.com", "1//unlimited"));
    await signInGoogle(deps, { accountId: id });
    expect((await googleState(deps)).accounts[0]).toMatchObject({
      signedIn: true,
      expired: false,
      accessEndsAt: null,
    });
  });
});

describe("what listens to accounts.json changes", () => {
  it("is told after a sign-in is stored, accounts are signed out, and an account is removed", async () => {
    const told = vi.fn();
    deps = { ...deps, onAccountsChanged: told };
    await signInGoogle(deps, {});
    expect(told).toHaveBeenCalledTimes(1);

    const id = (await googleState(deps)).accounts[0]?.accountId ?? "";
    await saveGoogleClientSettings(deps, {
      clientId: NEW_ID,
      clientSecret: SECRET,
      confirmSignOut: true,
    });
    expect(told).toHaveBeenCalledTimes(2);

    await removeGoogleAccount(deps, id);
    expect(told).toHaveBeenCalledTimes(3);
  });

  it("is not told when nothing was stored", async () => {
    const told = vi.fn();
    deps = { ...deps, onAccountsChanged: told };
    signInFake.mockResolvedValue({ status: "cancelled" });
    await signInGoogle(deps, {});
    await removeGoogleAccount(deps, "none");
    expect(told).not.toHaveBeenCalled();
  });

  it("does not turn a stored sign-in into an error when the listener throws", async () => {
    deps = {
      ...deps,
      onAccountsChanged: () => Promise.reject(new Error("boom")),
    };
    expect(await signInGoogle(deps, {})).toEqual({ reply: "signed-in" });
    expect((await loadAccounts(accountsPath)).length).toBe(1);
  });
});

describe("a client file that is there but cannot be read right now", () => {
  it("is not 'unreadable': nothing is signed out, the client file is untouched, the step fails", async () => {
    await saveAccounts(accountsPath, [await gmailAccount("g1", "me@gmail.com", TOKEN)]);
    // A directory where the file should be: stat works, reading it fails with an I/O error (like a locked file).
    await rm(clientPath);
    await mkdir(clientPath);
    const before = await readFile(accountsPath, "utf8");
    await expect(
      saveGoogleClientSettings(deps, {
        clientId: NEW_ID,
        clientSecret: SECRET,
        confirmSignOut: true,
      }),
    ).rejects.toThrow();
    expect(revoke).not.toHaveBeenCalled();
    expect(await readFile(accountsPath, "utf8")).toBe(before);
    // The page says it could not load, not "no client".
    await expect(googleState(deps)).rejects.toThrow();
  });
});

describe("the never-refuse set follows a Gmail sign-in made after start-up (security FLAG-1)", () => {
  it("stops offering 'Block at server' for the new address and its spellings, and keeps them after a failed refresh", async () => {
    const own = createOwnMail(collectOwnMail([]), () => loadAccounts(accountsPath));
    deps = { ...deps, onAccountsChanged: () => own.refresh() };
    // Before the sign-in the address is nobody's: a forged mail from it could be refused.
    expect(canRejectSender("me@gmail.com", own.get())).toBe(true);

    expect(await signInGoogle(deps, {})).toEqual({ reply: "signed-in" });
    for (const forged of ["me@gmail.com", "m.e@gmail.com", "me+x@gmail.com", "me@googlemail.com"]) {
      expect(canRejectSender(forged, own.get())).toBe(false);
    }
    expect(canRejectSender("someone-else@gmail.com", own.get())).toBe(true);

    // A read that fails does not shrink the set.
    await writeFile(accountsPath, "{ not json");
    await expect(own.refresh()).rejects.toThrow();
    expect(canRejectSender("me@gmail.com", own.get())).toBe(false);
  });
});

describe("Gmail filters before a token is revoked", () => {
  type Prepared = "ready" | "filters-left" | "unreachable" | "restart-cures";
  let calls: string[];
  let answers: Record<string, Prepared>;
  const lifecycle = () => ({
    classify: (id: string) => {
      return answers[id] === "restart-cures" ? ("restart-cures" as const) : ("lane" as const);
    },
    prepare: (id: string) => {
      calls.push(`prepare:${id}`);
      return Promise.resolve(answers[id] ?? "ready");
    },
    abort: (id: string) => {
      calls.push(`abort:${id}`);
    },
    done: (id: string, why: string) => {
      calls.push(`done:${id}:${why}`);
    },
  });
  beforeEach(() => {
    calls = [];
    answers = {};
    revoke.mockImplementation((token) => {
      calls.push(`revoke:${token}`);
      return Promise.resolve("revoked" as const);
    });
    deps = { ...deps, filters: lifecycle() };
  });

  it("removal: the filters are deleted first, then the token is revoked, then the lane is retired", async () => {
    await saveAccounts(accountsPath, [await gmailAccount("g1", "me@gmail.com", TOKEN)]);
    expect(await removeGoogleAccount(deps, "g1")).toBe("removed");
    expect(calls).toEqual(["prepare:g1", `revoke:${TOKEN}`, "done:g1:removed"]);
  });

  it("removal: filters that could not be deleted keep the account, revoke nothing and let the lane write again", async () => {
    await saveAccounts(accountsPath, [await gmailAccount("g1", "me@gmail.com", TOKEN)]);
    answers["g1"] = "filters-left";
    expect(await removeGoogleAccount(deps, "g1")).toBe("filters-left");
    expect(calls).toEqual(["prepare:g1", "abort:g1"]);
    expect((await googleState(deps)).accounts[0]?.signedIn).toBe(true);
  });

  it("removal: filters it cannot reach are said so, and the account still goes", async () => {
    await saveAccounts(accountsPath, [await gmailAccount("g1", "me@gmail.com", null)]);
    answers["g1"] = "unreachable";
    expect(await removeGoogleAccount(deps, "g1")).toBe("removed-filters-remain");
    expect(calls).toEqual(["prepare:g1", "done:g1:removed"]);
    expect(await loadAccounts(accountsPath)).toEqual([]);
  });

  it("removal: a revoke that fails, or a client that is gone, lets the lane write again and keeps the account", async () => {
    await saveAccounts(accountsPath, [await gmailAccount("g1", "me@gmail.com", TOKEN)]);
    revoke.mockRejectedValue(new AdapterError("TRANSIENT", "Google could not be reached (revoke)"));
    expect(await removeGoogleAccount(deps, "g1")).toBe("revoke-failed");
    await rm(clientPath);
    expect(await removeGoogleAccount(deps, "g1")).toBe("revoke-failed");
    expect(calls).toEqual(["prepare:g1", "abort:g1", "prepare:g1", "abort:g1"]);
    expect((await loadAccounts(accountsPath)).length).toBe(1);
  });

  it("removal: an account it does not know is not prepared", async () => {
    expect(await removeGoogleAccount(deps, "nope")).toBe("unknown-account");
    expect(calls).toEqual([]);
  });

  it("another client: every signed-in account is prepared before the first revoke", async () => {
    await saveAccounts(accountsPath, [
      await gmailAccount("g1", "me@gmail.com", TOKEN),
      await gmailAccount("g2", "you@gmail.com", "1//second"),
      await gmailAccount("g3", "out@gmail.com", null),
    ]);
    const reply = await saveGoogleClientSettings(deps, {
      clientId: NEW_ID,
      clientSecret: SECRET,
      confirmSignOut: true,
    });
    expect(reply).toBe("saved");
    const firstRevoke = calls.findIndex((c) => c.startsWith("revoke:"));
    expect(calls.slice(0, firstRevoke)).toEqual(["prepare:g1", "prepare:g2"]);
    expect(calls.filter((c) => c.startsWith("done:")).sort()).toEqual([
      "done:g1:signed-out",
      "done:g2:signed-out",
    ]);
  });

  it("another client: one account whose filters cannot be deleted stops the change before anything is revoked", async () => {
    await saveAccounts(accountsPath, [
      await gmailAccount("g1", "me@gmail.com", TOKEN),
      await gmailAccount("g2", "you@gmail.com", "1//second"),
    ]);
    const before = await readFile(accountsPath, "utf8");
    answers["g2"] = "filters-left";
    const reply = await saveGoogleClientSettings(deps, {
      clientId: NEW_ID,
      clientSecret: SECRET,
      confirmSignOut: true,
    });
    expect(reply).toBe("filters-left");
    expect(calls).toEqual(["prepare:g1", "prepare:g2", "abort:g1", "abort:g2"]);
    expect(revoke).not.toHaveBeenCalled();
    expect(await readFile(accountsPath, "utf8")).toBe(before);
    expect((await loadGoogleClient(clientPath))?.clientId).toBe(OLD_ID);
  });

  it("another client: filters it cannot reach (the access has ended) are said so after the sign-out", async () => {
    const ended = await gmailAccount("g1", "me@gmail.com", TOKEN);
    await saveAccounts(accountsPath, [
      { ...ended, gmail: { ...ended.gmail, accessEndsAt: 1_000_000_001 } },
    ]);
    answers["g1"] = "unreachable";
    expect(
      await saveGoogleClientSettings(deps, {
        clientId: NEW_ID,
        clientSecret: SECRET,
        confirmSignOut: true,
      }),
    ).toBe("saved-filters-remain");
  });

  it("another client: an account whose revoke fails keeps its lane, the others are retired", async () => {
    await saveAccounts(accountsPath, [
      await gmailAccount("g1", "me@gmail.com", TOKEN),
      await gmailAccount("g2", "you@gmail.com", "1//second"),
    ]);
    revoke.mockImplementation((token) =>
      token === TOKEN
        ? Promise.reject(new AdapterError("TRANSIENT", "Google could not be reached (revoke)"))
        : Promise.resolve("revoked" as const),
    );
    const reply = await saveGoogleClientSettings(deps, {
      clientId: NEW_ID,
      clientSecret: SECRET,
      confirmSignOut: true,
    });
    expect(reply).toBe("revoke-failed");
    expect(calls).toContain("abort:g1");
    expect(calls).toContain("done:g2:signed-out");
    expect(calls).not.toContain("done:g1:signed-out");
  });

  it("another client: a lane a restart would build for an account whose access has ended does not stop the change; the filters are said to remain", async () => {
    const ended = await gmailAccount("g1", "me@gmail.com", TOKEN);
    await saveAccounts(accountsPath, [
      { ...ended, gmail: { ...ended.gmail, accessEndsAt: 1_000_000_001 } },
    ]);
    answers["g1"] = "restart-cures";
    expect(
      await saveGoogleClientSettings(deps, {
        clientId: NEW_ID,
        clientSecret: SECRET,
        confirmSignOut: true,
      }),
    ).toBe("saved-filters-remain");
  });

  it("removal: a restart cannot cure it (an expired token, or no token): the account goes and the filters are said to remain", async () => {
    const ended = await gmailAccount("g1", "me@gmail.com", TOKEN);
    await saveAccounts(accountsPath, [
      { ...ended, gmail: { ...ended.gmail, accessEndsAt: 1_000_000_001 } },
    ]);
    answers["g1"] = "restart-cures";
    expect(await removeGoogleAccount(deps, "g1")).toBe("removed-filters-remain");
  });

  it("removal: filters it cannot reach with a token that still works need a restart first, and nothing changes", async () => {
    await saveAccounts(accountsPath, [await gmailAccount("g1", "me@gmail.com", TOKEN)]);
    answers["g1"] = "restart-cures";
    expect(await removeGoogleAccount(deps, "g1")).toBe("restart-first");
    expect(revoke).not.toHaveBeenCalled();
    expect((await loadAccounts(accountsPath)).length).toBe(1);
    expect(calls).toEqual(["prepare:g1"]);
  });

  it("removal: a prepare that throws, or a client file that throws, lets the lane write again", async () => {
    await saveAccounts(accountsPath, [await gmailAccount("g1", "me@gmail.com", TOKEN)]);
    deps = {
      ...deps,
      filters: {
        ...lifecycle(),
        prepare: () => Promise.reject(new Error("state unreadable")),
      },
    };
    await expect(removeGoogleAccount(deps, "g1")).rejects.toThrow("state unreadable");
    expect(calls).toEqual(["abort:g1"]);

    calls.length = 0;
    deps = { ...deps, filters: lifecycle() };
    await writeFile(clientPath, "not json");
    await expect(removeGoogleAccount(deps, "g1")).rejects.toBeInstanceOf(Error);
    expect(calls).toEqual(["prepare:g1", "abort:g1"]);
    expect((await loadAccounts(accountsPath)).length).toBe(1);
  });

  it("another client: filters it cannot reach with a token that still works need a restart first", async () => {
    await saveAccounts(accountsPath, [
      await gmailAccount("g1", "me@gmail.com", TOKEN),
      await gmailAccount("g2", "you@gmail.com", "1//second"),
    ]);
    answers["g2"] = "restart-cures";
    const before = await readFile(accountsPath, "utf8");
    const reply = await saveGoogleClientSettings(deps, {
      clientId: NEW_ID,
      clientSecret: SECRET,
      confirmSignOut: true,
    });
    expect(reply).toBe("restart-first");
    // Decided before the first filter of any account is deleted: no account was prepared, so nothing needs writing again.
    expect(calls.some((c) => c.startsWith("prepare:") || c.startsWith("abort:"))).toBe(false);
    expect(revoke).not.toHaveBeenCalled();
    expect(await readFile(accountsPath, "utf8")).toBe(before);
    expect((await loadGoogleClient(clientPath))?.clientId).toBe(OLD_ID);
  });

  it("another client: a prepare that throws on one account lets every prepared lane write again", async () => {
    await saveAccounts(accountsPath, [
      await gmailAccount("g1", "me@gmail.com", TOKEN),
      await gmailAccount("g2", "you@gmail.com", "1//second"),
    ]);
    deps = {
      ...deps,
      filters: {
        ...lifecycle(),
        prepare: (id: string) =>
          id === "g2"
            ? Promise.reject(new Error("state unreadable"))
            : Promise.resolve("ready" as const),
      },
    };
    await expect(
      saveGoogleClientSettings(deps, {
        clientId: NEW_ID,
        clientSecret: SECRET,
        confirmSignOut: true,
      }),
    ).rejects.toThrow("state unreadable");
    expect(calls.sort()).toEqual(["abort:g1", "abort:g2"]);
    expect(revoke).not.toHaveBeenCalled();
  });

  it("another client, the old one unreadable: the lanes follow once the file says signed out, and both gaps are said", async () => {
    await saveAccounts(accountsPath, [await gmailAccount("g1", "me@gmail.com", TOKEN)]);
    await writeFile(clientPath, "not json");
    answers["g1"] = "unreachable";
    const reply = await saveGoogleClientSettings(deps, {
      clientId: NEW_ID,
      clientSecret: SECRET,
      confirmSignOut: true,
    });
    expect(reply).toBe("saved-left-access-filters-remain");
    expect(calls).toEqual(["prepare:g1", "done:g1:signed-out"]);
  });
});
