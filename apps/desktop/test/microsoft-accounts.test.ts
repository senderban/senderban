import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { MicrosoftSignInOptions, MicrosoftSignInResult } from "@senderban/core/node";
import type { MicrosoftOAuthClient, OpaqueState } from "@senderban/core";
import type { MicrosoftDeps } from "../src/microsoft-accounts.js";

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
  AdapterError,
  GraphBudgets,
  GRAPH_RULES_URL,
  graphLaneId,
  initialGraphState,
  isMicrosoftAccount,
} = await import("@senderban/core");
const { encryptPassword, decryptPassword, loadAccounts, saveAccounts } =
  await import("../src/accounts-file.js");
const { collectOwnMail } = await import("../src/own-mail.js");
const {
  MICROSOFT_CLIENT_ID,
  cancelMicrosoftSignIn,
  microsoftClientId,
  microsoftState,
  removeMicrosoftAccount,
  signInMicrosoftAccount,
  storeRefreshToken,
} = await import("../src/microsoft-accounts.js");
const {
  buildMicrosoftLanes,
  createMicrosoftLifecycle,
  microsoftSkippedNote,
  microsoftWideNote,
  outlookCover,
} = await import("../src/microsoft-lanes.js");

const CLIENT = "00000000-1111-2222-3333-444444444444";
const TOKEN = "M.C123_BL2.0.U.refresh-token-of-me";
const EMAIL = "me@outlook.example";
const USER = "0123456789abcdef";

let dir: string;
let path: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "senderban-ms-"));
  path = join(dir, "accounts.json");
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

const noOAuth = {} as MicrosoftOAuthClient;
function deps(
  over: Partial<MicrosoftDeps> = {},
  result: MicrosoftSignInResult = {
    status: "signed-in",
    refreshToken: TOKEN,
    email: EMAIL,
    userId: USER,
  },
): MicrosoftDeps {
  return {
    accountsPath: path,
    clientId: CLIENT,
    makeOAuth: () => noOAuth,
    signIn: () => Promise.resolve(result),
    openBrowser: () => Promise.resolve(),
    ...over,
  };
}
const stored = async () => (await loadAccounts(path)).filter(isMicrosoftAccount);
const withAccount = async (id = "ms-1", email = EMAIL) => {
  await saveAccounts(path, [
    { id, microsoft: { email, userId: USER, refreshCipher: await encryptPassword(TOKEN) } },
  ]);
};

describe("the client ID", () => {
  it("ships empty, so the button is off until Senderban's registration exists", () => {
    expect(MICROSOFT_CLIENT_ID).toBe("");
    expect(microsoftClientId()).toBeNull();
  });

  it("takes only a GUID", () => {
    expect(microsoftClientId(CLIENT)).toBe(CLIENT);
    expect(microsoftClientId("not-one")).toBeNull();
  });
});

