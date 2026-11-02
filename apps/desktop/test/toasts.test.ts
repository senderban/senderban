import { DEFAULT_SETTINGS, createActivationSigner } from "@senderban/core";
import type { MailToast, Settings } from "@senderban/core";
import { join, sep } from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";

const created: FakeNotification[] = [];
const activate = vi.hoisted((): { click: (details: unknown) => void; registeredAfter: number } => ({
  click: () => undefined,
  registeredAfter: -1,
}));

// Just enough of Electron's Notification: it records what was created and closed.
vi.mock("electron", () => {
  class FakeNotification {
    static handleActivation = (handler: (details: unknown) => void): void => {
      activate.click = handler;
      activate.registeredAfter = created.length;
    };
    closed = false;
    shown = false;
    constructor(readonly options: { readonly toastXml?: string; readonly body?: string }) {
      created.push(this);
    }
    listeners = new Map<string, () => void>();
    on = (name: string, listener: () => void): void => {
      this.listeners.set(name, listener);
    };
    show = (): void => {
      this.shown = true;
    };
    close = (): void => {
      this.closed = true;
    };
  }
  return { Notification: FakeNotification };
});

interface FakeNotification {
  closed: boolean;
  shown: boolean;
  listeners: Map<string, () => void>;
  options: { readonly toastXml?: string; readonly body?: string };
}

const { Toasts, spamStripUrls } = await import("../src/toasts.js");

const STRIPS = spamStripUrls(join("C:", sep, "Senderban", "assets"));

const uuid = (n: number): string => `00000000-0000-4000-8000-${n.toString(16).padStart(12, "0")}`;
const toast = (n: number) => ({
  id: uuid(n),
  sender: "a@example.com",
  subject: "hi",
  account: "me",
  spamScore: null,
  domain: null,
  rejectsAtServer: false,
});

beforeEach(() => {
  created.length = 0;
});

