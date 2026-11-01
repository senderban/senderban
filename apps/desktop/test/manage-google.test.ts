import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

type Handler = (event: unknown, payload?: unknown) => unknown;
const handlers = new Map<string, Handler>();
// vi.mock is hoisted above the imports, so what the fake window shares with the tests is hoisted too.
const windowEvents = vi.hoisted(() => new Map<string, () => void>());

// Just enough of Electron for ManageWindow to build one window and register its IPC handlers.
vi.mock("electron", () => {
  class FakeWindow {
    readonly webContents = {
      id: 7,
      mainFrame: { processId: 1, routingId: 2 },
      setWindowOpenHandler: () => undefined,
      on: () => undefined,
      send: () => undefined,
    };
    isDestroyed = () => false;
    isMinimized = () => false;
    restore = () => undefined;
    focus = () => undefined;
    removeMenu = () => undefined;
    once = () => undefined;
    on = (event: string, fn: () => void) => {
      windowEvents.set(event, fn);
    };
    show = () => undefined;
    close = () => undefined;
    loadFile = () => Promise.resolve();
  }
  return {
    BrowserWindow: FakeWindow,
    nativeTheme: { shouldUseDarkColors: false },
    ipcMain: {
      handle: (channel: string, fn: Handler) => {
        handlers.set(channel, fn);
      },
    },
  };
});

const { ManageWindow, RESTART_AFTER_ADD_MS, RESTART_WAIT_MAX_MS } =
  await import("../src/manage.js");

// Built at run time: a whole fake secret or client ID in the source trips GitHub push protection.
const SECRET = ["GOCSPX", "the-client-secret-0123456789"].join("-");
const good = {
  clientId: ["123456789012-abcdefghijklmnop", "apps", "googleusercontent", "com"].join("."),
  clientSecret: SECRET,
  confirmSignOut: false,
};
const trusted = { sender: { id: 7 }, senderFrame: { processId: 1, routingId: 2 } };
const otherFrame = { sender: { id: 7 }, senderFrame: { processId: 1, routingId: 99 } };
const otherWindow = { sender: { id: 8 }, senderFrame: { processId: 1, routingId: 2 } };

const call = (channel: string, event: unknown, payload?: unknown) => {
  const handler = handlers.get(channel);
  if (handler === undefined) throw new Error(`no handler for ${channel}`);
  return Promise.resolve(handler(event, payload));
};

let window: InstanceType<typeof ManageWindow>;
let googleState: ReturnType<typeof vi.fn>;
let googleSaveClient: ReturnType<typeof vi.fn>;
let googleSignIn: ReturnType<typeof vi.fn>;
let googleCancel: ReturnType<typeof vi.fn>;
let googleRemove: ReturnType<typeof vi.fn>;
let restart: ReturnType<typeof vi.fn>;
let noRestart: ReturnType<typeof vi.fn>;
let unblock: ReturnType<typeof vi.fn>;
let onError: ReturnType<typeof vi.fn>;
let status: ReturnType<typeof vi.fn>;

beforeEach(() => {
  handlers.clear();
  windowEvents.clear();
  googleState = vi.fn(() =>
    Promise.resolve({
      client: { clientId: good.clientId },
      accounts: [{ accountId: "g1", email: "me@gmail.com", signedIn: true }],
    }),
  );
  googleSaveClient = vi.fn(() => Promise.resolve("saved"));
  googleSignIn = vi.fn(() => Promise.resolve({ reply: "signed-in" }));
  googleCancel = vi.fn();
  googleRemove = vi.fn(() => Promise.resolve("removed"));
  restart = vi.fn();
  noRestart = vi.fn();
  status = vi.fn(() =>
    Promise.resolve({ version: "1.2.3", paused: false, behind: [], accounts: [] }),
  );
  unblock = vi.fn(() => Promise.resolve({ tone: "ok", text: "" }));
  onError = vi.fn();
  window = new ManageWindow("assets", {
    list: () => [],
    unblock,
    googleState,
    googleSaveClient,
    googleSignIn,
    googleCancel,
    googleRemove,
    restart,
    noRestart,
    status,
    onError,
  } as never);
  window.show();
});