describe("signing in", () => {
  it("stores the token as ciphertext only, with the address from Microsoft", async () => {
    await expect(signInMicrosoftAccount(deps(), {})).resolves.toBe("signed-in");
    const [account] = await stored();
    expect(account?.id).toMatch(/^ms-[0-9a-f]{8}$/u);
    expect(account?.microsoft.email).toBe(EMAIL);
    expect(await readFile(path, "utf8")).not.toContain(TOKEN);
    expect(await decryptPassword(account?.microsoft.refreshCipher ?? "")).toBe(TOKEN);
  });

  it("does not start without a client, and says so", async () => {
    const signIn = vi.fn();
    await expect(signInMicrosoftAccount(deps({ clientId: null, signIn }), {})).resolves.toBe(
      "no-client",
    );
    expect(signIn).not.toHaveBeenCalled();
  });

  it.each([
    [{ status: "cancelled" }, "cancelled"],
    [{ status: "timeout" }, "timeout"],
    [{ status: "needs-approval" }, "needs-approval"],
    [{ status: "scope", reason: "no-rules-scope" }, "scope"],
    [{ status: "wrong-account" }, "wrong-account"],
    [{ status: "failed", code: "AUTH_REQUIRED" }, "client-refused"],
    [{ status: "failed", code: "TRANSIENT" }, "unreachable"],
  ] as const)("stores nothing on %j", async (result, reply) => {
    await expect(signInMicrosoftAccount(deps({}, result), {})).resolves.toBe(reply);
    expect(await stored()).toEqual([]);
  });

  it("refuses a mailbox that is already set up, whatever its kind", async () => {
    await saveAccounts(path, [
      {
        id: EMAIL,
        imap: { host: "mail.example.com", port: 993, secure: true, user: EMAIL },
        sieve: { host: "mail.example.com", port: 4190, user: EMAIL },
        passwordCipher: await encryptPassword("password"),
      },
    ]);
    await expect(signInMicrosoftAccount(deps(), {})).resolves.toBe("duplicate");
  });

  it("binds a re-sign-in to the account and replaces the token", async () => {
    await withAccount();
    const signIn = vi.fn((options: MicrosoftSignInOptions) => {
      expect(options.expect).toEqual({ email: EMAIL, userId: USER });
      return Promise.resolve<MicrosoftSignInResult>({
        status: "signed-in",
        refreshToken: "new-token",
        email: "renamed@outlook.example",
        userId: USER,
      });
    });
    await expect(signInMicrosoftAccount(deps({ signIn }), { accountId: "ms-1" })).resolves.toBe(
      "signed-in",
    );
    expect(signIn).toHaveBeenCalledOnce();
    const [account] = await stored();
    expect(await decryptPassword(account?.microsoft.refreshCipher ?? "")).toBe("new-token");
    expect(account?.microsoft.email).toBe("renamed@outlook.example");
    expect(account?.microsoft.userId).toBe(USER);
  });

  it("refuses the same person under another address", async () => {
    await withAccount("ms-1", "old@outlook.example");
    await expect(signInMicrosoftAccount(deps(), {})).resolves.toBe("duplicate");
  });

  it("answers for an account that is gone", async () => {
    await expect(signInMicrosoftAccount(deps(), { accountId: "ms-9" })).resolves.toBe(
      "unknown-account",
    );
  });

  it("takes one sign-in at a time, and Cancel reaches the one that waits", async () => {
    let aborted = false;
    const signIn = (options: MicrosoftSignInOptions) =>
      new Promise<MicrosoftSignInResult>((resolve) => {
        options.signal?.addEventListener("abort", () => {
          aborted = true;
          resolve({ status: "aborted" });
        });
      });
    const first = signInMicrosoftAccount(deps({ signIn }), {});
    await expect(signInMicrosoftAccount(deps({ signIn }), {})).resolves.toBe("busy");
    await vi.waitFor(() => {
      cancelMicrosoftSignIn();
      expect(aborted).toBe(true);
    });
    await expect(first).resolves.toBe("aborted");
  });

  it("tells the app the accounts changed, and a failing listener changes nothing", async () => {
    const onAccountsChanged = vi.fn(() => Promise.reject(new Error("no")));
    await expect(signInMicrosoftAccount(deps({ onAccountsChanged }), {})).resolves.toBe(
      "signed-in",
    );
    expect(onAccountsChanged).toHaveBeenCalledOnce();
  });
});

describe("the page's state", () => {
  it("says whether sign-in is available, and holds no token", async () => {
    await withAccount();
    const page = await microsoftState(deps({ clientId: null }));
    expect(page).toEqual({
      available: false,
      accounts: [{ accountId: "ms-1", email: EMAIL, signedIn: true, editedRules: 0 }],
    });
  });

  it("counts the rules changed in Outlook", async () => {
    await withAccount();
    const page = await microsoftState(deps({ editedRules: () => 2 }));
    expect(page.accounts[0]?.editedRules).toBe(2);
  });
});

