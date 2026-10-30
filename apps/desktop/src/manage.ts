import { join } from "node:path";
import {
  ACCOUNT_ADD_LIMITS,
  ACCOUNT_ID,
  AccountAddSchema,
  GOOGLE_CLIENT_ID_PATTERN,
  GOOGLE_CLIENT_LIMITS,
  GOOGLE_CLIENT_SECRET_PATTERN,
  GoogleClientInputSchema,
  GoogleSignInRequestSchema,
  MXROUTE_LIMITS,
  MxrouteEnableSchema,
  MxrouteInputSchema,
  MxrouteKeyRefSchema,
  WatchPausedSchema,
  isEntryId,
} from "@senderban/core";
import type {
  AccountAddInput,
  BlockEntry,
  GoogleClientInput,
  MxrouteEnableInput,
  MxrouteInput,
  MxrouteKeyRef,
} from "@senderban/core";
import { BrowserWindow, dialog, ipcMain, nativeTheme } from "electron";
import type { IpcMainInvokeEvent } from "electron";
import type { AccountAddResult } from "./add-account.js";
import type {
  GoogleClientReply,
  GooglePageState,
  GoogleRemoveReply,
  GoogleSignInOutcome,
} from "./google-accounts.js";
import type { MxroutePage, MxrouteSaveResult } from "./mxroute-settings.js";
import type { AccountRemoveResult } from "./remove-account.js";

const PAGE = "manage/manage.html";

/** Milliseconds. A wake-up flips every watcher (50 accounts, two states each): the open page hears it about twice a second, not 100 times. */
const STATUS_PUSH_GAP_MS = 500;

/** What the page shows after an unblock; the same line the person reads in the window. */
export interface ManageOutcome {
  readonly tone: "ok" | "warn" | "error";
  readonly text: string;
}

/**
 * One row of the window: the list entry, and what a signed-in Gmail account does with it (`null`: no Gmail account, say nothing).
 * `own`: the entry reaches the person's own mail, so no account applies it (it can only be unblocked).
 */
export type ManageEntry = BlockEntry & {
  readonly gmail: "trash" | "no" | null;
  readonly own: boolean;
};

/** What the window lends an add: the question only the main process can ask, and the end of the window as a signal. */
export interface AccountAddRequest {
  readonly confirm: () => Promise<boolean>;
  readonly signal: AbortSignal;
}

/** What the window's side bar and account rows show. `state`: null when no watcher runs for the account yet (added, restart due). */
export interface WatchStatus {
  readonly version: string;
  readonly paused: boolean;
  readonly accounts: readonly { readonly accountId: string; readonly state: string | null }[];
}

export interface AccountRemoveRequest {
  readonly confirm: (label: string) => Promise<boolean>;
  readonly confirmLeaveRules: (label: string) => Promise<boolean>;
}

