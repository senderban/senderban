import { join } from "node:path";
import { POPUP_SECONDS, SettingsSchema, isEntryId } from "@senderban/core";
import type { BlockEntry } from "@senderban/core";
import { BrowserWindow, ipcMain, nativeTheme } from "electron";
import type { IpcMainInvokeEvent } from "electron";

const PAGE = "manage/manage.html";

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
}