describe("the person's settings", () => {
  const ID = uuid(1);
  let settings: Settings;
  const make = (tone: "ok" | "warn" | "error") => {
    const made = build(tone);
    created.length = 0;
    return made;
  };
  const build = (tone: "ok" | "warn" | "error") => {
    const choose = vi.fn(() => Promise.resolve({ tone, text: "done" }));
    const quiet = vi.fn(() => Promise.resolve({ tone, text: "quiet done" }));
    const onRefused = vi.fn();
    const held: string[] = [];
    const reopen = vi.fn((): Promise<MailToast | { tone: "ok" | "warn" | "error"; text: string }> =>
      Promise.resolve({ ...toast(1), subject: "rebuilt" }),
    );
    return {
      choose,
      quiet,
      reopen,
      onRefused,
      held,
      toasts: new Toasts({
        settings: () => settings,
        spamStrips: STRIPS,
        signer: () => Promise.resolve(null),
        choose,
        quiet,
        reopen,
        onActivation: () => undefined,
        onIgnored: () => undefined,
        onRefused,
        onError: () => undefined,
        hold: async <T>(work: () => Promise<T>): Promise<T> => {
          held.push("start");
          const value = await work();
          held.push("end");
          return value;
        },
      }),
    };
  };
  const click = async (): Promise<void> => {
    activate.click({ arguments: `act=sender;id=${ID}` });
    await new Promise((resolve) => setImmediate(resolve));
  };

  beforeEach(() => {
    settings = DEFAULT_SETTINGS;
  });

  it("creates the Notification a click made while the app was closed needs, before listening, and never shows it", () => {
    build("ok");
    expect(activate.registeredAfter).toBe(1);
    expect(created).toHaveLength(1);
    expect(created[0]?.shown).toBe(false);
  });

  describe("a click on the toast's body", () => {
    const body = async (): Promise<void> => {
      activate.click({ arguments: `act=open;id=${ID}` });
      await new Promise((resolve) => setImmediate(resolve));
    };

    it("shows the same toast again, kept on screen, and blocks nothing", async () => {
      const { toasts, choose, quiet, reopen } = make("ok");
      toasts.show({ ...toast(1), subject: "the mail's own subject" });
      created.length = 0;
      await body();
      expect(reopen).toHaveBeenCalledOnce();
      expect(choose).not.toHaveBeenCalled();
      expect(quiet).not.toHaveBeenCalled();
      expect(created).toHaveLength(1);
      expect(created[0]?.shown).toBe(true);
      expect(created[0]?.options.toastXml).toContain('<toast scenario="reminder"');
      expect(created[0]?.options.toastXml).toContain(
        "the mail's own subject".replace("'", "&apos;"),
      );
      expect(created[0]?.options.toastXml).toContain('content="This sender"');
    });

    it("uses what the app can rebuild for a toast of an earlier run", async () => {
      const { reopen } = make("ok");
      await body();
      expect(reopen).toHaveBeenCalledOnce();
      expect(created[0]?.options.toastXml).toContain("rebuilt");
    });

    it("says why when there is no toast to show", async () => {
      const { reopen } = make("ok");
      reopen.mockResolvedValue({ tone: "warn", text: "Already handled." });
      await body();
      expect(created).toHaveLength(1);
      expect(created[0]?.options.body).toBe("! Already handled.");
    });

    it("a block after it still runs once, and the id is free again", async () => {
      const { choose } = make("ok");
      await body();
      await click();
      expect(choose).toHaveBeenCalledOnce();
    });
  });

  it("stays quiet after a block that worked, with confirmation off", async () => {
    const { choose } = make("ok");
    await click();
    expect(choose).toHaveBeenCalledOnce();
    expect(created).toHaveLength(0);
  });

  it("confirms a block that worked, with confirmation on", async () => {
    settings = { ...DEFAULT_SETTINGS, confirmBlocks: true };
    make("ok");
    await click();
    expect(created[0]?.options.body).toBe("done");
  });

  it.each([
    ["warn", "! done"],
    ["error", "✗ done"],
  ] as const)("always shows a %s", async (tone, body) => {
    make(tone);
    await click();
    expect(created[0]?.options.body).toBe(body);
  });

  it("hands a click with no choice the default action of that moment", async () => {
    const { choose } = make("ok");
    settings = { ...DEFAULT_SETTINGS, defaultAction: "trash" };
    await click();
    expect(choose).toHaveBeenCalledWith(ID, "address", "trash", undefined);
  });

  it("builds a toast from the settings of that moment", () => {
    const { toasts } = make("ok");
    settings = { ...DEFAULT_SETTINGS, toastDuration: "short", defaultAction: "trash" };
    toasts.show(toast(1));
    expect(created[0]?.options.toastXml).toContain('<toast duration="short"');
    expect(created[0]?.options.toastXml).toContain('defaultInput="trash"');
  });

  it("sends Don't ask again to the list, never to a block", async () => {
    const { choose, quiet } = make("ok");
    activate.click({ arguments: `act=sender;id=${ID}`, userInputs: { target: "quiet" } });
    await new Promise((resolve) => setImmediate(resolve));
    expect(quiet).toHaveBeenCalledWith(ID, "address", undefined);
    expect(choose).not.toHaveBeenCalled();
  });

  it("runs a block and a Don't ask again click as a held step, so a restart after an add waits for both", async () => {
    const { held } = make("ok");
    await click();
    activate.click({ arguments: `act=sender;id=${ID}`, userInputs: { target: "quiet" } });
    await new Promise((resolve) => setImmediate(resolve));
    expect(held).toEqual(["start", "end", "start", "end"]);
  });

  it("reports a toast Windows refused, and stops tracking it", () => {
    const { toasts, onRefused } = make("ok");
    toasts.show(toast(1));
    created[0]?.listeners.get("failed")?.();
    expect(onRefused).toHaveBeenCalledOnce();
    toasts.closeAll();
    expect(created[0]?.closed).toBe(false);
  });

  it("gives a toast with a score its strip", () => {
    const { toasts } = make("ok");
    toasts.show({ ...toast(1), spamScore: 9 });
    expect(created[0]?.options.toastXml).toContain(`<image src="${STRIPS.high}"`);
  });
});

describe("spamStripUrls", () => {
  it("points a development build at the assets folder", () => {
    const urls = spamStripUrls(join("C:", sep, "my folder", "assets"));
    expect(urls.high).toMatch(/^file:\/\/.*my%20folder\/assets\/toast\/spam-high\.png$/u);
    expect(urls.low).toMatch(/spam-low\.png$/u);
    expect(urls.medium).toMatch(/spam-medium\.png$/u);
  });

  it("points an installed build outside app.asar, where Windows can read the file", () => {
    const urls = spamStripUrls(join("C:", sep, "Senderban", "resources", "app.asar", "assets"));
    expect(urls.high).toContain("/resources/app.asar.unpacked/assets/toast/spam-high.png");
  });
});

