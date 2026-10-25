import { join } from "node:path";
import {
  ACCOUNT_ID,
  MXROUTE_LIMITS,
  MxrouteEnableSchema,
  MxrouteInputSchema,
  POPUP_SECONDS,
  SettingsSchema,
  isEntryId,
} from "@senderban/core";
import type { BlockEntry } from "@senderban/core";
import { BrowserWindow, ipcMain, nativeTheme } from "electron";
import type { IpcMainInvokeEvent } from "electron";

const PAGE = "manage/manage.html";

/** What the page may know about an account's MXroute key: never the key, never its ciphertext. */
export interface ManageMxrouteAccount {
  readonly accountId: string;
  readonly label: string;
  readonly hasKey: boolean;
  readonly enabled: boolean;
  readonly server: string | null;
  readonly username: string | null;
}

/** What the page shows after an unblock; the same line the person reads in the window. */
export interface ManageOutcome {
  readonly tone: "ok" | "warn" | "error";
  readonly text: string;
}

export interface ManageHandlers {
  /** The device block list, oldest first. */
  readonly list: () => readonly BlockEntry[];
  /** Takes the entry off the list and every account; describes what happened. */
  readonly unblock: (id: string) => Promise<ManageOutcome>;
  readonly getSeconds: () => number;
  /** Persists the value and returns what is now in effect. */
  readonly setSeconds: (seconds: number) => Promise<number>;
  /** Advanced: the accounts with their MXroute key status (the key itself stays in the main process). */
  readonly mxrouteList: () => Promise<readonly ManageMxrouteAccount[]>;
  /** Stores the key encrypted. The input has already passed the core schema. */
  readonly mxrouteSave: (
    input: ReturnType<typeof MxrouteInputSchema.parse>,
  ) => Promise<MxrouteOutcome>;
  readonly mxrouteRemove: (accountId: string) => Promise<MxrouteOutcome>;
  /** Switches the account's MXroute blacklist on or off (takes effect when Senderban starts). */
  readonly mxrouteEnable: (accountId: string, enabled: boolean) => Promise<MxrouteOutcome>;
  /** A handler threw: the log gets the channel and a sanitised message, the page a generic failure. */
  readonly onError: (channel: string, error: unknown) => void;
}

/**
 * The "Blocked senders" window (ADR 0005): the block list with an Unblock button per entry, and the
 * settings. One instance. The renderer is untrusted: sandboxed, no Node, and every payload is
 * re-validated here (entry ids as UUIDs, seconds with the core schema).
 */
export class ManageWindow {
  readonly #assets: string;
  readonly #handlers: ManageHandlers;
  #win: BrowserWindow | null = null;
  /** One unblock at a time: a second click while one runs must not start another sync round. */
  #unblocking = false;

