import { join } from "node:path";
import { ACTIONS, BLOCK_SCOPES, isNotificationId } from "@senderban/core";
import type { BlockAction, BlockScope } from "@senderban/core";
import { BrowserWindow, ipcMain, nativeTheme, screen } from "electron";
import type { IpcMainEvent, IpcMainInvokeEvent } from "electron";

const WIDTH = 380;
const MAIL_HEIGHT = 200;
const NOTICE_HEIGHT = 104;
const MARGIN = 12;
const GAP = 8;
// Scale budget: the watcher announces at most 5 messages per drain per account, so this is a burst
// bound, not a steady rate. Beyond the visible stack the rest wait; beyond the queue the oldest is
// dropped (and counted) so a flood cannot grow memory or cover the screen.
const MAX_VISIBLE = 4;
const MAX_QUEUED = 50;

export interface PopupModel {
  /** Pending-block id for a mail popup; null for a notice, which has no buttons. */
  readonly id: string | null;
  readonly title: string;
  readonly body: string;
  /** The account the mail arrived in, as the person knows it (their address). */
  readonly account: string | null;
  /** Domain offered as the second button; null when it must not be offered. */
  readonly domain: string | null;
}

export type PopupView =
  | { readonly phase: "idle" }
  | { readonly phase: "working"; readonly text: string }
  | { readonly phase: "done"; readonly tone: "ok" | "warn" | "error"; readonly text: string };

export interface PopupHandlers {
  /** Runs the block and describes the outcome for the same popup. */
  readonly choose: (id: string, scope: BlockScope, action: BlockAction) => Promise<PopupView>;
  readonly getSeconds: () => number;
  /** The gear: opens the Blocked senders window, where the settings live (ADR 0005). */
  readonly openSettings: () => void;
  readonly onDropped: (count: number) => void;
}

interface Live {
  readonly win: BrowserWindow;
  readonly model: PopupModel;
  readonly height: number;
  view: PopupView;
  timer: ReturnType<typeof setTimeout> | null;
  hovered: boolean;
}

const PAGE = "popup/popup.html";

/**
 * Frameless always-on-top popups in the bottom-right corner (ADR 0004). The renderer is untrusted:
 * it runs sandboxed with no Node, can only call the channels below, and every payload is
 * re-validated here against the core schemas.
 */
export class Popups {
  readonly #assets: string;
  readonly #handlers: PopupHandlers;
  readonly #live = new Map<number, Live>();
  readonly #queue: PopupModel[] = [];