describe("Toasts tracking", () => {
  it("keeps at most 50 live toasts, dropping the oldest", () => {
    const toasts = new Toasts({
      settings: () => DEFAULT_SETTINGS,
      spamStrips: STRIPS,
      signer: () => Promise.resolve(null),
      choose: () => Promise.resolve({ tone: "ok", text: "" }),
      quiet: () => Promise.resolve({ tone: "ok", text: "" }),
      reopen: () => Promise.resolve({ tone: "ok", text: "" }),
      onActivation: () => undefined,
      onIgnored: () => undefined,
      onRefused: () => undefined,
      onError: () => undefined,
      hold: (work) => work(),
    });
    created.length = 0;
    for (let n = 0; n < 60; n += 1) toasts.show(toast(n));
    expect(created).toHaveLength(60);

    toasts.closeAll();
    const closed = created.filter((notification) => notification.closed);
    expect(closed).toHaveLength(50);
    // The ten oldest were forgotten before quit; the newest fifty are the ones closed.
    expect(created.slice(0, 10).every((notification) => !notification.closed)).toBe(true);
    expect(created.slice(10).every((notification) => notification.closed)).toBe(true);

    // A second call finds nothing left to close.
    created.forEach((notification) => {
      notification.closed = false;
    });
    toasts.closeAll();
    expect(created.some((notification) => notification.closed)).toBe(false);
  });

  it("keeps a toast shown again among the newest, not the first to be dropped", () => {
    const toasts = new Toasts({
      settings: () => DEFAULT_SETTINGS,
      spamStrips: STRIPS,
      signer: () => Promise.resolve(null),
      choose: () => Promise.resolve({ tone: "ok", text: "" }),
      quiet: () => Promise.resolve({ tone: "ok", text: "" }),
      reopen: () => Promise.resolve({ tone: "ok", text: "" }),
      onActivation: () => undefined,
      onIgnored: () => undefined,
      onRefused: () => undefined,
      onError: () => undefined,
      hold: (work) => work(),
    });
    created.length = 0;
    for (let n = 0; n < 50; n += 1) toasts.show(toast(n));
    toasts.show(toast(0), true);
    toasts.show(toast(50));
    toasts.closeAll();
    // Toast 1 was the oldest after toast 0 was shown again, so it is the one forgotten; the second copy of toast 0 is still closed.
    expect(created[1]?.closed).toBe(false);
    expect(created[50]?.closed).toBe(true);
    expect(created[51]?.closed).toBe(true);
  });
});

describe("a click that outlives the app, through the toast", () => {
  const signer = createActivationSigner(Buffer.alloc(32, 3));
  const build = () => {
    const choose = vi.fn((...args: unknown[]) =>
      Promise.resolve({ tone: "ok" as const, text: String(args.length) }),
    );
    const onIgnored = vi.fn();
    const toasts = new Toasts({
      settings: () => DEFAULT_SETTINGS,
      spamStrips: STRIPS,
      signer: () => Promise.resolve(signer),
      choose,
      quiet: () => Promise.resolve({ tone: "ok", text: "" }),
      reopen: () => Promise.resolve({ tone: "ok", text: "" }),
      onActivation: () => undefined,
      onIgnored,
      onRefused: () => undefined,
      onError: () => undefined,
      hold: (work) => work(),
    });
    return { toasts, choose, onIgnored };
  };
  const settle = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));
  /** The `arguments` of the first button of the last toast shown. */
  const buttonArguments = (): string => {
    const xml = created.at(-1)?.options.toastXml ?? "";
    const found = /action content="This sender" arguments="([^"]*)"/u.exec(xml);
    return found?.[1] ?? "";
  };

  it("hands the sender of a signed button to the click, as the restore of an earlier run", async () => {
    const { toasts, choose } = build();
    await settle();
    toasts.show({ ...toast(1), accountId: "acct-1", issuedAt: 1_700_000_000 });
    activate.click({ arguments: buttonArguments() });
    await settle();
    expect(choose.mock.calls[0]?.[3]).toEqual({
      accountId: "acct-1",
      sender: "a@example.com",
      issuedAt: 1_700_000_000,
    });
  });

  it("refuses a button whose sender was changed after it was signed", async () => {
    const { toasts, choose, onIgnored } = build();
    await settle();
    toasts.show({ ...toast(1), accountId: "acct-1", issuedAt: 1_700_000_000 });
    activate.click({ arguments: buttonArguments().replace("from=a@", "from=b@") });
    await settle();
    expect(choose).not.toHaveBeenCalled();
    expect(onIgnored).toHaveBeenCalledWith("tail-refused");
  });
});