describe("removing", () => {
  const rules = (answer: "ready" | "rules-left" | "unreachable" | "restart-first") => ({
    prepare: vi.fn(() => Promise.resolve(answer)),
    abort: vi.fn(),
    done: vi.fn(),
  });

  it("deletes the rules first, then the token", async () => {
    await withAccount();
    const lifecycle = rules("ready");
    await expect(removeMicrosoftAccount(deps({ rules: lifecycle }), "ms-1")).resolves.toBe(
      "removed",
    );
    expect(lifecycle.prepare).toHaveBeenCalledWith("ms-1");
    expect(lifecycle.done).toHaveBeenCalledWith("ms-1");
    expect(await stored()).toEqual([]);
  });

  it("keeps the account when the rules could not be deleted", async () => {
    await withAccount();
    const lifecycle = rules("rules-left");
    await expect(removeMicrosoftAccount(deps({ rules: lifecycle }), "ms-1")).resolves.toBe(
      "rules-left",
    );
    expect(lifecycle.abort).toHaveBeenCalledWith("ms-1");
    expect(await stored()).toHaveLength(1);
  });

  it("asks for a restart when no lane can reach rules a token could", async () => {
    await withAccount();
    await expect(
      removeMicrosoftAccount(deps({ rules: rules("restart-first") }), "ms-1"),
    ).resolves.toBe("restart-first");
    expect(await stored()).toHaveLength(1);
  });

  it("removes an account Microsoft no longer signs in, and says the rules stay", async () => {
    await withAccount();
    await expect(
      removeMicrosoftAccount(deps({ rules: rules("unreachable") }), "ms-1"),
    ).resolves.toBe("removed-rules-remain");
    expect(await stored()).toEqual([]);
  });

  it("answers for an account that is gone", async () => {
    await expect(removeMicrosoftAccount(deps(), "ms-1")).resolves.toBe("unknown-account");
  });
});

describe("a refresh token that replaced itself", () => {
  it("is stored encrypted, and the new ciphertext is handed back", async () => {
    await withAccount();
    const cipher = await storeRefreshToken(path, "ms-1", "next-token");
    const [account] = await stored();
    expect(account?.microsoft.refreshCipher).toBe(cipher);
    expect(await decryptPassword(cipher ?? "")).toBe("next-token");
    expect(await readFile(path, "utf8")).not.toContain("next-token");
  });

  it("does not bring a removed account back", async () => {
    await expect(storeRefreshToken(path, "ms-1", "next-token")).resolves.toBeNull();
    expect(await stored()).toEqual([]);
  });

  it("a long token fits the schema", async () => {
    await withAccount();
    await expect(storeRefreshToken(path, "ms-1", "x".repeat(8_192))).resolves.toBeTypeOf("string");
  });
});

describe("own mail", () => {
  it("counts a Microsoft account like any other", () => {
    const own = collectOwnMail([
      { id: "ms-1", microsoft: { email: "me@contoso.example", userId: "a" } },
      // A listed provider on purpose: its domain must not become the person's own.
      { id: "ms-2", microsoft: { email: "me@outlook.com", userId: "b" } },
    ]);
    expect(own.addresses.has("me@contoso.example")).toBe(true);
    expect(own.domains.has("contoso.example")).toBe(true);
    expect(own.domains.has("outlook.com")).toBe(false);
  });
});

