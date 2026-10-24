import { join } from "node:path";
import {
  AccountWatcher,
  DEFAULT_SETTINGS,
  PendingBlocks,
  SieveAdapter,
  SyncEngine,
  blockPending,
  blockableDomain,
  initialSieveState,
  unblock,
} from "@senderban/core";
import type {
  AccountConfig,
  BlockResult,
  IncomingMessage,
  Settings,
  UnblockResult,
  WatcherState,
} from "@senderban/core";
import { connectManageSieve, imapflowConnector } from "@senderban/core/node";
import { Store, openDatabase } from "@senderban/core/store";
import { Menu, Tray, app, nativeImage, powerMonitor } from "electron";
import { addAccountFromFile } from "./add-account.js";
import { decryptPassword, loadAccounts } from "./accounts-file.js";
import { createLog } from "./log.js";
import { ManageWindow } from "./manage.js";
import type { ManageOutcome } from "./manage.js";
import { Popups } from "./popups.js";
import type { PopupView } from "./popups.js";
import { loadSettings, saveSettings } from "./settings-file.js";

// Groups the windows under one taskbar identity. Placeholder id: confirm before the first installer ships.
const APP_USER_MODEL_ID = "com.senderban.desktop";

app.setName("Senderban");
const log = createLog(join(app.getPath("userData"), "logs"));
const errorText = (error: unknown): string =>
  error instanceof Error ? error.message : "unknown error";
/** The domain is enough to diagnose; the full address stays out of a file people attach to bug reports. */
const domainOf = (address: string): string => address.slice(address.lastIndexOf("@") + 1);

interface Runtime {
  readonly store: Store;
  readonly engine: SyncEngine;
  readonly accounts: readonly AccountConfig[];
  readonly watchers: ReadonlyMap<string, AccountWatcher>;
  readonly pending: PendingBlocks;
  /** Account id -> the address the person knows it by. */
  readonly labels: ReadonlyMap<string, string>;
}

/** Resolves once the store, engine and watchers exist; an activation that launched the app waits for it. */
const ready = Promise.withResolvers<Runtime>();
let paused = false;
let quitting = false;
const states = new Map<string, WatcherState>();
let tray: Tray | null = null;
let popups: Popups | null = null;
let manage: ManageWindow | null = null;
/** Set once start() has finished; the manage window reads the list from it. */
let runtime: Runtime | null = null;
let settings: Settings = DEFAULT_SETTINGS;

/** A popup without buttons: a state change the person should know about. */
function notice(title: string, body: string): void {
  popups?.show({ id: null, title, body, account: null, domain: null });
}

/** What the popup says once a choice has run; the same window that showed the buttons. */
function describe(result: BlockResult): PopupView {
  switch (result.status) {
    case "blocked":
      return result.verified
        ? {
            phase: "done",
            tone: "ok",
            text: `✓ ${result.target}: rule verified. Future mail skips your inbox and goes to Junk.`,
          }
        : {
            phase: "done",
            tone: "warn",
            text: `${result.target}: rule written, not confirmed (${result.detail}).`,
          };
    case "not-applied":
    case "refused":
      return { phase: "done", tone: "error", text: `Not blocked: ${result.detail}` };
    case "duplicate":
      return { phase: "done", tone: "warn", text: "Already handled." };
    case "unknown":
      return {
        phase: "done",
        tone: "error",
        text: "This message has expired, so nothing was blocked.",
      };
  }
}

/** What the manage window says once an unblock has run. */
function describeUnblock(
  value: string,
  result: UnblockResult,
  labels: ReadonlyMap<string, string>,
): ManageOutcome {
  if (result.status === "unknown") return { tone: "warn", text: "Already removed from the list." };
  const unconfirmed = result.accounts.filter((a) => !a.confirmed);
  if (result.accounts.length === 0) {
    return { tone: "ok", text: `${value} removed from the list. No account is set up to update.` };
  }
  if (unconfirmed.length === 0) {
    return {
      tone: "ok",
      text: `✓ ${value} unblocked. The rule is gone from ${String(result.accounts.length)} account(s) and was read back from the provider.`,
    };
  }
  const first = unconfirmed
    .slice(0, 2)
    .map((a) => `${labels.get(a.accountId) ?? a.accountId}: ${a.detail}`)
    .join("; ");
  const more = unconfirmed.length > 2 ? ` (+${String(unconfirmed.length - 2)} more)` : "";
  return {
    tone: "warn",
    text: `${value} is off your list, but the provider may still have the rule — ${first}${more}.`,
  };
}

