import { join } from "node:path";
import {
  AccountWatcher,
  PendingBlocks,
  SieveAdapter,
  SyncEngine,
  handleBlockActivation,
  initialSieveState,
} from "@senderban/core";
import type { AccountConfig, IncomingMessage, WatcherState } from "@senderban/core";
import { connectManageSieve, imapflowConnector } from "@senderban/core/node";
import { Store, openDatabase } from "@senderban/core/store";
import { Menu, Notification, Tray, app, nativeImage, powerMonitor } from "electron";
import { addAccountFromFile } from "./add-account.js";
import { decryptPassword, loadAccounts } from "./accounts-file.js";

// Windows toast actions need an AppUserModelID and a Start Menu shortcut (Electron notifications
// tutorial). Placeholder id: confirm before the first installer ships.
const APP_USER_MODEL_ID = "com.senderban.desktop";

const log = (message: string): void => {
  // Messages only: never a password, never mail content beyond what the caller already sanitised.
  console.error(`[senderban] ${message}`);
};

interface Runtime {
  readonly store: Store;
  readonly engine: SyncEngine;
  readonly accounts: readonly AccountConfig[];
  readonly watchers: ReadonlyMap<string, AccountWatcher>;
  readonly pending: PendingBlocks;
}

/** Resolves once the store, engine and watchers exist; an activation that launched the app waits for it. */
const ready = Promise.withResolvers<Runtime>();
let paused = false;
let quitting = false;
const states = new Map<string, WatcherState>();
let tray: Tray | null = null;

function toast(title: string, body: string, options: { id?: string; button?: string } = {}): void {
  const notification = new Notification({
    ...(options.id === undefined ? {} : { id: options.id }),
    title,
    body,
    ...(options.button === undefined
      ? {}
      : { actions: [{ type: "button" as const, text: options.button }] }),
  });
  notification.show();
}

function updateTray(): void {
  if (tray === null) return;
  const lines = [...states].map(([id, state]) => ({ label: `${id}: ${state}`, enabled: false }));
  tray.setContextMenu(
    Menu.buildFromTemplate([
      ...(lines.length === 0 ? [{ label: "No accounts configured", enabled: false }] : lines),
      { type: "separator" },
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
  const engine = new SyncEngine(store, {
    onOutcome: (outcome) => {
      if (outcome.status === "failed") log(`sync ${outcome.accountId}: ${outcome.code}`);
    },
  });
  const pending = new PendingBlocks();
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
          toast(message.from, `${message.subject}\n${accountId}`, { id, button: "Block sender" });
        },
        onOverflow: (accountId, skipped) => {
          toast(
            "Senderban",
            `${String(skipped)} more new messages in ${accountId} were not announced.`,
          );
        },
        onState: (accountId, state, detail) => {
          const previous = states.get(accountId);
          states.set(accountId, state);
          updateTray();
          if (state === "halted" && previous !== "halted") {
            log(`watcher ${accountId} halted: ${detail ?? "no detail"}`);
            toast("Senderban stopped watching", `${accountId}: ${detail ?? "sign-in failed"}`);
          }
        },
      }),
    );
    states.set(account.id, "stopped");
  }

  // Interrupted syncs from a previous run are repaired before new mail can add to the list.
  for (const report of await engine.recover()) {
    log(`recovered ${report.accountId}: ${String(report.interrupted)} interrupted`);
  }
  for (const watcher of watchers.values()) watcher.start();

  powerMonitor.on("resume", () => {
    // A socket that slept is dead but not yet reported (ADR 0003): rebuild instead of trusting it.
    if (!paused) for (const watcher of watchers.values()) watcher.reconnectNow();
  });
  return { store, engine, accounts, watchers, pending };
}

async function shutdown(): Promise<void> {
  const current = await ready.promise.catch(() => null);
  if (current === null) return;
  current.engine.dispose();
  await Promise.allSettled([...current.watchers.values()].map((w) => w.stop()));
  current.store.close();
}

app.setName("Senderban");
const addAccountArg = process.argv.find((a) => a.startsWith("--add-account="));

if (addAccountArg !== undefined) {
  // Bootstrap mode: store one encrypted account and exit; nothing else starts.
  void app.whenReady().then(async () => {
    try {
      const id = await addAccountFromFile(
        addAccountArg.slice("--add-account=".length),
        join(app.getPath("userData"), "accounts.json"),
      );
      log(`account ${id} saved`);
      app.exit(0);
    } catch (error) {
      log(`add-account failed: ${error instanceof Error ? error.message : "unknown error"}`);
      app.exit(1);
    }
  });
} else if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.setAppUserModelId(APP_USER_MODEL_ID);

  // Registered before whenReady: an activation that launched the app must not be lost (ADR 0003).
  Notification.handleActivation((details) => {
    ready.promise
      .then(({ store, engine, accounts, pending }) =>
        handleBlockActivation(
          {
            pending,
            store,
            engine,
            accountIds: accounts.map((a) => a.id),
            say: (t, b) => {
              toast(t, b);
            },
          },
          details,
        ),
      )
      .catch((error: unknown) => {
        log(`activation failed: ${error instanceof Error ? error.message : "unknown error"}`);
      });
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

  void app.whenReady().then(() => {
    tray = new Tray(nativeImage.createFromPath(join(import.meta.dirname, "../assets/tray.png")));
    updateTray();
    start().then(ready.resolve, ready.reject);
    ready.promise.catch((error: unknown) => {
      log(`startup failed: ${error instanceof Error ? error.message : "unknown error"}`);
      toast("Senderban could not start", "See the log for details.");
    });
  });
}