describe("lanes", () => {
  const log = vi.fn();
  const baseDeps = (over: Partial<Parameters<typeof buildMicrosoftLanes>[0]> = {}) => ({
    accounts: [
      { id: "ms-1", microsoft: { email: EMAIL, userId: USER, refreshCipher: "aGVsbG8=" } },
    ],
    oauth: {
      exchangeCode: () => Promise.reject(new Error("unused")),
      refresh: () => Promise.reject(new Error("unused")),
    },
    budgets: new GraphBudgets(),
    saveState: () => undefined,
    decrypt: () => Promise.resolve(TOKEN),
    saveRefreshToken: () => Promise.resolve("bmV4dA=="),
    own: () => ({ domains: new Set<string>(), addresses: new Set<string>() }),
    log,
    ...over,
  });

  it("builds one lane per signed-in account and touches no network", () => {
    const fetch = vi.fn();
    const { lanes, skipped } = buildMicrosoftLanes(baseDeps({ fetch: fetch as never }));
    expect(lanes.map((l) => l.laneId)).toEqual(["ms-1.graph"]);
    expect(skipped).toEqual([]);
    expect(fetch).not.toHaveBeenCalled();
  });

  it("leaves out what cannot act, and says why", () => {
    expect(buildMicrosoftLanes(baseDeps({ oauth: null })).skipped[0]?.reason).toBe("no-client");
    expect(
      buildMicrosoftLanes(
        baseDeps({ accounts: [{ id: "ms-1", microsoft: { email: EMAIL, userId: USER } }] }),
      ).skipped[0]?.reason,
    ).toBe("signed-out");
    expect(
      buildMicrosoftLanes(baseDeps({ reservedLaneIds: new Set(["ms-1.graph"]) })).skipped[0]
        ?.reason,
    ).toBe("lane-id");
  });

  it("keeps the newest refresh token, and goes on when it cannot be saved", async () => {
    const seen: string[] = [];
    let n = 0;
    const saveRefreshToken = vi.fn((_id: string, token: string) =>
      token === "bad" ? Promise.reject(new Error("disk")) : Promise.resolve(`cipher-${token}`),
    );
    const { lanes } = buildMicrosoftLanes(
      baseDeps({
        now: () => (n += 3_600_000),
        decrypt: (cipher) => {
          seen.push(cipher);
          return Promise.resolve(TOKEN);
        },
        saveRefreshToken,
        oauth: {
          exchangeCode: () => Promise.reject(new Error("unused")),
          refresh: () =>
            Promise.resolve({
              accessToken: "access",
              expiresInSeconds: 3599,
              scope: undefined,
              refreshToken: seen.length === 1 ? "t1" : "bad",
            }),
        },
        fetch: () => Promise.resolve(new Response(JSON.stringify({ value: [] }), { status: 200 })),
      }),
    );
    const adapter = lanes[0]?.adapter;
    if (adapter === undefined) throw new Error("no lane");
    const state: OpaqueState = {
      ...initialGraphState(),
      data: {
        edited: [],
        rules: [
          {
            id: "rule-1",
            nonce: "0123456789abcdef",
            kind: "address",
            action: "trash",
            entries: [
              {
                id: "00000000-0000-4000-8000-000000000001",
                value: "a@spam.example",
                match: "exactAddress",
              },
            ],
          },
        ],
        intent: [],
        junkFolderId: null,
        capacity: 100,
      },
    };
    await adapter.verify(state);
    await adapter.verify(state);
    await adapter.verify(state);
    expect(seen).toEqual(["aGVsbG8=", "cipher-t1", "cipher-t1"]);
    expect(log).toHaveBeenCalledWith("graph-refresh-save-failed", expect.anything());
  });

  it("says when a renewed token holds more than was asked, as a count", async () => {
    const logged: unknown[] = [];
    const { lanes } = buildMicrosoftLanes(
      baseDeps({
        log: (event, fields) => logged.push([event, fields]),
        oauth: {
          exchangeCode: () => Promise.reject(new Error("unused")),
          refresh: () =>
            Promise.resolve({
              accessToken: "access",
              expiresInSeconds: 3599,
              scope: "User.Read Mail.ReadBasic MailboxSettings.ReadWrite Mail.Send",
            }),
        },
        fetch: () => Promise.resolve(new Response(JSON.stringify({ value: [] }), { status: 200 })),
      }),
    );
    await lanes[0]?.adapter.uninstall({
      ...initialGraphState(),
      data: {
        rules: [],
        edited: [
          { id: "r", nonce: "0123456789abcdef", kind: "address", action: "trash", entries: [] },
        ],
        intent: [],
        junkFolderId: null,
        capacity: 100,
      },
    });
    expect(logged).toContainEqual(["graph-scope-wider", { account: "ms-1", extras: 1 }]);
    expect(JSON.stringify(logged)).not.toContain("Mail.Send");
  });

  it("logs a request as its operation, status and time, with no address", async () => {
    const logged: unknown[] = [];
    const { lanes } = buildMicrosoftLanes(
      baseDeps({
        accounts: [
          {
            id: "me@outlook.example",
            microsoft: { email: EMAIL, userId: USER, refreshCipher: "aGVsbG8=" },
          },
        ],
        log: (event, fields) => logged.push([event, fields]),
        oauth: {
          exchangeCode: () => Promise.reject(new Error("unused")),
          refresh: () =>
            Promise.resolve({ accessToken: "access", expiresInSeconds: 3599, scope: undefined }),
        },
        fetch: (async (url: string) => {
          await Promise.resolve();
          expect(url).toBe(GRAPH_RULES_URL);
          return new Response(JSON.stringify({ value: [] }), { status: 200 });
        }) as never,
      }),
    );
    const state = lanes[0]?.adapter;
    await state?.verify({
      ...initialGraphState(),
      data: {
        rules: [],
        edited: [],
        intent: [
          {
            ruleId: null,
            nonce: "0123456789abcdef",
            kind: "address",
            action: "trash",
            entries: [
              {
                id: "00000000-0000-4000-8000-000000000001",
                value: "a@spam.example",
                match: "exactAddress",
              },
            ],
          },
        ],
        junkFolderId: null,
        capacity: 100,
      },
    });
    expect(JSON.stringify(logged)).not.toContain("outlook.example");
    expect(JSON.stringify(logged)).toContain("rule-list");
  });
});

