import { join } from "node:path";
import {
  ACCOUNT_ADD_LIMITS,
  ACCOUNT_ID,
  AccountAddSchema,
  AccountDetectSchema,
  CLEAN_ADD_LIMITS,
  CleanAddSchema,
  GOOGLE_CLIENT_ID_PATTERN,
  GOOGLE_CLIENT_LIMITS,
  GOOGLE_CLIENT_SECRET_PATTERN,
  GoogleClientInputSchema,
  GoogleSignInRequestSchema,
  MANAGESIEVE_PORT,
  MXROUTE_LIMITS,
  MicrosoftSignInRequestSchema,
  MxrouteEnableSchema,
  MxrouteInputSchema,
  MxrouteKeyRefSchema,
  SERVER_PRESETS,
  QuietEntrySchema,
  isVouchedServer,
  SettingsSchema,
  WatchPausedSchema,
  formServer,
  isEntryId,
  SpamFilterRequestSchema,
} from "@senderban/core";
import type {
  AccountAddInput,
  BlockEntry,
  CleanAddInput,
  Detection,
  GoogleClientInput,
  MxrouteEnableInput,
  MxrouteInput,
  MxrouteKeyRef,
  Settings,
  SpamFilter,
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
import type {
  MicrosoftPageState,
  MicrosoftRemoveReply,
  MicrosoftSignInReply,
} from "./microsoft-accounts.js";
import type { MxroutePage, MxrouteSaveResult } from "./mxroute-settings.js";
import type { AccountRemoveResult } from "./remove-account.js";
import type { NoRestart, RestartWhy } from "./restart.js";

const PAGE = "manage/manage.html";

/** Milliseconds. A wake-up flips every watcher (50 accounts, two states each): the open page hears it about twice a second, not 100 times. */
const STATUS_PUSH_GAP_MS = 500;
/**
 * Unit: milliseconds. A long MXroute backlog ends a round every few seconds, and a list read at 50 lanes of 5,000 costs 41 ms of the
 * main process and 1.1 MB of IPC (measured 2026-10-31), so rounds redraw the open list at most this often.
 */
const LIST_PUSH_GAP_MS = 5_000;

/**
 * Unit: lookups per minute. A person presses this a handful of times in the life of an install, and it is the one way from the page to
 * the network with no dialog in front, which bounds what a compromised page could send out through it.
 */
const DETECTS_PER_MINUTE = 6;
const DETECT_WINDOW_MS = 60_000;

/**
 * Unit: milliseconds. A new account's lane and watcher are built at start, so an add or sign-in that worked restarts Senderban on its own
 * after this long: the page has time to say so first. A step still running then is waited for, checked this often.
 */
export const RESTART_AFTER_ADD_MS = 2_000;
/** Unit: milliseconds. A step that runs longer than this keeps the restart bar instead: the person restarts when it is done. */
export const RESTART_WAIT_MAX_MS = 60_000;

/**
 * Compared here, where the question is asked, so that no DNS answer and no text on the page bears on it. A name outside the address's
 * domain may be the right one, for a hosted mailbox, but nothing about it says so (RFC 6186 §6).
 */
function outsideDomainNote(host: string, address: string): string {
  const domain = address.slice(address.lastIndexOf("@") + 1);
  return isVouchedServer(host, domain)
    ? ""
    : `This server is not part of ${domain}. Use it only if your provider's welcome mail or account page names it.\n\n`;
}

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
  /** What a signed-in Microsoft account does with the entry (ADR 0013); `null`: no Microsoft account, say nothing. */
  readonly outlook: "exact" | "wide" | "no" | null;
  readonly own: boolean;
  readonly applied: "yes" | "no" | "unknown";
  readonly atServer: boolean;
  /** An "Other (IMAP)" mailbox runs: Senderban itself applies the entry there, and only while it runs. */
  readonly local: boolean;
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
  /** Mailboxes whose last sync failed: a block may be missing there until a sync works. */
  readonly behind: readonly string[];
  readonly accounts: readonly {
    readonly accountId: string;
    readonly state: string | null;
  }[];
}

