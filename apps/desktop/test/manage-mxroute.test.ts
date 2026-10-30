import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Mock } from "vitest";

type Handler = (event: unknown, payload?: unknown) => unknown;
const handlers = new Map<string, Handler>();
const windowEvents = new Map<string, () => void>();
const showMessageBox = vi.hoisted(() =>
  vi.fn<(win: unknown, options: Record<string, unknown>) => Promise<{ response: number }>>(),
);

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
    on = (name: string, fn: () => void) => {
      windowEvents.set(name, fn);
    };
    show = () => undefined;
    close = () => undefined;
    loadFile = () => Promise.resolve();
  }
  return {
    BrowserWindow: FakeWindow,
    dialog: { showMessageBox },
    nativeTheme: { shouldUseDarkColors: false },
    ipcMain: {
      handle: (channel: string, fn: Handler) => {
        handlers.set(channel, fn);
      },
    },
  };
});

const { ManageWindow } = await import("../src/manage.js");
import type { AccountAddRequest, AccountRemoveRequest } from "../src/manage.js";

const KEY = "test-mxroute-key-not-real-0000";
const login = { server: "mx.example.net", username: "exampleuser" };
const good = { ...login, apiKey: KEY };
const switchOn = { ...login, domain: "example.com", enabled: true };
const trusted = { sender: { id: 7 }, senderFrame: { processId: 1, routingId: 2 } };
const otherFrame = { sender: { id: 7 }, senderFrame: { processId: 1, routingId: 99 } };
const otherWindow = { sender: { id: 8 }, senderFrame: { processId: 1, routingId: 2 } };

const call = (channel: string, event: unknown, payload?: unknown) => {
  const handler = handlers.get(channel);
  if (handler === undefined) throw new Error(`no handler for ${channel}`);
  return Promise.resolve(handler(event, payload));
};

let mxrouteSave: ReturnType<typeof vi.fn>;
let mxrouteRemove: Mock<(ref: unknown, confirm: () => Promise<boolean>) => Promise<string>>;
let mxrouteEnable: ReturnType<typeof vi.fn>;
let mxrouteList: ReturnType<typeof vi.fn>;
let accountAdd: Mock<(input: unknown, request: AccountAddRequest) => Promise<string>>;
let accountRemove: Mock<(id: string, request: AccountRemoveRequest) => Promise<string>>;
let onError: ReturnType<typeof vi.fn>;