describe("the notes", () => {
  it("names the text match of a domain, and nothing for an address", () => {
    const list = [
      {
        id: "00000000-0000-4000-8000-000000000001",
        match: "subdomains" as const,
        value: "spam.example",
        action: "junk" as const,
        createdAt: "2026-10-31T00:00:00.000Z",
      },
    ];
    const own = { domains: new Set<string>(), addresses: new Set<string>() };
    expect(microsoftWideNote(list, "spam.example", own)).toContain("text match");
    expect(microsoftWideNote(list, "other.example", own)).toBe("");
    expect(outlookCover({ match: "exactAddress", value: "a@spam.example" }, own)).toBe("exact");
    expect(outlookCover({ match: "subdomains", value: "spam.example" }, own)).toBe("wide");
  });

  it("says when a domain is not written, because its text match would reach the person's mail", () => {
    const own = { domains: new Set(["spam.example.net"]), addresses: new Set<string>() };
    const list = [
      {
        id: "00000000-0000-4000-8000-000000000001",
        match: "subdomains" as const,
        value: "spam.example",
        action: "junk" as const,
        createdAt: "2026-10-31T00:00:00.000Z",
      },
    ];
    expect(outlookCover(list[0] as never, own)).toBe("no");
    expect(microsoftWideNote(list, "spam.example", own)).toContain("Not blocked on Outlook");
  });

  it("names a skipped account and counts the rest", () => {
    const skipped = ["a", "b", "c"].map((name) => ({
      accountId: name,
      email: `${name}@outlook.example`,
      reason: "signed-out" as const,
    }));
    expect(microsoftSkippedNote([])).toBe("");
    expect(microsoftSkippedNote(skipped)).toBe(
      " Outlook not updated: a@outlook.example (it is signed out); b@outlook.example (it is signed out) (+1 more).",
    );
  });
});