  constructor(assetsDir: string, handlers: ManageHandlers) {
    this.#assets = assetsDir;
    this.#handlers = handlers;
    ipcMain.handle("manage:init", (event) => this.#init(event));
    ipcMain.handle("manage:unblock", (event, id: unknown) => this.#unblock(event, id));
    ipcMain.handle("manage:save-seconds", (event, value: unknown) => this.#save(event, value));
    ipcMain.handle("manage:mxroute-list", (event) => this.#mxrouteList(event));
    ipcMain.handle("manage:mxroute-save", (event, value: unknown) =>
      this.#mxrouteSave(event, value),
    );
    ipcMain.handle("manage:mxroute-remove", (event, id: unknown) => this.#mxrouteRemove(event, id));
    ipcMain.handle("manage:mxroute-enable", (event, value: unknown) =>
      this.#mxrouteEnable(event, value),
    );
  }

  /** Opens the window, or brings the open one to the front. */
  show(): void {
    const existing = this.#win;
    if (existing !== null && !existing.isDestroyed()) {
      if (existing.isMinimized()) existing.restore();
      existing.focus();
      return;
    }
    const win = new BrowserWindow({
      width: 720,
      height: 600,
      minWidth: 520,
      minHeight: 420,
      show: false,
      title: "Senderban — Blocked senders",
      icon: join(this.#assets, "icon.ico"),
      autoHideMenuBar: true,
      backgroundColor: nativeTheme.shouldUseDarkColors ? "#1c1f24" : "#ffffff",
      webPreferences: {
        preload: join(this.#assets, "manage/preload.cjs"),
        sandbox: true,
        contextIsolation: true,
        nodeIntegration: false,
        spellcheck: false,
        devTools: false,
      },
    });
    win.removeMenu();
    win.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
    win.webContents.on("will-navigate", (event) => {
      event.preventDefault();
    });
    win.once("ready-to-show", () => {
      win.show();
    });
    win.on("closed", () => {
      if (this.#win === win) this.#win = null;
    });
    this.#win = win;
    void win.loadFile(join(this.#assets, PAGE));
  }

  /** The list changed outside the window (a popup blocked a sender): the open page asks for it again. */
  notifyChanged(): void {
    if (this.#win !== null && !this.#win.isDestroyed())
      this.#win.webContents.send("manage:changed");
  }

  closeAll(): void {
    if (this.#win !== null && !this.#win.isDestroyed()) this.#win.close();
  }

  /** True only for a message from our manage page in our manage window; any other sender is ignored. */
  #trusted(event: IpcMainInvokeEvent): boolean {
    const win = this.#win;
    if (win === null || win.isDestroyed() || event.sender.id !== win.webContents.id) return false;
    // The window only ever loads our page (navigation and new windows are blocked), so its main frame is that page.
    // Compared by frame identity, not by URL: Electron leaves a bare % in a folder name raw in the URL.
    const frame = event.senderFrame;
    const main = win.webContents.mainFrame;
    return (
      frame !== null && frame.processId === main.processId && frame.routingId === main.routingId
    );
  }

  #init(event: IpcMainInvokeEvent) {
    if (!this.#trusted(event)) return null;
    try {
      return {
        entries: this.#handlers.list(),
        seconds: this.#handlers.getSeconds(),
        limits: { min: POPUP_SECONDS.min, max: POPUP_SECONDS.max },
      };
    } catch (error) {
      this.#handlers.onError("manage:init", error);
      return null;
    }
  }

  async #unblock(event: IpcMainInvokeEvent, id: unknown) {
    if (!this.#trusted(event) || !isEntryId(id) || this.#unblocking) return null;
    this.#unblocking = true;
    try {
      const outcome = await this.#handlers.unblock(id);
      return { ...outcome, entries: this.#handlers.list() };
    } catch (error) {
      this.#handlers.onError("manage:unblock", error);
      return null;
    } finally {
      this.#unblocking = false;
    }
  }

  async #save(event: IpcMainInvokeEvent, value: unknown): Promise<number | null> {
    if (!this.#trusted(event)) return null;
    const parsed = SettingsSchema.safeParse({ version: 1, popupSeconds: value });
    if (!parsed.success) return null;
    try {
      return await this.#handlers.setSeconds(parsed.data.popupSeconds);
    } catch (error) {
      this.#handlers.onError("manage:save-seconds", error);
      return null;
    }
  }

  async #mxrouteList(event: IpcMainInvokeEvent) {
    if (!this.#trusted(event)) return null;
    try {
      // The limits come from here so the page never invents its own numbers.
      return { accounts: await this.#handlers.mxrouteList(), limits: MXROUTE_LIMITS };
    } catch (error) {
      this.#handlers.onError("manage:mxroute-list", error);
      return null;
    }
  }

  /** The reply is a fixed word, never the input and never an error text: the key must not travel back. */
  async #mxrouteSave(event: IpcMainInvokeEvent, value: unknown): Promise<MxrouteReply> {
    if (!this.#trusted(event)) return "denied";
    const parsed = MxrouteInputSchema.safeParse(value);
    if (!parsed.success) return "invalid";
    try {
      return await this.#handlers.mxrouteSave(parsed.data);
    } catch (error) {
      this.#handlers.onError("manage:mxroute-save", error);
      return "failed";
    }
  }

  async #mxrouteEnable(event: IpcMainInvokeEvent, value: unknown): Promise<MxrouteReply> {
    if (!this.#trusted(event)) return "denied";
    const parsed = MxrouteEnableSchema.safeParse(value);
    if (!parsed.success) return "invalid";
    try {
      return await this.#handlers.mxrouteEnable(parsed.data.accountId, parsed.data.enabled);
    } catch (error) {
      this.#handlers.onError("manage:mxroute-enable", error);
      return "failed";
    }
  }

  async #mxrouteRemove(event: IpcMainInvokeEvent, id: unknown): Promise<MxrouteReply> {
    if (!this.#trusted(event)) return "denied";
    if (typeof id !== "string" || !ACCOUNT_ID.test(id)) return "invalid";
    try {
      return await this.#handlers.mxrouteRemove(id);
    } catch (error) {
      this.#handlers.onError("manage:mxroute-remove", error);
      return "failed";
    }
  }
}

/** What the main process says about a key change; each one is a fixed word the page turns into a sentence. */
export type MxrouteOutcome =
  "saved" | "unknown-account" | "no-key" | "no-domain" | "key-refused" | "unreachable";
type MxrouteReply = MxrouteOutcome | "invalid" | "denied" | "failed";