beforeEach(() => {
  handlers.clear();
  mxrouteSave = vi.fn(() => Promise.resolve("saved"));
  mxrouteRemove = vi.fn(() => Promise.resolve("saved"));
  mxrouteEnable = vi.fn(() => Promise.resolve("saved"));
  mxrouteList = vi.fn(() =>
    Promise.resolve({
      accounts: [{ accountId: "main", label: "me@example.com" }],
      keys: [{ ...login, domains: [{ domain: "example.com", enabled: false }] }],
      keysUnreadable: false,
    }),
  );
  accountAdd = vi.fn(() => Promise.resolve("saved"));
  accountRemove = vi.fn(() => Promise.resolve("removed"));
  showMessageBox.mockReset();
  windowEvents.clear();
  onError = vi.fn();
  new ManageWindow("assets", {
    list: () => [],
    unblock: () => Promise.resolve({ tone: "ok", text: "" }),
    mxrouteList,
    mxrouteSave,
    mxrouteRemove,
    mxrouteEnable,
    accountAdd,
    accountRemove,
    googleCancel: () => undefined,
    restart: () => undefined,
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
    ["an account id, which a key does not have", { ...good, accountId: "main" }],
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
  it("removes only for a valid login from the trusted page", async () => {
    expect(await call("manage:mxroute-remove", trusted, login)).toBe("saved");
    expect(mxrouteRemove).toHaveBeenCalledWith(login, expect.any(Function));
    for (const bad of [
      "main",
      "",
      5,
      null,
      { server: login.server },
      { ...login, apiKey: KEY },
      { ...login, username: "a\r\nX-Evil: 1" },
      { ...login, server: "https://evil.example/x" },
    ]) {
      expect(await call("manage:mxroute-remove", trusted, bad)).toBe("invalid");
    }
    expect(await call("manage:mxroute-remove", otherFrame, login)).toBe("denied");
    expect(mxrouteRemove).toHaveBeenCalledTimes(1);
  });

  it("asks in the main process, with Cancel as the default, and names no key", async () => {
    mxrouteRemove.mockImplementationOnce(async (_ref, confirm) =>
      (await confirm()) ? "saved" : "cancelled",
    );
    showMessageBox.mockResolvedValueOnce({ response: 0 });
    expect(await call("manage:mxroute-remove", trusted, login)).toBe("cancelled");
    const options = showMessageBox.mock.calls[0]?.[1];
    expect(options).toMatchObject({ defaultId: 0, cancelId: 0 });
    expect(options?.message).toContain(login.username);
    expect(JSON.stringify(options)).not.toContain(KEY);
  });

  it("lists status and limits only, to the trusted page only", async () => {
    const reply = (await call("manage:mxroute-list", trusted)) as {
      accounts: Record<string, unknown>[];
      keys: Record<string, unknown>[];
      limits: Record<string, unknown>;
    };
    expect(Object.keys(reply).sort()).toEqual([
      "accounts",
      "addLimits",
      "keys",
      "keysUnreadable",
      "limits",
      "restartPending",
    ]);
    expect(Object.keys(reply.accounts[0] ?? {}).sort()).toEqual(["accountId", "label"]);
    expect(Object.keys(reply.keys[0] ?? {}).sort()).toEqual(["domains", "server", "username"]);
    expect(reply.limits).toMatchObject({ apiKey: { min: 8, max: 512 } });
    expect(await call("manage:mxroute-list", otherFrame)).toBeNull();
  });
});

describe("manage:mxroute-enable", () => {
  it("switches the blacklist for a valid domain from the trusted page", async () => {
    expect(await call("manage:mxroute-enable", trusted, switchOn)).toBe("saved");
    expect(mxrouteEnable).toHaveBeenCalledWith(switchOn);
  });

  it.each([
    ["not an object", "main"],
    ["extra key", { ...switchOn, key: "x" }],
    ["enabled not a boolean", { ...switchOn, enabled: "true" }],
    ["enabled missing", { ...login, domain: "example.com" }],
    ["domain that is a path", { ...switchOn, domain: "../x" }],
    ["domain in capitals", { ...switchOn, domain: "EXAMPLE.com" }],
    ["domain with a line break", { ...switchOn, domain: "example.com\r\nX" }],
  ])("refuses %s without touching the store", async (_name, payload) => {
    expect(await call("manage:mxroute-enable", trusted, payload)).toBe("invalid");
    expect(mxrouteEnable).not.toHaveBeenCalled();
  });

  it("ignores another frame and reports a failing store as a fixed word", async () => {
    expect(await call("manage:mxroute-enable", otherFrame, switchOn)).toBe("denied");
    mxrouteEnable.mockRejectedValueOnce(new Error("disk full"));
    expect(await call("manage:mxroute-enable", trusted, switchOn)).toBe("failed");
    expect(onError).toHaveBeenCalledWith("manage:mxroute-enable", expect.any(Error));
  });

  it("passes on what the main process said about a refused key", async () => {
    mxrouteSave.mockResolvedValueOnce("key-refused");
    expect(await call("manage:mxroute-save", trusted, good)).toBe("key-refused");
  });
});

describe("manage:account-add", () => {
  const PASSWORD = "not-a-real-password";
  const form = { address: "You@Example.com", host: "mail.example.com", password: PASSWORD };

  it("hands the checked input over once, with the address in canonical form, and answers a fixed word", async () => {
    const reply = await call("manage:account-add", trusted, form);
    expect(reply).toBe("saved");
    expect(accountAdd).toHaveBeenCalledTimes(1);
    expect(accountAdd.mock.calls[0]?.[0]).toEqual({ ...form, address: "you@example.com" });
    expect(accountAdd.mock.calls[0]?.[1].signal).toBeInstanceOf(AbortSignal);
    expect(JSON.stringify(reply)).not.toContain(PASSWORD);
  });

  it("ignores a message from another frame or another window", async () => {
    expect(await call("manage:account-add", otherFrame, form)).toBe("denied");
    expect(await call("manage:account-add", otherWindow, form)).toBe("denied");
    expect(accountAdd).not.toHaveBeenCalled();
  });

  it.each([
    ["no payload", undefined],
    ["an IP address as the server", { ...form, host: "192.0.2.1" }],
    ["an unknown key", { ...form, port: 993 }],
    ["a missing password", { address: form.address, host: form.host }],
    ["a host with a path", { ...form, host: "mail.example.com/x" }],
    ["a line break in the host", { ...form, host: "mail.example.com\r\nA" }],
    ["two addresses", { ...form, address: "a@example.com,b@example.com" }],
  ])("refuses %s without reaching the handler", async (_name, payload) => {
    expect(await call("manage:account-add", trusted, payload)).toBe("invalid");
    expect(accountAdd).not.toHaveBeenCalled();
  });

  it("runs one add at a time: a second click answers busy and never signs in again", async () => {
    let finish: (value: string) => void = () => undefined;
    accountAdd.mockReturnValueOnce(
      new Promise<string>((resolve) => {
        finish = resolve;
      }),
    );
    const first = call("manage:account-add", trusted, form);
    await Promise.resolve();
    expect(await call("manage:account-add", trusted, form)).toBe("busy");
    finish("saved");
    expect(await first).toBe("saved");
    expect(await call("manage:account-add", trusted, form)).toBe("saved");
    expect(accountAdd).toHaveBeenCalledTimes(2);
  });

  it("asks in the main process, naming the server and the address, with Cancel as the default", async () => {
    let answer: boolean | undefined;
    accountAdd.mockImplementationOnce(async (_input, request) => {
      answer = await request.confirm();
      return "cancelled";
    });
    showMessageBox.mockResolvedValueOnce({ response: 0 });
    expect(await call("manage:account-add", trusted, form)).toBe("cancelled");
    expect(answer).toBe(false);
    const options = showMessageBox.mock.calls[0]?.[1];
    expect(options?.detail).toContain("mail.example.com");
    expect(options?.detail).toContain("you@example.com");
    expect(options?.detail).not.toContain(PASSWORD);
    expect(options).toMatchObject({ defaultId: 0, cancelId: 0 });
  });

  it("answers yes only for the second button", async () => {
    let answer: boolean | undefined;
    accountAdd.mockImplementationOnce(async (_input, request) => {
      answer = await request.confirm();
      return "saved";
    });
    showMessageBox.mockResolvedValueOnce({ response: 1 });
    await call("manage:account-add", trusted, form);
    expect(answer).toBe(true);
  });

  it("aborts the add when the window closes", async () => {
    let signal: AbortSignal | undefined;
    let finish: (value: string) => void = () => undefined;
    accountAdd.mockImplementationOnce((_input, request) => {
      signal = request.signal;
      return new Promise<string>((resolve) => {
        finish = resolve;
      });
    });
    const first = call("manage:account-add", trusted, form);
    await Promise.resolve();
    expect(signal?.aborted).toBe(false);
    windowEvents.get("closed")?.();
    expect(signal?.aborted).toBe(true);
    finish("cancelled");
    await first;
  });

  it("keeps offering the restart after a save, also for a page that opens later", async () => {
    const before = (await call("manage:mxroute-list", trusted)) as { restartPending: boolean };
    expect(before.restartPending).toBe(false);
    await call("manage:account-add", trusted, form);
    const after = (await call("manage:mxroute-list", trusted)) as { restartPending: boolean };
    expect(after.restartPending).toBe(true);
  });

  it("does not offer a restart when nothing was stored", async () => {
    accountAdd.mockResolvedValueOnce("login-refused");
    await call("manage:account-add", trusted, form);
    const list = (await call("manage:mxroute-list", trusted)) as { restartPending: boolean };
    expect(list.restartPending).toBe(false);
  });

  it("refuses a restart while an add is running", async () => {
    let finish: (value: string) => void = () => undefined;
    accountAdd.mockReturnValueOnce(
      new Promise<string>((resolve) => {
        finish = resolve;
      }),
    );
    const first = call("manage:account-add", trusted, form);
    await Promise.resolve();
    expect(await call("manage:restart", trusted)).toBe("busy");
    finish("saved");
    await first;
  });

  it("gives the page a generic word when the handler throws, and logs nothing of the input", async () => {
    accountAdd.mockRejectedValueOnce(new Error("boom"));
    expect(await call("manage:account-add", trusted, form)).toBe("failed");
    expect(onError).toHaveBeenCalledWith("manage:account-add", expect.any(Error));
    expect(JSON.stringify(onError.mock.calls)).not.toContain(PASSWORD);
    expect(await call("manage:restart", trusted)).not.toBe("busy");
    expect(await call("manage:account-add", trusted, form)).toBe("saved");
  });
});

describe("manage:account-remove", () => {
  const ID = "you@example.com";

  it("hands a valid id over and answers a fixed word", async () => {
    expect(await call("manage:account-remove", trusted, ID)).toBe("removed");
    expect(accountRemove).toHaveBeenCalledTimes(1);
    expect(accountRemove.mock.calls[0]?.[0]).toBe(ID);
  });

  it("ignores a message from another frame or another window", async () => {
    expect(await call("manage:account-remove", otherFrame, ID)).toBe("denied");
    expect(await call("manage:account-remove", otherWindow, ID)).toBe("denied");
    expect(accountRemove).not.toHaveBeenCalled();
  });

  it.each([
    ["no payload", undefined],
    ["a number", 7],
    ["a path", "../accounts.json"],
    ["a line break", "you@example.com\r\nX"],
    ["a long id", "a".repeat(65)],
  ])("refuses %s without reaching the handler", async (_name, payload) => {
    expect(await call("manage:account-remove", trusted, payload)).toBe("invalid");
    expect(accountRemove).not.toHaveBeenCalled();
  });

  it("runs one account change at a time, also against an add", async () => {
    let finish: (value: string) => void = () => undefined;
    accountRemove.mockReturnValueOnce(
      new Promise<string>((resolve) => {
        finish = resolve;
      }),
    );
    const first = call("manage:account-remove", trusted, ID);
    await Promise.resolve();
    expect(await call("manage:account-remove", trusted, ID)).toBe("busy");
    expect(
      await call("manage:account-add", trusted, {
        address: ID,
        host: "mail.example.com",
        password: "not-a-real-password",
      }),
    ).toBe("busy");
    expect(await call("manage:restart", trusted)).toBe("busy");
    finish("removed");
    await first;
  });

  it("asks in the main process, with Cancel as the default", async () => {
    accountRemove.mockImplementationOnce(async (_id, request) =>
      (await request.confirm(ID)) ? "removed" : "cancelled",
    );
    showMessageBox.mockResolvedValueOnce({ response: 0 });
    expect(await call("manage:account-remove", trusted, ID)).toBe("cancelled");
    expect(showMessageBox.mock.calls[0]?.[1]).toMatchObject({ defaultId: 0, cancelId: 0 });
  });

  it("offers the restart after a removal, not after a refusal", async () => {
    accountRemove.mockResolvedValueOnce("rules-left");
    await call("manage:account-remove", trusted, ID);
    const kept = (await call("manage:mxroute-list", trusted)) as { restartPending: boolean };
    expect(kept.restartPending).toBe(false);
    accountRemove.mockResolvedValueOnce("removed-rules-remain");
    await call("manage:account-remove", trusted, ID);
    const gone = (await call("manage:mxroute-list", trusted)) as { restartPending: boolean };
    expect(gone.restartPending).toBe(true);
  });

  it("gives the page a generic word when the handler throws", async () => {
    accountRemove.mockRejectedValueOnce(new Error("boom"));
    expect(await call("manage:account-remove", trusted, ID)).toBe("failed");
    expect(onError).toHaveBeenCalledWith("manage:account-remove", expect.any(Error));
    expect(await call("manage:account-remove", trusted, ID)).toBe("removed");
  });
});