describe("a restart after a sign-in", () => {
  const due = async () =>
    ((await call("manage:status", trusted)) as { restartPending: boolean }).restartPending;

  it("is due after a sign-in worked, so the bar survives the window closing", async () => {
    expect(await due()).toBe(false);
    await call("manage:google-sign-in", trusted, undefined);
    expect(await due()).toBe(true);
  });

  it("is not due after a sign-in that did not finish", async () => {
    googleSignIn.mockResolvedValueOnce({ reply: "cancelled" });
    await call("manage:google-sign-in", trusted, undefined);
    expect(await due()).toBe(false);
  });
});

describe("the restart on its own after a sign-in", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  /** A step that runs until `finish` is called. */
  const holdRemove = () => {
    let finish: () => void = () => undefined;
    googleRemove.mockReturnValue(
      new Promise((resolve) => {
        finish = () => {
          resolve("removed");
        };
      }),
    );
    return {
      step: call("manage:google-remove", trusted, "g1"),
      finish: () => {
        finish();
      },
    };
  };

  it("comes after the page had time to say so, with nothing taken from the page", async () => {
    await call("manage:google-sign-in", trusted, undefined);
    await vi.advanceTimersByTimeAsync(RESTART_AFTER_ADD_MS - 1);
    expect(restart).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(restart).toHaveBeenCalledTimes(1);
    expect(restart).toHaveBeenCalledWith({ by: "auto", waitedMs: RESTART_AFTER_ADD_MS });
    expect(noRestart).not.toHaveBeenCalled();
  });

  it("does not come after a sign-in that did not finish", async () => {
    googleSignIn.mockResolvedValueOnce({ reply: "cancelled" });
    await call("manage:google-sign-in", trusted, undefined);
    await vi.advanceTimersByTimeAsync(RESTART_WAIT_MAX_MS);
    expect(restart).not.toHaveBeenCalled();
  });

  it("is one restart for two sign-ins in a row", async () => {
    await call("manage:google-sign-in", trusted, undefined);
    await call("manage:google-sign-in", trusted, { accountId: "g1" });
    expect(restart).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(RESTART_WAIT_MAX_MS);
    expect(restart).toHaveBeenCalledTimes(1);
  });

  it("waits for a step still running, then restarts", async () => {
    await call("manage:google-sign-in", trusted, undefined);
    const held = holdRemove();
    await vi.advanceTimersByTimeAsync(RESTART_AFTER_ADD_MS * 3);
    expect(restart).not.toHaveBeenCalled();
    held.finish();
    await held.step;
    await vi.advanceTimersByTimeAsync(RESTART_AFTER_ADD_MS);
    expect(restart).toHaveBeenCalledTimes(1);
    expect(restart).toHaveBeenCalledWith({ by: "auto", waitedMs: RESTART_AFTER_ADD_MS * 4 });
  });

  it("waits for a click on a notification held as a step", async () => {
    await call("manage:google-sign-in", trusted, undefined);
    let finish: () => void = () => undefined;
    const click = window.hold(
      () =>
        new Promise<void>((resolve) => {
          finish = resolve;
        }),
    );
    await vi.advanceTimersByTimeAsync(RESTART_AFTER_ADD_MS * 2);
    expect(restart).not.toHaveBeenCalled();
    finish();
    await click;
    await vi.advanceTimersByTimeAsync(RESTART_AFTER_ADD_MS);
    expect(restart).toHaveBeenCalledTimes(1);
  });

  it("leaves the restart to the person while watching is paused, since a restart would resume it", async () => {
    status.mockResolvedValue({ version: "1.2.3", paused: true, behind: [], accounts: [] });
    await call("manage:google-sign-in", trusted, undefined);
    await vi.advanceTimersByTimeAsync(RESTART_WAIT_MAX_MS);
    expect(restart).not.toHaveBeenCalled();
    expect(noRestart).toHaveBeenCalledExactlyOnceWith("paused");
  });

  it("logs a restart that throws and keeps the bar", async () => {
    restart.mockImplementation(() => {
      throw new Error("relaunch failed");
    });
    await call("manage:google-sign-in", trusted, undefined);
    await vi.advanceTimersByTimeAsync(RESTART_AFTER_ADD_MS);
    expect(onError).toHaveBeenCalledWith("manage:auto-restart", expect.any(Error));
    status.mockResolvedValue({ version: "1.2.3", paused: false, behind: [], accounts: [] });
    const page = (await call("manage:status", trusted)) as { restartPending: boolean };
    expect(page.restartPending).toBe(true);
  });

  it("leaves the restart to the person when a step outlasts the wait", async () => {
    await call("manage:google-sign-in", trusted, undefined);
    const held = holdRemove();
    await vi.advanceTimersByTimeAsync(RESTART_WAIT_MAX_MS + RESTART_AFTER_ADD_MS);
    held.finish();
    await held.step;
    await vi.advanceTimersByTimeAsync(RESTART_WAIT_MAX_MS);
    expect(restart).not.toHaveBeenCalled();
    expect(noRestart).toHaveBeenCalledExactlyOnceWith("busy-timeout");
    const status = (await call("manage:status", trusted)) as { restartPending: boolean };
    expect(status.restartPending).toBe(true);
  });
});