function updateTray(): void {
  if (tray === null) return;
  const lines = [...states].map(([id, state]) => ({ label: `${id}: ${state}`, enabled: false }));
  tray.setContextMenu(
    Menu.buildFromTemplate([
      ...(lines.length === 0 ? [{ label: "No accounts configured", enabled: false }] : lines),
      { type: "separator" },
      {
        label: "Blocked senders…",
        click: () => {
          manage?.show();
        },
      },
      {
        label: paused ? "Resume watching" : "Pause watching",
        enabled: lines.length > 0,
        click: () => {
          void setPaused(!paused);
        },
      },
      {
        label: "Quit Senderban",
        click: () => {
          app.quit();
        },
      },
    ]),
  );
  tray.setToolTip(paused ? "Senderban (paused)" : "Senderban");
}

async function setPaused(value: boolean): Promise<void> {
  paused = value;
  const { watchers } = await ready.promise;
  for (const watcher of watchers.values()) {
    if (value) await watcher.stop();
    else watcher.start();
  }
  updateTray();
}

async function start(): Promise<Runtime> {
  const dir = app.getPath("userData");
  const accounts = await loadAccounts(join(dir, "accounts.json"));
  const store = new Store(openDatabase(join(dir, "senderban.db")));
  log("start", { accounts: accounts.length, electron: process.versions.electron });
  const engine = new SyncEngine(store, {
    onOutcome: (outcome) => {
      log("sync", {
        account: outcome.accountId,
        status: outcome.status,
        ...(outcome.status === "failed" ? { code: outcome.code, detail: outcome.message } : {}),
        ...(outcome.status === "applied" || outcome.status === "partial"
          ? { applied: outcome.applied, failed: outcome.failed }
          : {}),
      });
    },
  });
  const pending = new PendingBlocks();
  // The person knows an account by its address, not by the internal id.
  const labels = new Map(
    accounts.map((a) => [a.id, a.imap.user.includes("@") ? a.imap.user : a.id]),
  );
  const watchers = new Map<string, AccountWatcher>();

  for (const account of accounts) {
    engine.addAccount({
      id: account.id,
      initialState: initialSieveState(),
      adapter: new SieveAdapter({
        accountId: account.id,
        connect: async () =>
          connectManageSieve({
            host: account.sieve.host,
            port: account.sieve.port,
            username: account.sieve.user,
            password: await decryptPassword(account.passwordCipher),
          }),
      }),
    });

    watchers.set(
      account.id,
      new AccountWatcher({
        accountId: account.id,
        cursors: store.cursors,
        connect: async () =>
          imapflowConnector({
            ...account.imap,
            password: await decryptPassword(account.passwordCipher),
          })(),
        onMessage: (accountId: string, message: IncomingMessage) => {
          const id = pending.add({ accountId, sender: message.from });
          log("announce", { account: accountId, uid: message.uid, domain: domainOf(message.from) });
          popups?.show({
            id,
            title: message.from,
            body: message.subject,
            account: labels.get(accountId) ?? accountId,
            domain: blockableDomain(message.from),
          });
        },
        onOverflow: (accountId, skipped) => {
          log("overflow", { account: accountId, skipped });
          notice(
            "Senderban",
            `${String(skipped)} more new messages in ${labels.get(accountId) ?? accountId} were not announced.`,
          );
        },
        onState: (accountId, state, detail) => {
          const previous = states.get(accountId);
          states.set(accountId, state);
          updateTray();
          log("watcher", { account: accountId, state, detail });
          if (state === "halted" && previous !== "halted") {
            notice(
              "Senderban stopped watching",
              `${labels.get(accountId) ?? accountId}: ${detail ?? "sign-in failed"}`,
            );
          }
        },
      }),
    );
    states.set(account.id, "stopped");
  }

  // Interrupted syncs from a previous run are repaired before new mail can add to the list.
  for (const report of await engine.recover()) {
    log("recovered", {
      account: report.accountId,
      interrupted: report.interrupted,
      drifted: report.drift?.drifted,
      verifyError: report.verifyError,
    });
  }
  for (const watcher of watchers.values()) watcher.start();

  powerMonitor.on("resume", () => {
    log("resume", { paused });
    // A socket that slept is dead but not yet reported (ADR 0003): rebuild instead of trusting it.
    if (!paused) for (const watcher of watchers.values()) watcher.reconnectNow();
  });
  return { store, engine, accounts, watchers, pending, labels };
}

