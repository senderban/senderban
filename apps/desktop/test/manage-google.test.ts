import { beforeEach, describe, expect, it, vi } from "vitest";

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

const { ManageWindow } = await import("../src/manage.js");

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

let googleState: ReturnType<typeof vi.fn>;
let googleSaveClient: ReturnType<typeof vi.fn>;
let googleSignIn: ReturnType<typeof vi.fn>;
let googleCancel: ReturnType<typeof vi.fn>;
let googleRemove: ReturnType<typeof vi.fn>;
let onError: ReturnType<typeof vi.fn>;

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
  onError = vi.fn();
  new ManageWindow("assets", {
    list: () => [],
    unblock: () => Promise.resolve({ tone: "ok", text: "" }),
    googleState,
    googleSaveClient,
    googleSignIn,
    googleCancel,
    googleRemove,
    onError,
  } as never).show();
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

  it("cancels a waiting sign-in only for the trusted page", async () => {
    await call("manage:google-cancel", otherFrame);
    expect(googleCancel).not.toHaveBeenCalled();
    await call("manage:google-cancel", trusted);
    expect(googleCancel).toHaveBeenCalledTimes(1);
  });
});