export interface ManageHandlers {
  /** The device block list, oldest first. */
  readonly list: () => readonly ManageEntry[];
  /** Takes the entry off the list and every account; describes what happened. */
  readonly unblock: (id: string) => Promise<ManageOutcome>;
  /** The mailboxes and the MXroute keys (the key itself stays in the main process). */
  readonly mxrouteList: () => Promise<MxroutePage>;
  /** Stores the key encrypted. The input has already passed the core schema. */
  readonly mxrouteSave: (input: MxrouteInput) => Promise<MxrouteSaveResult>;
  /** Forgets a key on this device once the person said yes; no mailbox changes. */
  readonly mxrouteRemove: (
    ref: MxrouteKeyRef,
    confirm: () => Promise<boolean>,
  ) => Promise<MxrouteSaveResult>;
  /** Switches one domain's MXroute blacklist on or off (takes effect when Senderban starts). */
  readonly mxrouteEnable: (input: MxrouteEnableInput) => Promise<MxrouteSaveResult>;
  /** Tries the logins, then stores the account. The input has already passed the core schema. */
  readonly accountAdd: (
    input: AccountAddInput,
    request: AccountAddRequest,
  ) => Promise<AccountAddResult>;
  /** Deletes the account's rules from its server, then the account. */
  readonly accountRemove: (
    accountId: string,
    request: AccountRemoveRequest,
  ) => Promise<AccountRemoveResult>;
  /** Gmail: the app-wide client's ID and the Gmail accounts (never a token, never the secret). */
  readonly googleState: () => Promise<GooglePageState>;
  /** Stores the client; the input has already passed the core schema. */
  readonly googleSaveClient: (input: GoogleClientInput) => Promise<GoogleClientReply>;
  /** Opens the browser and waits for Google's answer (minutes): a new account, or `accountId` signed in again. */
  readonly googleSignIn: (request: { accountId?: string }) => Promise<GoogleSignInOutcome>;
  /** Stops a sign-in that is waiting for the browser. */
  readonly googleCancel: () => void;
  readonly googleRemove: (accountId: string) => Promise<GoogleRemoveReply>;
  /** Quits the way the tray's Quit does, then starts Senderban again (a Gmail sign-in is picked up at start). */
  readonly restart: () => void;
  /** The mailboxes and what their watchers are doing. Reads no provider. */
  readonly status: () => Promise<WatchStatus>;
  /** Pauses or resumes every watcher, as the tray's menu does. */
  readonly pause: (value: boolean) => Promise<void>;
  /** A handler threw: the log gets the channel and a sanitised message, the page a generic failure. */
  readonly onError: (channel: string, error: unknown) => void;
}

/**
 * The "Blocked senders" window (ADR 0005): the block list with an Unblock button per entry, and the
 * MXroute key panel. One instance. The renderer is untrusted: sandboxed, no Node, and every payload is
 * re-validated here (entry ids as UUIDs, key input with the core schema).
 */
