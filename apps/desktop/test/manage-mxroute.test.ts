import { beforeEach, describe, expect, it, vi } from "vitest";

type Handler = (event: unknown, payload?: unknown) => unknown;
const handlers = new Map<string, Handler>();

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
    on = () => undefined;
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

const KEY = "test-mxroute-key-not-real-0000";
const good = {
  accountId: "main",
  server: "mx.example.net",
  username: "exampleuser",
  apiKey: KEY,
};
const trusted = { sender: { id: 7 }, senderFrame: { processId: 1, routingId: 2 } };
const otherFrame = { sender: { id: 7 }, senderFrame: { processId: 1, routingId: 99 } };
const otherWindow = { sender: { id: 8 }, senderFrame: { processId: 1, routingId: 2 } };

const call = (channel: string, event: unknown, payload?: unknown) => {
  const handler = handlers.get(channel);
  if (handler === undefined) throw new Error(`no handler for ${channel}`);
  return Promise.resolve(handler(event, payload));
};

let mxrouteSave: ReturnType<typeof vi.fn>;
let mxrouteRemove: ReturnType<typeof vi.fn>;
let mxrouteEnable: ReturnType<typeof vi.fn>;
let mxrouteList: ReturnType<typeof vi.fn>;
let onError: ReturnType<typeof vi.fn>;

beforeEach(() => {
  handlers.clear();
  mxrouteSave = vi.fn(() => Promise.resolve("saved"));
  mxrouteRemove = vi.fn(() => Promise.resolve("saved"));
  mxrouteEnable = vi.fn(() => Promise.resolve("saved"));
  mxrouteList = vi.fn(() =>
    Promise.resolve([
      {
        accountId: "main",
        label: "me@example.com",
        hasKey: true,
        enabled: false,
        server: "s",
        username: "u",
      },
    ]),
  );
  onError = vi.fn();
  new ManageWindow("assets", {
    list: () => [],
    unblock: () => Promise.resolve({ tone: "ok", text: "" }),
    mxrouteList,
    mxrouteSave,
    mxrouteRemove,
    mxrouteEnable,
    onError,
  } as never).show();
});

describe("manage:mxroute-save", () => {
  it("stores a valid key once and answers with a fixed word, never the input", async () => {
    const reply = await call("manage:mxroute-save", trusted, good);
    expect(reply).toBe("saved");
    expect(mxrouteSave).toHaveBeenCalledTimes(1);
    expect(mxrouteSave).toHaveBeenCalledWith(good);
    expect(JSON.stringify(reply)).not.toContain(KEY);
  });

  it("ignores a message from another frame or another window", async () => {
    expect(await call("manage:mxroute-save", otherFrame, good)).toBe("denied");
    expect(await call("manage:mxroute-save", otherWindow, good)).toBe("denied");
    expect(await call("manage:mxroute-save", { sender: { id: 7 }, senderFrame: null }, good)).toBe(
      "denied",
    );
    expect(mxrouteSave).not.toHaveBeenCalled();
  });

  it.each([
    ["not an object", "hello"],
    ["null", null],
    ["extra key", { ...good, admin: true }],
    ["short key", { ...good, apiKey: "short" }],
    ["key with a space", { ...good, apiKey: "has space in the key" }],
    ["key with a line break", { ...good, apiKey: "line\nbreak-in-the-key" }],
    ["user name with a header injection", { ...good, username: "a\r\nX-Evil: 1" }],
    ["server that is a URL", { ...good, server: "https://evil.example/x" }],
    ["account id that is a path", { ...good, accountId: "../../accounts" }],
    ["number as key", { ...good, apiKey: 12345678 }],
  ])("refuses %s without touching the store", async (_name, payload) => {
    expect(await call("manage:mxroute-save", trusted, payload)).toBe("invalid");
    expect(mxrouteSave).not.toHaveBeenCalled();
  });

  it("reports a failing store as a fixed word and logs the channel, not the key", async () => {
    mxrouteSave.mockRejectedValueOnce(new Error("disk full"));
    const reply = await call("manage:mxroute-save", trusted, good);
    expect(reply).toBe("failed");
    expect(onError).toHaveBeenCalledWith("manage:mxroute-save", expect.any(Error));
    // An Error stringifies to {}, so look at the message the log would get.
    const logged = (onError.mock.calls[0] as unknown[])[1];
    expect(String(logged)).not.toContain(KEY);
  });
});

describe("manage:mxroute-remove and manage:mxroute-list", () => {
  it("removes only for a valid account id from the trusted page", async () => {
    expect(await call("manage:mxroute-remove", trusted, "main")).toBe("saved");
    expect(mxrouteRemove).toHaveBeenCalledWith("main");
    for (const bad of ["../x", "", 5, null, "a".repeat(65)]) {
      expect(await call("manage:mxroute-remove", trusted, bad)).toBe("invalid");
    }
    expect(await call("manage:mxroute-remove", otherFrame, "main")).toBe("denied");
    expect(mxrouteRemove).toHaveBeenCalledTimes(1);
  });

  it("lists status and limits only, to the trusted page only", async () => {
    const reply = (await call("manage:mxroute-list", trusted)) as {
      accounts: Record<string, unknown>[];
      limits: Record<string, unknown>;
    };
    expect(Object.keys(reply).sort()).toEqual(["accounts", "limits"]);
    expect(Object.keys(reply.accounts[0] ?? {}).sort()).toEqual([
      "accountId",
      "enabled",
      "hasKey",
      "label",
      "server",
      "username",
    ]);
    expect(reply.limits).toMatchObject({ apiKey: { min: 8, max: 512 } });
    expect(await call("manage:mxroute-list", otherFrame)).toBeNull();
  });
});

describe("manage:mxroute-enable", () => {
  it("switches the blacklist for a valid account id from the trusted page", async () => {
    expect(await call("manage:mxroute-enable", trusted, { accountId: "main", enabled: true })).toBe(
      "saved",
    );
    expect(mxrouteEnable).toHaveBeenCalledWith("main", true);
  });

  it.each([
    ["not an object", "main"],
    ["extra key", { accountId: "main", enabled: true, key: "x" }],
    ["enabled not a boolean", { accountId: "main", enabled: "true" }],
    ["enabled missing", { accountId: "main" }],
    ["account id that is a path", { accountId: "../x", enabled: true }],
  ])("refuses %s without touching the store", async (_name, payload) => {
    expect(await call("manage:mxroute-enable", trusted, payload)).toBe("invalid");
    expect(mxrouteEnable).not.toHaveBeenCalled();
  });

  it("ignores another frame and reports a failing store as a fixed word", async () => {
    const payload = { accountId: "main", enabled: true };
    expect(await call("manage:mxroute-enable", otherFrame, payload)).toBe("denied");
    mxrouteEnable.mockRejectedValueOnce(new Error("disk full"));
    expect(await call("manage:mxroute-enable", trusted, payload)).toBe("failed");
    expect(onError).toHaveBeenCalledWith("manage:mxroute-enable", expect.any(Error));
  });

  it("passes on what the main process said about a refused key", async () => {
    mxrouteSave.mockResolvedValueOnce("key-refused");
    expect(await call("manage:mxroute-save", trusted, good)).toBe("key-refused");
  });
});