describe("manage:google-save-client", () => {
  it("stores a valid client once and answers with a fixed word, never the input", async () => {
    const reply = await call("manage:google-save-client", trusted, good);
    expect(reply).toBe("saved");
    expect(googleSaveClient).toHaveBeenCalledWith(good);
    expect(JSON.stringify(reply)).not.toContain(SECRET);
  });

  it("ignores a message from another frame or another window", async () => {
    expect(await call("manage:google-save-client", otherFrame, good)).toBe("denied");
    expect(await call("manage:google-save-client", otherWindow, good)).toBe("denied");
    expect(
      await call("manage:google-save-client", { sender: { id: 7 }, senderFrame: null }, good),
    ).toBe("denied");
    expect(googleSaveClient).not.toHaveBeenCalled();
  });

  it.each([
    ["nothing", undefined],
    ["a string", SECRET],
    ["an extra key", { ...good, scope: "https://mail.google.com/" }],
    ["no flag", { clientId: good.clientId, clientSecret: SECRET }],
    ["a wrong ID", { ...good, clientId: "evil" }],
    ["a secret with a line break", { ...good, clientSecret: "a\nb" }],
    ["a secret past its limit", { ...good, clientSecret: "a".repeat(257) }],
  ])("rejects %s before it reaches the handler", async (_name, payload) => {
    expect(await call("manage:google-save-client", trusted, payload)).toBe("invalid");
    expect(googleSaveClient).not.toHaveBeenCalled();
  });

  it("answers a thrown handler with a generic word and logs the channel, not the secret", async () => {
    googleSaveClient.mockRejectedValue(new Error(`boom ${SECRET}`));
    expect(await call("manage:google-save-client", trusted, good)).toBe("failed");
    expect(onError).toHaveBeenCalledWith("manage:google-save-client", expect.any(Error));
  });
});

describe("manage:google-sign-in", () => {
  it("starts a new sign-in with no argument, and a re-sign-in with an account id", async () => {
    expect(await call("manage:google-sign-in", trusted, undefined)).toEqual({ reply: "signed-in" });
    expect(googleSignIn).toHaveBeenLastCalledWith({});
    await call("manage:google-sign-in", trusted, { accountId: "g1" });
    expect(googleSignIn).toHaveBeenLastCalledWith({ accountId: "g1" });
  });

  it.each([
    ["a URL", { url: "https://evil.example/" }],
    ["a scope", { scope: "https://mail.google.com/" }],
    ["an address", { accountId: "g1", email: "x@y.com" }],
    ["a bad id", { accountId: "bad id" }],
    ["a string", "g1"],
  ])("carries no %s", async (_name, payload) => {
    expect(await call("manage:google-sign-in", trusted, payload)).toEqual({ reply: "invalid" });
    expect(googleSignIn).not.toHaveBeenCalled();
  });

  it("ignores another frame or window", async () => {
    expect(await call("manage:google-sign-in", otherFrame, {})).toEqual({ reply: "denied" });
    expect(await call("manage:google-sign-in", otherWindow, {})).toEqual({ reply: "denied" });
    expect(googleSignIn).not.toHaveBeenCalled();
  });
});