export class ManageWindow {
  readonly #assets: string;
  readonly #handlers: ManageHandlers;
  #win: BrowserWindow | null = null;
  /** One unblock at a time: a second click while one runs must not start another sync round. */
  #unblocking = false;
  /** One account change at a time: an add signs in to a mail server twice with a password, a remove rewrites its rules. */
  #adding = false;
  /** Aborts the add in flight when the window closes: nobody is left to read its answer. */
  #addAbort: AbortController | null = null;
  /** An account changed since Senderban started, so the page keeps offering a restart, also after the window closed. */
  #restartPending = false;
  /** Steps in flight that change the list, an account or Google access: a restart waits for them (main side, not only the page). */
  #steps = 0;
  /** One pause at a time: a Pause waits for every IMAP logout, and a second click must not race it. */
  #pausing = false;
  /** Set while a status signal waits to go out. */
  #statusTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(assetsDir: string, handlers: ManageHandlers) {
    this.#assets = assetsDir;
    this.#handlers = handlers;
    ipcMain.handle("manage:init", (event) => this.#init(event));
    ipcMain.handle("manage:unblock", (event, id: unknown) => this.#unblock(event, id));
    ipcMain.handle("manage:mxroute-list", (event) => this.#mxrouteList(event));
    ipcMain.handle("manage:mxroute-save", (event, value: unknown) =>
      this.#mxrouteSave(event, value),
    );
    ipcMain.handle("manage:mxroute-remove", (event, value: unknown) =>
      this.#mxrouteRemove(event, value),
    );
    ipcMain.handle("manage:mxroute-enable", (event, value: unknown) =>
      this.#mxrouteEnable(event, value),
    );
    ipcMain.handle("manage:account-add", (event, value: unknown) => this.#accountAdd(event, value));
    ipcMain.handle("manage:account-remove", (event, id: unknown) => this.#accountRemove(event, id));
    ipcMain.handle("manage:google-state", (event) => this.#googleState(event));
    ipcMain.handle("manage:google-save-client", (event, value: unknown) =>
      this.#googleSaveClient(event, value),
    );
    ipcMain.handle("manage:google-sign-in", (event, value: unknown) =>
      this.#googleSignIn(event, value),
    );
    ipcMain.handle("manage:google-cancel", (event) => {
      this.#googleCancel(event);
    });
    ipcMain.handle("manage:google-remove", (event, id: unknown) => this.#googleRemove(event, id));
    ipcMain.handle("manage:restart", (event) => this.#restart(event));
    ipcMain.handle("manage:status", (event) => this.#status(event));
    ipcMain.handle("manage:pause", (event, value: unknown) => this.#pause(event, value));
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
      width: 900,
      height: 640,
      minWidth: 640,
      minHeight: 480,
      show: false,
      title: "Senderban",
      icon: join(this.#assets, "icon.ico"),
      autoHideMenuBar: true,
      backgroundColor: nativeTheme.shouldUseDarkColors ? "#07182b" : "#f4f8fb",
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
      if (this.#statusTimer !== null) clearTimeout(this.#statusTimer);
      this.#statusTimer = null;
      // A sign-in waits for the browser with its page open; without the page nobody sees the answer, so stop it.
      this.#handlers.googleCancel();
      // Closing the window during the check is giving up: the account must not be stored behind the person's back.
      this.#addAbort?.abort();
    });
    this.#win = win;
    void win.loadFile(join(this.#assets, PAGE));
  }

  /** The list changed outside the window (a popup blocked a sender): the open page asks for it again. */
  notifyChanged(): void {
    if (this.#win !== null && !this.#win.isDestroyed())
      this.#win.webContents.send("manage:changed");
  }

  /** A watcher changed state: the open page asks for the status, at most once per STATUS_PUSH_GAP_MS. No window, no work. */
  notifyStatus(): void {
    if (this.#win === null || this.#win.isDestroyed() || this.#statusTimer !== null) return;
    this.#statusTimer = setTimeout(() => {
      this.#statusTimer = null;
      if (this.#win !== null && !this.#win.isDestroyed())
        this.#win.webContents.send("manage:status-changed");
    }, STATUS_PUSH_GAP_MS);
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
      return { entries: this.#handlers.list() };
    } catch (error) {
      this.#handlers.onError("manage:init", error);
      return null;
    }
  }

  async #status(event: IpcMainInvokeEvent) {
    if (!this.#trusted(event)) return null;
    try {
      return { ...(await this.#handlers.status()), restartPending: this.#restartPending };
    } catch (error) {
      this.#handlers.onError("manage:status", error);
      return null;
    }
  }

  async #pause(event: IpcMainInvokeEvent, value: unknown): Promise<PauseReply> {
    if (!this.#trusted(event)) return "denied";
    const parsed = WatchPausedSchema.safeParse(value);
    if (!parsed.success) return "invalid";
    if (this.#pausing) return "busy";
    this.#pausing = true;
    try {
      await this.#step(() => this.#handlers.pause(parsed.data));
      return "done";
    } catch (error) {
      this.#handlers.onError("manage:pause", error);
      return "failed";
    } finally {
      this.#pausing = false;
    }
  }

  async #unblock(event: IpcMainInvokeEvent, id: unknown) {
    if (!this.#trusted(event) || !isEntryId(id) || this.#unblocking) return null;
    this.#unblocking = true;
    try {
      const outcome = await this.#step(() => this.#handlers.unblock(id));
      return { ...outcome, entries: this.#handlers.list() };
    } catch (error) {
      this.#handlers.onError("manage:unblock", error);
      return null;
    } finally {
      this.#unblocking = false;
    }
  }

  async #mxrouteList(event: IpcMainInvokeEvent) {
    if (!this.#trusted(event)) return null;
    try {
      // The limits come from here so the page never invents its own numbers.
      return {
        ...(await this.#handlers.mxrouteList()),
        limits: MXROUTE_LIMITS,
        addLimits: ACCOUNT_ADD_LIMITS,
        restartPending: this.#restartPending,
      };
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
      const result = await this.#step(() => this.#handlers.mxrouteSave(parsed.data));
      if (result === "saved") this.#restartPending = true;
      return result;
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
      const result = await this.#step(() => this.#handlers.mxrouteEnable(parsed.data));
      if (result === "saved") this.#restartPending = true;
      return result;
    } catch (error) {
      this.#handlers.onError("manage:mxroute-enable", error);
      return "failed";
    }
  }

  async #mxrouteRemove(event: IpcMainInvokeEvent, value: unknown): Promise<MxrouteReply> {
    if (!this.#trusted(event)) return "denied";
    const parsed = MxrouteKeyRefSchema.safeParse(value);
    if (!parsed.success) return "invalid";
    try {
      const result = await this.#step(() =>
        this.#handlers.mxrouteRemove(parsed.data, () =>
          this.#ask({
            message: `Remove the MXroute key for ${parsed.data.username}?`,
            detail:
              "Your mailboxes stay, and it can no longer be used for any of them. Addresses Senderban put on your MXroute blacklist stay there: Unblock cannot take them off without the key, so switch the blacklist off first, start Senderban once, or delete them in your MXroute panel. The key itself stays valid until you delete it at panel.mxroute.com/api-keys.php.",
            yes: "Remove key",
          }),
        ),
      );
      if (result === "saved") this.#restartPending = true;
      return result;
    } catch (error) {
      this.#handlers.onError("manage:mxroute-remove", error);
      return "failed";
    }
  }

  /** The reply is a fixed word, never the input and never an error text: the password must not travel back. */
  async #accountAdd(event: IpcMainInvokeEvent, value: unknown): Promise<AccountAddReply> {
    if (!this.#trusted(event)) return "denied";
    if (this.#adding) return "busy";
    const parsed = AccountAddSchema.safeParse(value);
    if (!parsed.success) return "invalid";
    this.#adding = true;
    const abort = new AbortController();
    this.#addAbort = abort;
    try {
      const { address, host } = parsed.data;
      const result = await this.#step(() =>
        this.#handlers.accountAdd(parsed.data, {
          confirm: () =>
            this.#ask({
              message: "Send this password to this server?",
              detail: `Server: ${host}\nAddress: ${address}\n\nWhoever runs that server receives the password, now and at every start. Compare the name with your MXroute welcome mail, letter by letter. The address's mail domain then counts as your own, which can take rules for that domain off your other accounts.`,
              yes: "Sign in",
              signal: abort.signal,
            }),
          signal: abort.signal,
        }),
      );
      if (result === "saved" || result === "saved-own-entries") this.#restartPending = true;
      return result;
    } catch (error) {
      this.#handlers.onError("manage:account-add", error);
      return "failed";
    } finally {
      this.#addAbort = null;
      this.#adding = false;
    }
  }

  async #accountRemove(event: IpcMainInvokeEvent, id: unknown): Promise<AccountRemoveReply> {
    if (!this.#trusted(event)) return "denied";
    if (typeof id !== "string" || !ACCOUNT_ID.test(id)) return "invalid";
    if (this.#adding) return "busy";
    this.#adding = true;
    try {
      const result = await this.#step(() =>
        this.#handlers.accountRemove(id, {
          confirm: (label) =>
            this.#ask({
              message: `Remove ${label}?`,
              detail:
                "Senderban deletes its rules from this mailbox and forgets the password on this device. Mail from blocked senders then reaches this inbox again. Your MXroute API key stays, and anything on your MXroute blacklist stays there.",
              yes: "Remove",
            }),
          confirmLeaveRules: (label) =>
            this.#ask({
              message: `Remove ${label} without deleting its rules?`,
              detail:
                "Senderban could not delete its rules from the mail server. They go on moving mail from blocked senders until you delete them at your provider.",
              yes: "Remove anyway",
            }),
        }),
      );
      if (result.startsWith("removed")) this.#restartPending = true;
      return result;
    } catch (error) {
      this.#handlers.onError("manage:account-remove", error);
      return "failed";
    } finally {
      this.#adding = false;
    }
  }

  /**
   * A question drawn by the main process: the page can neither draw this box nor click it, so it holds even against a page
   * that was taken over. Cancel is the default. Everything it names passed the core schemas.
   */
  async #ask(question: {
    message: string;
    detail: string;
    yes: string;
    signal?: AbortSignal;
  }): Promise<boolean> {
    const win = this.#win;
    if (win === null || win.isDestroyed()) return false;
    const { response } = await dialog.showMessageBox(win, {
      type: "question",
      title: "Senderban",
      message: question.message,
      detail: question.detail,
      buttons: ["Cancel", question.yes],
      defaultId: 0,
      cancelId: 0,
      noLink: true,
      ...(question.signal === undefined ? {} : { signal: question.signal }),
    });
    return response === 1;
  }

  async #googleState(event: IpcMainInvokeEvent) {
    if (!this.#trusted(event)) return null;
    try {
      // The limits come from here so the page never invents its own numbers.
      return {
        ...(await this.#handlers.googleState()),
        limits: GOOGLE_CLIENT_LIMITS,
        // The pattern attribute is anchored by the browser itself.
        idPattern: GOOGLE_CLIENT_ID_PATTERN.source.slice(1, -1),
        secretPattern: GOOGLE_CLIENT_SECRET_PATTERN.source.slice(1, -1),
      };
    } catch (error) {
      this.#handlers.onError("manage:google-state", error);
      return null;
    }
  }

  async #googleSaveClient(
    event: IpcMainInvokeEvent,
    value: unknown,
  ): Promise<GoogleClientReply | GoogleFailure["reply"]> {
    if (!this.#trusted(event)) return "denied";
    const parsed = GoogleClientInputSchema.safeParse(value);
    if (!parsed.success) return "invalid";
    try {
      return await this.#step(() => this.#handlers.googleSaveClient(parsed.data));
    } catch (error) {
      this.#handlers.onError("manage:google-save-client", error);
      return "failed";
    }
  }

  async #googleSignIn(
    event: IpcMainInvokeEvent,
    value: unknown,
  ): Promise<GoogleSignInOutcome | GoogleFailure> {
    if (!this.#trusted(event)) return { reply: "denied" };
    const parsed = GoogleSignInRequestSchema.safeParse(value ?? {});
    if (!parsed.success) return { reply: "invalid" };
    try {
      const outcome = await this.#step(() =>
        this.#handlers.googleSignIn(
          parsed.data.accountId === undefined ? {} : { accountId: parsed.data.accountId },
        ),
      );
      if (outcome.reply === "signed-in") this.#restartPending = true;
      return outcome;
    } catch (error) {
      this.#handlers.onError("manage:google-sign-in", error);
      return { reply: "failed" };
    }
  }