describe("the lifecycle", () => {
  const LANE = graphLaneId("ms-1");
  const fakeLane = (adapter: Partial<Record<string, unknown>>) =>
    new Map([
      [
        "ms-1",
        {
          laneId: LANE,
          accountId: "ms-1",
          email: EMAIL,
          adapter: {
            suspend: () => Promise.resolve(true),
            resume: vi.fn(),
            retire: vi.fn(),
            uninstall: vi.fn(),
            ...adapter,
          },
        },
      ],
    ]) as never;
  const holding: OpaqueState = {
    adapterId: "graph",
    data: { rules: "unreadable holds rules" },
  };
  const setup = (over: Record<string, unknown>, state: OpaqueState | null = holding) => {
    const setState = vi.fn();
    const handlers = {
      onHold: vi.fn(),
      onResumed: vi.fn(),
      onDone: vi.fn(),
    };
    const lifecycle = createMicrosoftLifecycle({
      lanes: new Map(),
      store: { getState: () => state ?? undefined, setState },
      skipReasonOf: () => undefined,
      log: () => undefined,
      ...handlers,
      ...over,
    });
    return { lifecycle, setState, ...handlers };
  };

  it("with no lane and no state has nothing to do", async () => {
    await expect(setup({}, null).lifecycle.prepare("ms-1")).resolves.toBe("ready");
  });

  it("with no lane and rules asks for a restart, or says they are out of reach", async () => {
    await expect(setup({}).lifecycle.prepare("ms-1")).resolves.toBe("restart-first");
    await expect(
      setup({ skipReasonOf: () => "signed-out" }).lifecycle.prepare("ms-1"),
    ).resolves.toBe("unreachable");
  });

  it("holds the lane still, deletes the rules and saves what is left", async () => {
    const empty = initialGraphState();
    const uninstall = vi.fn(() => Promise.resolve(empty));
    const { lifecycle, setState, onHold } = setup({ lanes: fakeLane({ uninstall }) });
    await expect(lifecycle.prepare("ms-1")).resolves.toBe("ready");
    expect(onHold).toHaveBeenCalledWith(LANE, true);
    expect(setState).toHaveBeenCalledWith(LANE, empty);
  });

  it("answers rules-left when a round will not end, or rules stay", async () => {
    await expect(
      setup({ lanes: fakeLane({ suspend: () => Promise.resolve(false) }) }).lifecycle.prepare(
        "ms-1",
      ),
    ).resolves.toBe("rules-left");
    await expect(
      setup({
        lanes: fakeLane({ uninstall: () => Promise.reject(new Error("no")) }),
      }).lifecycle.prepare("ms-1"),
    ).resolves.toBe("rules-left");
  });

  it("lets an account go when only rules the person edited are left", async () => {
    const left: OpaqueState = {
      adapterId: "graph",
      data: {
        rules: [],
        edited: [
          {
            id: "rule-1",
            nonce: "0123456789abcdef",
            kind: "address",
            action: "trash",
            entries: [],
          },
        ],
        intent: [],
        junkFolderId: null,
        capacity: 100,
      },
    };
    const { lifecycle } = setup({
      lanes: fakeLane({ uninstall: () => Promise.resolve(left) }),
    });
    await expect(lifecycle.prepare("ms-1")).resolves.toBe("unreachable");
  });

  it("lets an account go when its state no longer reads: waiting changes nothing", async () => {
    const uninstall = () => Promise.reject(new AdapterError("REJECTED", "graph state failed"));
    await expect(setup({ lanes: fakeLane({ uninstall }) }).lifecycle.prepare("ms-1")).resolves.toBe(
      "unreachable",
    );
  });

  it("frees the lane on abort and retires it when done", () => {
    const resume = vi.fn();
    const retire = vi.fn();
    const { lifecycle, onResumed, onDone } = setup({ lanes: fakeLane({ resume, retire }) });
    lifecycle.abort("ms-1");
    expect(resume).toHaveBeenCalledOnce();
    expect(onResumed).toHaveBeenCalledWith(LANE);
    lifecycle.done("ms-1");
    expect(retire).toHaveBeenCalledOnce();
    expect(onDone).toHaveBeenCalledOnce();
  });
});