describe("manage:google-state, -remove and -cancel", () => {
  it("gives the page the limits and the ID pattern, never a secret or a token", async () => {
    const reply = (await call("manage:google-state", trusted)) as Record<string, unknown>;
    expect(reply.limits).toEqual({
      clientId: { min: 1, max: 128 },
      clientSecret: { min: 1, max: 256 },
    });
    expect(reply.idPattern).toBe(String.raw`[0-9]+-[A-Za-z0-9_]+\.apps\.googleusercontent\.com`);
    expect(JSON.stringify(reply)).not.toMatch(/Cipher|GOCSPX|1\/\//u);
    expect(await call("manage:google-state", otherFrame)).toBeNull();
  });

  it("removes only a well-formed id from the trusted page", async () => {
    expect(await call("manage:google-remove", trusted, "g1")).toBe("removed");
    expect(googleRemove).toHaveBeenCalledWith("g1");
    expect(await call("manage:google-remove", trusted, "bad id")).toBe("invalid");
    expect(await call("manage:google-remove", trusted, 5)).toBe("invalid");
    expect(await call("manage:google-remove", otherFrame, "g1")).toBe("denied");
    expect(googleRemove).toHaveBeenCalledTimes(1);
  });

  it("hands the page the secret pattern too, from the same constant the schema uses", async () => {
    const reply = (await call("manage:google-state", trusted)) as Record<string, unknown>;
    expect(reply.secretPattern).toBe("[!-~]+");
  });

  it("stops a waiting sign-in when its window closes", () => {
    windowEvents.get("closed")?.();
    expect(googleCancel).toHaveBeenCalledTimes(1);
  });

  it("restarts only for the trusted page, with nothing taken from the page", async () => {
    expect(await call("manage:restart", otherFrame, "anything")).toBe("denied");
    expect(restart).not.toHaveBeenCalled();
    expect(await call("manage:restart", trusted, "anything")).toBe("restarting");
    expect(restart).toHaveBeenCalledTimes(1);
    expect(restart).toHaveBeenCalledWith({ by: "bar", waitedMs: 0 });
  });

  it.each([
    ["a Remove deleting filters", "manage:google-remove", "g1"],
    ["a sign-in", "manage:google-sign-in", {}],
    ["an Unblock", "manage:unblock", "0b8c4e1a-6f2d-4c3b-9a7e-5d1f3b2a4c6e"],
  ])(
    "refuses a restart in the main process while %s runs, and allows it after",
    async (_name, channel, payload) => {
      let finish: (value: unknown) => void = () => undefined;
      const pending = new Promise((resolve) => {
        finish = resolve;
      });
      googleRemove.mockReturnValue(pending.then(() => "removed"));
      googleSignIn.mockReturnValue(pending.then(() => ({ reply: "signed-in" })));
      unblock.mockReturnValue(pending.then(() => ({ tone: "ok", text: "" })));
      const step = call(channel, trusted, payload);
      expect(await call("manage:restart", trusted)).toBe("busy");
      expect(restart).not.toHaveBeenCalled();
      finish(undefined);
      await step;
      expect(await call("manage:restart", trusted)).toBe("restarting");
      expect(restart).toHaveBeenCalledTimes(1);
    },
  );

  it("frees the restart when a step throws", async () => {
    googleRemove.mockRejectedValue(new Error("boom"));
    expect(await call("manage:google-remove", trusted, "g1")).toBe("failed");
    expect(await call("manage:restart", trusted)).toBe("restarting");
  });

  it("cancels a waiting sign-in only for the trusted page", async () => {
    await call("manage:google-cancel", otherFrame);
    expect(googleCancel).not.toHaveBeenCalled();
    await call("manage:google-cancel", trusted);
    expect(googleCancel).toHaveBeenCalledTimes(1);
  });
});
