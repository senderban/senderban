import { beforeEach, describe, expect, it, vi } from "vitest";

type Handler = (event: unknown, payload?: unknown) => unknown;
const handlers = new Map<string, Handler>();
const asked = vi.hoisted(() => [] as { message: string; detail: string }[]);

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
    dialog: {
      showMessageBox: (_: unknown, box: { message: string; detail: string }) => {
        asked.push(box);
        return Promise.resolve({ response: 1 });
      },
    },
    nativeTheme: { shouldUseDarkColors: false },
    ipcMain: {
      handle: (channel: string, fn: Handler) => {
        handlers.set(channel, fn);
      },
    },
  };
});

const { ManageWindow } = await import("../src/manage.js");
type Handlers = ConstructorParameters<typeof ManageWindow>[1];

const trusted = { sender: { id: 7 }, senderFrame: { processId: 1, routingId: 2 } };
const stranger = { sender: { id: 8 }, senderFrame: { processId: 1, routingId: 2 } };
const form = {
  address: "you@example.com",
  host: "imap.example.com",
  port: 993,
  password: "app-password",
};

const call = (channel: string, event: unknown, payload?: unknown) => {
  const handler = handlers.get(channel);
  if (handler === undefined) throw new Error(`no handler for ${channel}`);
  return Promise.resolve(handler(event, payload));
};

let cleanAdd: ReturnType<typeof vi.fn>;
let accountRemove: ReturnType<typeof vi.fn>;
let onError: ReturnType<typeof vi.fn>;

beforeEach(() => {
  handlers.clear();
  asked.length = 0;
  cleanAdd = vi.fn(async (_: unknown, request: { confirm: () => Promise<boolean> }) =>
    (await request.confirm()) ? "saved" : "cancelled",
  );
  accountRemove = vi.fn(
    async (_: string, request: { confirmClean: (l: string) => Promise<boolean> }) =>
      (await request.confirmClean("you@example.com")) ? "removed" : "cancelled",
  );
  onError = vi.fn();
  const window = new ManageWindow("assets", {
    cleanAdd,
    accountRemove,
    onError,
    mxrouteList: () =>
      Promise.resolve({
        accounts: [],
        keys: [],
        keysUnreadable: false,
        clean: [{ accountId: "you@example.com", label: "you@example.com" }],
      }),
  } as unknown as Handlers);
  window.show();
});

describe("manage:clean-add", () => {
  it("refuses a sender that is not the page", async () => {
    expect(await call("manage:clean-add", stranger, form)).toBe("denied");
    expect(cleanAdd).not.toHaveBeenCalled();
  });

  it("refuses a bad payload with no word about it", async () => {
    expect(await call("manage:clean-add", trusted, { ...form, port: 0 })).toBe("invalid");
    expect(await call("manage:clean-add", trusted, { ...form, extra: 1 })).toBe("invalid");
    expect(cleanAdd).not.toHaveBeenCalled();
  });

  it("asks in the main process, naming the server and the port", async () => {
    expect(await call("manage:clean-add", trusted, form)).toBe("saved");
    expect(asked[0]?.detail).toContain("imap.example.com, port 993");
    expect(asked[0]?.detail).toContain("you@example.com");
    expect(asked[0]?.detail).not.toContain("app-password");
    expect(asked[0]?.detail).toContain("last 30 days of mail from everyone on your block list");
    expect(asked[0]?.detail).toContain("counts as your own");
  });

  it("says so when the server is outside the address's domain", async () => {
    await call("manage:clean-add", trusted, form);
    expect(asked[0]?.detail).not.toContain("not part of");
    await call("manage:clean-add", trusted, { ...form, host: "imap.example.net" });
    expect(asked[1]?.detail).toContain("This server is not part of example.com.");
  });

  it("says nothing of Senderban's own server for that domain, and speaks up for any other", async () => {
    const icloud = { ...form, address: "you@icloud.com" };
    await call("manage:clean-add", trusted, { ...icloud, host: "imap.mail.me.com" });
    expect(asked[0]?.detail).not.toContain("not part of");
    await call("manage:clean-add", trusted, { ...icloud, host: "imap.example.net" });
    expect(asked[1]?.detail).toContain("not part of icloud.com");
  });

  it("offers a restart once saved", async () => {
    await call("manage:clean-add", trusted, form);
    const page = (await call("manage:mxroute-list", trusted)) as Record<string, unknown>;
    expect(page.restartPending).toBe(true);
  });

  it("runs one add at a time", async () => {
    let finish: (reply: string) => void = () => undefined;
    cleanAdd.mockReturnValueOnce(
      new Promise((resolve) => {
        finish = resolve;
      }),
    );
    const first = call("manage:clean-add", trusted, form);
    expect(await call("manage:clean-add", trusted, form)).toBe("busy");
    finish("saved");
    expect(await first).toBe("saved");
  });

  it("reports a failure as a fixed word, and logs it under the channel", async () => {
    cleanAdd.mockRejectedValueOnce(new Error("server said app-password"));
    expect(await call("manage:clean-add", trusted, form)).toBe("failed");
    expect(onError).toHaveBeenCalledWith("manage:clean-add", expect.any(Error));
  });
});

describe("the page's list", () => {
  it("brings the mailboxes and the form's limits", async () => {
    const page = (await call("manage:mxroute-list", trusted)) as Record<string, unknown>;
    expect(page.clean).toEqual([{ accountId: "you@example.com", label: "you@example.com" }]);
    expect(page.cleanLimits).toMatchObject({ port: { min: 1, max: 65_535 } });
  });
});

describe("removing", () => {
  it("does not speak of rules on a server for a cleaning account", async () => {
    expect(await call("manage:account-remove", trusted, "you@example.com")).toBe("removed");
    expect(asked[0]?.detail).toContain("stops moving mail");
    expect(asked[0]?.detail).not.toContain("deletes its rules");
  });
});