export interface AccountRemoveRequest {
  readonly confirm: (label: string, mxroute: boolean) => Promise<boolean>;
  /** A cleaning account has no rules on a server: the question says so. */
  readonly confirmClean: (label: string) => Promise<boolean>;
  readonly confirmLeaveRules: (label: string) => Promise<boolean>;
}

/** One "Other (IMAP)" mailbox on the Accounts view. */
export interface CleanRow {
  readonly accountId: string;
  readonly label: string;
}

export interface ManageHandlers {
  /** The device block list, oldest first. */
  readonly list: () => readonly ManageEntry[];
  /** Takes the entry off the list and every account; describes what happened. */
  readonly unblock: (id: string) => Promise<ManageOutcome>;
  /** The mailboxes and the MXroute keys (the key itself stays in the main process). */
  readonly mxrouteList: () => Promise<MxroutePage & { readonly clean?: readonly CleanRow[] }>;
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
  /** Tries the login, then stores a cleaning account. The input has already passed the core schema. */
  readonly cleanAdd: (
    input: CleanAddInput,
    request: AccountAddRequest,
  ) => Promise<AccountAddResult>;
  /** Who runs this address's mail domain, ended by `signal`. Stores nothing and sends nothing of the person's. The input has already passed the core schema. */
  readonly accountDetect: (address: string, signal: AbortSignal) => Promise<Detection>;
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
  /** Microsoft: whether sign-in is available, and the accounts (never a token). */
  readonly microsoftState: () => Promise<MicrosoftPageState>;
  /** Opens the browser and waits for Microsoft's answer (minutes). `googleCancel` stops it too: there is one sign-in slot. */
  readonly microsoftSignIn: (request: { accountId?: string }) => Promise<MicrosoftSignInReply>;
  readonly microsoftRemove: (accountId: string) => Promise<MicrosoftRemoveReply>;
  /** Quits the way the tray's Quit does, then starts Senderban again (a Gmail sign-in is picked up at start). */
  readonly restart: (why: RestartWhy) => void;
  /** A restart after an add gave up; the reason goes to the log, so "it did not restart" leaves evidence. */
  readonly noRestart: (reason: NoRestart) => void;
  /** The mailboxes and what their watchers are doing. Reads no provider. */
  readonly status: () => Promise<WatchStatus>;
  /** Pauses or resumes every watcher, as the tray's menu does. */
  readonly pause: (value: boolean) => Promise<void>;
  /** The "Don't ask again" list. */
  readonly quiet: () => readonly string[];
  /** Takes one entry off that list. The input has already passed the core schema. */
  readonly quietRemove: (value: string) => Promise<void>;
  /** Sets one mailbox's spam filter. "unknown": no mailbox with this id can hold one. The input has already passed the core schema. */
  readonly saveSpamFilter: (
    accountId: string,
    filter: SpamFilter | null,
  ) => Promise<"saved" | "unknown">;
  /** What the Settings page shows. */
  readonly settings: () => Settings;
  /** Writes the choices to disk; they apply from then on. The input has already passed the core schema. */
  readonly saveSettings: (next: Settings) => Promise<void>;
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
  /** The detection in flight: one at a time, and it ends with the window. */
  #detectAbort: AbortController | null = null;
  /** When the lookups of the last DETECT_WINDOW_MS began. */
  #detectTimes: readonly number[] = [];
  /** An account changed since Senderban started, so the page keeps offering a restart, also after the window closed. */
  #restartPending = false;
  /** True while the restart after an add waits for its time or for a step to end. */
  #restartWaiting = false;
  /** This start is a restart asked for from the window: its first page load says so once. */
  #reopened = false;
  /** Steps in flight that change the list, an account or Google access: a restart waits for them (main side, not only the page). */
  #steps = 0;
  /** One pause at a time: a Pause waits for every IMAP logout, and a second click must not race it. */
  #pausing = false;
  /** Set while a status signal waits to go out. */
  #statusTimer: ReturnType<typeof setTimeout> | null = null;
  #listTimer: ReturnType<typeof setTimeout> | null = null;

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
    ipcMain.handle("manage:clean-add", (event, value: unknown) => this.#cleanAdd(event, value));
    ipcMain.handle("manage:account-detect", (event, value: unknown) =>
      this.#accountDetect(event, value),
    );
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
    ipcMain.handle("manage:microsoft-state", (event) => this.#microsoftState(event));
    ipcMain.handle("manage:microsoft-sign-in", (event, value: unknown) =>
      this.#microsoftSignIn(event, value),
    );
    ipcMain.handle("manage:microsoft-remove", (event, id: unknown) =>
      this.#microsoftRemove(event, id),
    );
    ipcMain.handle("manage:restart", (event) => this.#restart(event));
    ipcMain.handle("manage:status", (event) => this.#status(event));
    ipcMain.handle("manage:pause", (event, value: unknown) => this.#pause(event, value));
    ipcMain.handle("manage:quiet", (event) => this.#quiet(event));
    ipcMain.handle("manage:quiet-remove", (event, value: unknown) =>
      this.#quietRemove(event, value),
    );
    ipcMain.handle("manage:spam-filter", (event, value: unknown) =>
      this.#saveSpamFilter(event, value),
    );
    ipcMain.handle("manage:settings", (event) => this.#settings(event));
    ipcMain.handle("manage:settings-save", (event, value: unknown) =>
      this.#settingsSave(event, value),
    );
  }

  /** True while the window is open: a restart then opens it again. */
  isOpen(): boolean {
    return this.#win !== null && !this.#win.isDestroyed();
  }

  /** Opens the window after a restart asked for from it; the page then says Senderban restarted and shows Accounts. */
  showAfterRestart(): void {
    this.#reopened = true;
    this.show();
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
      if (this.#listTimer !== null) clearTimeout(this.#listTimer);
      this.#listTimer = null;
      // A sign-in waits for the browser with its page open; without the page nobody sees the answer, so stop it.
      this.#handlers.googleCancel();
      // Closing the window during the check is giving up: the account must not be stored behind the person's back.
      this.#addAbort?.abort();
      this.#detectAbort?.abort();
    });
    this.#win = win;
    void win.loadFile(join(this.#assets, PAGE));
  }

  /** The list changed outside the window (a popup blocked a sender): the open page asks for it again. */
  notifyChanged(): void {
    if (this.#win !== null && !this.#win.isDestroyed())
      this.#win.webContents.send("manage:changed");
  }

  /** Background rounds changed what the list can say: the open page asks again, at most once per LIST_PUSH_GAP_MS. No window, no work. */
  notifyListSoon(): void {
    if (this.#win === null || this.#win.isDestroyed() || this.#listTimer !== null) return;
    this.#listTimer = setTimeout(() => {
      this.#listTimer = null;
      this.notifyChanged();
    }, LIST_PUSH_GAP_MS);
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
      const entries = this.#handlers.list();
      // Cleared only once the list was read: a load that failed says it on the next one.
      const restarted = this.#reopened;
      this.#reopened = false;
      return { entries, restarted };
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

  #quiet(event: IpcMainInvokeEvent): readonly string[] | null {
    if (!this.#trusted(event)) return null;
    return this.#handlers.quiet();
  }

  async #quietRemove(
    event: IpcMainInvokeEvent,
    value: unknown,
  ): Promise<"removed" | "denied" | "invalid" | "failed"> {
    if (!this.#trusted(event)) return "denied";
    const parsed = QuietEntrySchema.safeParse(value);
    if (!parsed.success) return "invalid";
    try {
      await this.#step(() => this.#handlers.quietRemove(parsed.data));
      return "removed";
    } catch (error) {
      this.#handlers.onError("manage:quiet-remove", error);
      return "failed";
    }
  }

  #settings(event: IpcMainInvokeEvent): Settings | null {
    if (!this.#trusted(event)) return null;
    return this.#handlers.settings();
  }

  async #settingsSave(
    event: IpcMainInvokeEvent,
    value: unknown,
  ): Promise<"saved" | "denied" | "invalid" | "failed"> {
    if (!this.#trusted(event)) return "denied";
    const parsed = SettingsSchema.safeParse(value);
    if (!parsed.success) return "invalid";
    try {
      await this.#step(() => this.#handlers.saveSettings(parsed.data));
      return "saved";
    } catch (error) {
      this.#handlers.onError("manage:settings-save", error);
      return "failed";
    }
  }

  async #saveSpamFilter(
    event: IpcMainInvokeEvent,
    value: unknown,
  ): Promise<"saved" | "unknown" | "denied" | "invalid" | "failed"> {
    if (!this.#trusted(event)) return "denied";
    const parsed = SpamFilterRequestSchema.safeParse(value);
    if (!parsed.success) return "invalid";
    try {
      return await this.#step(() =>
        this.#handlers.saveSpamFilter(parsed.data.accountId, parsed.data.filter),
      );
    } catch (error) {
      this.#handlers.onError("manage:spam-filter", error);
      return "failed";
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
        // Host names too: the page shows them, the main process alone decides where a password goes.
        addServers: { presets: SERVER_PRESETS, port: MANAGESIEVE_PORT },
        cleanLimits: CLEAN_ADD_LIMITS,
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
    const { address } = parsed.data;
    const server = formServer(parsed.data);
    const outside = server.presetName === null ? outsideDomainNote(server.imapHost, address) : "";
    const where =
      server.presetName !== null
        ? `This is ${server.presetName}'s server.`
        : outside === ""
          ? "Compare the name with what your mail provider gave you, letter by letter."
          : "";
    return this.#adds(
      "manage:account-add",
      `${outside}Server: ${server.imapHost}\nFilters: ${server.sieveHost}, port ${String(server.sievePort)}\nAddress: ${address}\n\nWhoever runs that server receives the password, now and at every start. ${where} The address's mail domain then counts as your own, which can take rules for that domain off your other accounts.`,
      (request) => this.#handlers.accountAdd(parsed.data, request),
    );
  }

  async #cleanAdd(event: IpcMainInvokeEvent, value: unknown): Promise<AccountAddReply> {
    if (!this.#trusted(event)) return "denied";
    if (this.#adding) return "busy";
    const parsed = CleanAddSchema.safeParse(value);
    if (!parsed.success) return "invalid";
    const { address, host, port } = parsed.data;
    return this.#adds(
      "manage:clean-add",
      `${outsideDomainNote(host, address)}Server: ${host}, port ${String(port)}\nAddress: ${address}\n\nWhoever runs that server receives the password, now and at every start. Compare the name with your provider's own settings page, letter by letter. A provider's app password is the one to use here. Senderban will move mail out of this inbox while it runs. At the next start that takes in the last 30 days of mail from everyone on your block list, to Junk or Trash as each entry says. The address's mail domain then counts as your own, which can take rules for that domain off your other accounts.`,
      (request) => this.#handlers.cleanAdd(parsed.data, request),
    );
  }

  /** A suggestion for the form, from the address alone. It changes nothing, so it runs beside everything else. */
  async #accountDetect(
    event: IpcMainInvokeEvent,
    value: unknown,
  ): Promise<Detection | "denied" | "invalid" | "busy" | "limit" | "failed"> {
    if (!this.#trusted(event)) return "denied";
    if (this.#detectAbort !== null) return "busy";
    const parsed = AccountDetectSchema.safeParse(value);
    if (!parsed.success) return "invalid";
    const now = Date.now();
    this.#detectTimes = this.#detectTimes.filter((time) => now - time < DETECT_WINDOW_MS);
    if (this.#detectTimes.length >= DETECTS_PER_MINUTE) return "limit";
    this.#detectTimes = [...this.#detectTimes, now];
    const abort = new AbortController();
    this.#detectAbort = abort;
    try {
      return await this.#handlers.accountDetect(parsed.data.address, abort.signal);
    } catch (error) {
      this.#handlers.onError("manage:account-detect", error);
      return "failed";
    } finally {
      this.#detectAbort = null;
    }
  }

  /** One add at a time. The caller has checked `#trusted` and `#adding`, with no await since. */
  async #adds(
    channel: string,
    detail: string,
    add: (request: AccountAddRequest) => Promise<AccountAddResult>,
  ): Promise<AccountAddReply> {
    this.#adding = true;
    const abort = new AbortController();
    this.#addAbort = abort;
    try {
      const result = await this.#step(() =>
        add({
          confirm: () =>
            this.#ask({
              message: "Send this password to this server?",
              detail,
              yes: "Sign in",
              signal: abort.signal,
            }),
          signal: abort.signal,
        }),
      );
      if (result === "saved" || result === "saved-own-entries") this.#restartAfterAdd();
      return result;
    } catch (error) {
      this.#handlers.onError(channel, error);
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
          confirm: (label, mxroute) =>
            this.#ask({
              message: `Remove ${label}?`,
              detail: `Senderban deletes its rules from this mailbox and forgets the password on this device. Mail from blocked senders then reaches this inbox again.${mxroute ? " Your MXroute API key stays, and anything on your MXroute blacklist stays there." : ""}`,
              yes: "Remove",
            }),
          confirmClean: (label) =>
            this.#ask({
              message: `Remove ${label}?`,
              detail:
                "Senderban stops moving mail in this mailbox and forgets the password on this device. Mail already moved stays where it is. Mail from blocked senders then stays in this inbox.",
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
      if (outcome.reply === "signed-in") this.#restartAfterAdd();
      return outcome;
    } catch (error) {
      this.#handlers.onError("manage:google-sign-in", error);
      return { reply: "failed" };
    }
  }

  async #microsoftState(event: IpcMainInvokeEvent) {
    if (!this.#trusted(event)) return null;
    try {
      return await this.#handlers.microsoftState();
    } catch (error) {
      this.#handlers.onError("manage:microsoft-state", error);
      return null;
    }
  }

  async #microsoftSignIn(
    event: IpcMainInvokeEvent,
    value: unknown,
  ): Promise<MicrosoftSignInReply | GoogleFailure["reply"]> {
    if (!this.#trusted(event)) return "denied";
    const parsed = MicrosoftSignInRequestSchema.safeParse(value ?? {});
    if (!parsed.success) return "invalid";
    try {
      const reply = await this.#step(() =>
        this.#handlers.microsoftSignIn(
          parsed.data.accountId === undefined ? {} : { accountId: parsed.data.accountId },
        ),
      );
      if (reply === "signed-in") this.#restartAfterAdd();
      return reply;
    } catch (error) {
      this.#handlers.onError("manage:microsoft-sign-in", error);
      return "failed";
    }
  }

  async #microsoftRemove(
    event: IpcMainInvokeEvent,
    id: unknown,
  ): Promise<MicrosoftRemoveReply | GoogleFailure["reply"]> {
    if (!this.#trusted(event)) return "denied";
    if (typeof id !== "string" || !ACCOUNT_ID.test(id)) return "invalid";
    try {
      const reply = await this.#step(() => this.#handlers.microsoftRemove(id));
      if (reply.startsWith("removed")) this.#restartPending = true;
      return reply;
    } catch (error) {
      this.#handlers.onError("manage:microsoft-remove", error);
      return "failed";
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
    this.#handlers.restart({ by: "bar", waitedMs: 0 });
    return "restarting";
  }

  /**
   * An account was added or signed in: restart soon, without a click, once no step runs. The bar stays as the fallback: while
   * watching is paused (a restart would resume it, and pause is not kept), when a step outlasts RESTART_WAIT_MAX_MS, or when the
   * status cannot be read. Several adds in a row share one timer.
   */
  #restartAfterAdd(): void {
    this.#restartPending = true;
    if (this.#restartWaiting) return;
    this.#restartWaiting = true;
    const started = Date.now();
    const tick = async () => {
      let again = false;
      // A function, not a field read: a step may begin while the status is awaited, and the check must see it.
      const idle = () => this.#steps === 0;
      try {
        if (idle()) {
          if ((await this.#handlers.status()).paused) {
            this.#handlers.noRestart("paused");
            return;
          }
          if (idle()) {
            this.#handlers.restart({ by: "auto", waitedMs: Date.now() - started });
            return;
          }
        }
        again = Date.now() - started < RESTART_WAIT_MAX_MS;
        if (!again) this.#handlers.noRestart("busy-timeout");
      } catch (error) {
        this.#handlers.onError("manage:auto-restart", error);
      } finally {
        if (again) setTimeout(() => void tick(), RESTART_AFTER_ADD_MS);
        else this.#restartWaiting = false;
      }
    };
    setTimeout(() => void tick(), RESTART_AFTER_ADD_MS);
  }

  /** Work started outside the window (a click on a notification) that a restart after an add must not cut off. */
  hold<T>(work: () => Promise<T>): Promise<T> {
    return this.#step(work);
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