  constructor(assetsDir: string, handlers: PopupHandlers) {
    this.#assets = assetsDir;
    this.#handlers = handlers;
    ipcMain.handle("popup:init", (event) => this.#init(event));
    ipcMain.handle("popup:choose", (event, scope: unknown, action: unknown) =>
      this.#choose(event, scope, action),
    );
    ipcMain.on("popup:hover", (event, value: unknown) => {
      const popup = this.#from(event);
      if (popup === null) return;
      popup.hovered = value === true;
      this.#arm(popup);
    });
    ipcMain.on("popup:open-settings", (event) => {
      if (this.#from(event) !== null) this.#handlers.openSettings();
    });
    ipcMain.on("popup:close", (event) => {
      this.#from(event)?.win.close();
    });
  }

  show(model: PopupModel): void {
    if (this.#live.size >= MAX_VISIBLE) {
      this.#queue.push(model);
      const over = this.#queue.length - MAX_QUEUED;
      if (over > 0) {
        this.#queue.splice(0, over);
        this.#handlers.onDropped(over);
      }
      return;
    }
    this.#open(model);
  }

  /** Closes every popup; called at quit. */
  closeAll(): void {
    this.#queue.length = 0;
    for (const popup of this.#live.values()) popup.win.close();
  }

  #open(model: PopupModel): void {
    const height = model.id === null ? NOTICE_HEIGHT : MAIL_HEIGHT;
    const win = new BrowserWindow({
      width: WIDTH,
      height,
      show: false,
      frame: false,
      resizable: false,
      movable: false,
      minimizable: false,
      maximizable: false,
      fullscreenable: false,
      skipTaskbar: true,
      alwaysOnTop: true,
      backgroundColor: nativeTheme.shouldUseDarkColors ? "#1c1f24" : "#ffffff",
      webPreferences: {
        preload: join(this.#assets, "popup/preload.cjs"),
        sandbox: true,
        contextIsolation: true,
        nodeIntegration: false,
        spellcheck: false,
        devTools: false,
      },
    });
    const popup: Live = {
      win,
      model,
      height,
      view: { phase: "idle" },
      timer: null,
      hovered: false,
    };
    const key = win.webContents.id;
    this.#live.set(key, popup);

    win.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
    win.webContents.on("will-navigate", (event) => {
      event.preventDefault();
    });
    win.once("ready-to-show", () => {
      this.#layout();
      win.showInactive();
      this.#arm(popup);
    });
    win.on("closed", () => {
      if (popup.timer !== null) clearTimeout(popup.timer);
      this.#live.delete(key);
      this.#layout();
      const next = this.#queue.shift();
      if (next !== undefined) this.#open(next);
    });
    void win.loadFile(join(this.#assets, PAGE));
  }

  /** Newest popup at the bottom, older ones stacked above it. */
  #layout(): void {
    const area = screen.getPrimaryDisplay().workArea;
    let bottom = area.y + area.height - MARGIN;
    for (const popup of [...this.#live.values()].reverse()) {
      if (popup.win.isDestroyed()) continue;
      popup.win.setBounds({
        x: area.x + area.width - MARGIN - WIDTH,
        y: bottom - popup.height,
        width: WIDTH,
        height: popup.height,
      });
      bottom -= popup.height + GAP;
    }
  }

  /** Closes after the configured seconds, but never while the person is reading or the block is running. */
  #arm(popup: Live): void {
    if (popup.timer !== null) clearTimeout(popup.timer);
    popup.timer = null;
    if (popup.hovered || popup.view.phase === "working") return;
    popup.timer = setTimeout(() => {
      if (!popup.win.isDestroyed()) popup.win.close();
    }, this.#handlers.getSeconds() * 1000);
  }

  #setView(popup: Live, view: PopupView): void {
    popup.view = view;
    if (!popup.win.isDestroyed()) popup.win.webContents.send("popup:view", view);
    this.#arm(popup);
  }

  /** The popup a message came from, or null for any other sender (another window, a foreign frame). */
  #from(event: IpcMainEvent | IpcMainInvokeEvent): Live | null {
    const popup = this.#live.get(event.sender.id);
    if (popup === undefined || popup.win.isDestroyed()) return null;
    const url = event.senderFrame?.url ?? "";
    return url.startsWith("file:") && url.endsWith(PAGE) ? popup : null;
  }

  #init(event: IpcMainInvokeEvent) {
    const popup = this.#from(event);
    if (popup === null) return null;
    return {
      model: popup.model,
      view: popup.view,
    };
  }

  async #choose(event: IpcMainInvokeEvent, scope: unknown, action: unknown): Promise<void> {
    const popup = this.#from(event);
    const id = popup?.model.id;
    if (popup === null || !isNotificationId(id)) return;
    if (!BLOCK_SCOPES.some((s) => s === scope) || !ACTIONS.some((a) => a === action)) return;
    if (popup.view.phase !== "idle") return;

    this.#setView(popup, { phase: "working", text: "Blocking…" });
    let view: PopupView;
    try {
      view = await this.#handlers.choose(id, scope as BlockScope, action as BlockAction);
    } catch {
      view = { phase: "done", tone: "error", text: "Something went wrong. See the log." };
    }
    this.#setView(popup, view);
  }
}