async function shutdown(): Promise<void> {
  const current = await ready.promise.catch(() => null);
  if (current === null) return;
  log("quit");
  popups?.closeAll();
  manage?.closeAll();
  current.engine.dispose();
  await Promise.allSettled([...current.watchers.values()].map((w) => w.stop()));
  current.store.close();
}

const addAccountArg = process.argv.find((a) => a.startsWith("--add-account="));

if (addAccountArg !== undefined) {
  // Bootstrap mode: store one encrypted account and exit; nothing else starts.
  void app.whenReady().then(async () => {
    try {
      const id = await addAccountFromFile(
        addAccountArg.slice("--add-account=".length),
        join(app.getPath("userData"), "accounts.json"),
      );
      log("account-saved", { account: id });
      app.exit(0);
    } catch (error) {
      log("account-save-failed", { detail: errorText(error) });
      app.exit(1);
    }
  });
} else if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.setAppUserModelId(APP_USER_MODEL_ID);

  // Starting the exe again while it lives in the tray opens the window instead of doing nothing.
  app.on("second-instance", () => {
    manage?.show();
  });

  // Tray app: no window, and closing the last window must not quit the process.
  app.on("window-all-closed", () => {
    // intentionally empty
  });

  app.on("before-quit", (event) => {
    if (quitting) return;
    quitting = true;
    event.preventDefault();
    void shutdown().finally(() => {
      app.exit(0);
    });
  });

  void app.whenReady().then(async () => {
    const settingsPath = join(app.getPath("userData"), "settings.json");
    try {
      settings = await loadSettings(settingsPath);
    } catch (error) {
      log("settings-invalid", { detail: errorText(error) });
    }
    const assets = join(import.meta.dirname, "../assets");
    popups = new Popups(assets, {
      getSeconds: () => settings.popupSeconds,
      openSettings: () => {
        manage?.show();
      },
      onDropped: (count) => {
        log("popups-dropped", { count });
      },
      choose: async (id, scope) => {
        const { store, engine, accounts, pending } = await ready.promise;
        const result = await blockPending(
          { pending, store, engine, accountIds: accounts.map((a) => a.id) },
          id,
          scope,
        );
        log("choice", {
          scope,
          result: result.status,
          verified: result.status === "blocked" ? result.verified : undefined,
        });
        manage?.notifyChanged();
        return describe(result);
      },
    });
    manage = new ManageWindow(assets, {
      list: () => runtime?.store.list() ?? [],
      getSeconds: () => settings.popupSeconds,
      setSeconds: async (popupSeconds) => {
        settings = { ...settings, popupSeconds };
        await saveSettings(settingsPath, settings);
        log("settings-saved", { popupSeconds });
        return popupSeconds;
      },
      unblock: async (id) => {
        const { store, engine, accounts, labels } = await ready.promise;
        const value = store.list().find((e) => e.id === id)?.value ?? "This sender";
        const result = await unblock({ store, engine, accountIds: accounts.map((a) => a.id) }, id);
        log("unblock", {
          result: result.status,
          confirmed:
            result.status === "unblocked"
              ? result.accounts.filter((a) => a.confirmed).length
              : undefined,
          accounts: result.status === "unblocked" ? result.accounts.length : undefined,
        });
        return describeUnblock(value, result, labels);
      },
    });
    tray = new Tray(nativeImage.createFromPath(join(assets, "icon.ico")));
    tray.on("click", () => {
      manage?.show();
    });
    updateTray();
    start().then(ready.resolve, ready.reject);
    void ready.promise.then((current) => {
      runtime = current;
      manage?.notifyChanged();
    });
    ready.promise.catch((error: unknown) => {
      log("start-failed", { detail: errorText(error) });
      notice("Senderban could not start", "See the log for details.");
    });
  });
}