  #googleCancel(event: IpcMainInvokeEvent): void {
    if (this.#trusted(event)) this.#handlers.googleCancel();
  }

  /**
   * No payload: nothing from the page decides what restarts. A second click while it quits does nothing (main guards it).
   * Refused while a step runs: an Unblock or a Remove deleting filters must not be cut off by the restart.
   */
  #restart(event: IpcMainInvokeEvent): RestartReply {
    if (!this.#trusted(event)) return "denied";
    if (this.#steps > 0) return "busy";
    this.#handlers.restart();
    return "restarting";
  }

  async #step<T>(work: () => Promise<T>): Promise<T> {
    this.#steps += 1;
    try {
      return await work();
    } finally {
      this.#steps -= 1;
    }
  }

  async #googleRemove(
    event: IpcMainInvokeEvent,
    id: unknown,
  ): Promise<GoogleRemoveReply | GoogleFailure["reply"]> {
    if (!this.#trusted(event)) return "denied";
    if (typeof id !== "string" || !ACCOUNT_ID.test(id)) return "invalid";
    try {
      return await this.#step(() => this.#handlers.googleRemove(id));
    } catch (error) {
      this.#handlers.onError("manage:google-remove", error);
      return "failed";
    }
  }
}

type RestartReply = "restarting" | "busy" | "denied";
type PauseReply = "done" | "busy" | "invalid" | "denied" | "failed";

/** Gmail replies are a fixed word (and a day count), never the input and never an error text: the secret must not travel back. */
type GoogleFailure = { readonly reply: "invalid" | "denied" | "failed" };

/** What the main process says about a key change; each one is a fixed word the page turns into a sentence. */
type MxrouteReply = MxrouteSaveResult | "invalid" | "denied" | "failed";
type AccountAddReply = AccountAddResult | "busy" | "invalid" | "denied" | "failed";
type AccountRemoveReply = AccountRemoveResult | "busy" | "invalid" | "denied" | "failed";
