import { join } from "node:path";
import {
  AccountWatcher,
  DEFAULT_SETTINGS,
  MAX_CONCURRENT_LOGINS,
  PendingBlocks,
  SieveAdapter,
  SyncEngine,
  blockPending,
  createGate,
  willRetry,
  blockableDomain,
  canRejectSender,
  isFreemail,
  initialSieveState,
  unblock,
  MxrouteAdapter,
  createMxrouteClient,
  initialMxrouteState,
  mxrouteLaneId,
} from "@senderban/core";
import type {
  AccountConfig,
  BlockAction,
  BlockResult,
  IncomingMessage,
  OwnMail,
  Settings,
  SyncOutcome,
  UnblockResult,
  WatcherState,
} from "@senderban/core";
import { connectManageSieve, imapflowConnector } from "@senderban/core/node";
import { Store, openDatabase } from "@senderban/core/store";
import { Menu, Tray, app, nativeImage, powerMonitor } from "electron";
import { AddAccountError, addAccountFromFile } from "./add-account.js";
import { decryptPassword, loadAccounts } from "./accounts-file.js";
import { accountTag, createLog } from "./log.js";
import { ManageWindow } from "./manage.js";
import type { ManageOutcome } from "./manage.js";
import {
  listMxroute,
  mailDomain,
  mxrouteGroupKey,
  removeMxroute,
  saveMxroute,
  setMxrouteEnabled,
} from "./mxroute-settings.js";
import { Toasts } from "./toasts.js";
import type { ToastResult } from "./toasts.js";
import { loadSettings, saveSettings } from "./settings-file.js";

// Groups the windows under one taskbar identity. Placeholder id: confirm before the first installer ships.
const APP_USER_MODEL_ID = "com.senderban.desktop";

app.setName("Senderban");
const log = createLog(join(app.getPath("userData"), "logs"));
const errorText = (error: unknown): string =>
  error instanceof Error ? error.message : "unknown error";
/** A handler threw: the channel and a message the log sanitises, never the payload. */
function logIpcError(channel: string, error: unknown): void {
  log("ipc-error", { channel, detail: errorText(error) });
}
/** The domain is enough to diagnose; the full address stays out of a file people attach to bug reports. */
const domainOf = (address: string): string => address.slice(address.lastIndexOf("@") + 1);

interface Runtime {
  readonly store: Store;
  readonly engine: SyncEngine;
  readonly accounts: readonly AccountConfig[];
  /** Every engine lane: each account's own, plus one per MXroute blacklist (server, user, domain) in use. */
  readonly lanes: readonly string[];
  readonly watchers: ReadonlyMap<string, AccountWatcher>;
  readonly pending: PendingBlocks;
  /** Account id -> the address the person knows it by. */
  readonly labels: ReadonlyMap<string, string>;
  /** The person's own addresses and mail domains: never refused at the server. */
  readonly own: OwnMail;
}

/** Resolves once the store, engine and watchers exist; an activation that launched the app waits for it. */
const ready = Promise.withResolvers<Runtime>();
let paused = false;
let quitting = false;
const states = new Map<string, WatcherState>();
let tray: Tray | null = null;
let toasts: Toasts | null = null;
let manage: ManageWindow | null = null;
/** Set once start() has finished; the manage window reads the list from it. */
let runtime: Runtime | null = null;
let settings: Settings = DEFAULT_SETTINGS;

/** A toast without buttons: a state change the person should know about. */
function notice(title: string, body: string): void {
  toasts?.notice(title, body);
}

/** Accounts whose last sync failed and whose person was told; cleared by the next sync that did not fail. */
const unsynced = new Set<string>();
/** Accounts a toast click is working on right now: the result toast reports their outcome, a notice would repeat it. */
const clicking = new Set<string>();
/** Engine lanes that write to an MXroute blacklist: their failures are about the API key, not the mail password. */
const mxrouteLanes = new Set<string>();
/** Accounts whose blocked single addresses are also refused at the MXroute server (live lane, switch on). */
const rejectingAccounts = new Set<string>();

const destination = (action: BlockAction): string =>
  action === "trash" ? "Trash (your provider may empty it after a while)" : "Junk";

/**
 * A sync that ran in the background (another account after a block, a retry, the start-up pass) and
 * failed: tell the person once per account until it succeeds, so a failure is never silent and a
 * retry loop never becomes a stream of toasts.
 */
function noticeIfUnsynced(outcome: SyncOutcome): void {
  const id = outcome.accountId;
  const ok = outcome.status === "applied" || outcome.status === "unchanged";
  if (ok) {
    unsynced.delete(id);
    return;
  }
  if (clicking.has(id) || unsynced.has(id)) return;
  unsynced.add(id);
  const label = runtime?.labels.get(id) ?? id;
  const why = outcome.status === "failed" ? outcome.code : "some changes failed";
  const next =
    outcome.status !== "failed"
      ? "Open Blocked senders to check."
      : willRetry(outcome.code)
        ? "Senderban will try again."
        : outcome.code === "AUTH_REQUIRED"
          ? mxrouteLanes.has(id)
            ? "MXroute refused the API key: fix it under Advanced in Blocked senders, then restart Senderban."
            : "The password was refused: Senderban will not use it again for 30 minutes. Fix it, then restart Senderban."
          : outcome.code === "REMOTE_CHANGED"
            ? "Someone else changed Senderban's script on the server, so it stopped instead of overwriting it. It will not try again by itself."
            : "Check the account in Senderban.";
  notice("Senderban", `The block list is not up to date on ${label} (${why}). ${next}`);
}

/** What the result toast says once a choice has run. */
function describe(result: BlockResult, labels: ReadonlyMap<string, string>): ToastResult {
  switch (result.status) {
    case "blocked": {
      if (!result.verified) {
        return {
          tone: "warn",
          text: `${result.target}: rule written, not confirmed (${result.detail}).`,
        };
      }
      // Only the clicked account was read back; the others update in the background.
      const where = labels.get(result.accountId) ?? result.accountId;
      const others =
        result.otherAccounts === 0
          ? ""
          : ` ${String(result.otherAccounts)} other place(s) are updating in the background.`;
      if (result.action === "reject") {
        return {
          tone: "ok",
          text: `✓ ${result.target}: backup rule verified on ${where}. The server is told to refuse this sender (that follows in the background); a message that still arrives goes to Junk.${others}`,
        };
      }
      return {
        tone: "ok",
        text: `✓ ${result.target}: rule verified on ${where}. Future mail skips your inbox and goes to ${destination(result.action)}.${others}`,
      };
    }
    case "not-applied":
    case "refused":
      return { tone: "error", text: `Not blocked: ${result.detail}` };
    case "already-blocked":
      return {
        tone: "warn",
        text: `${result.target} is already blocked and ${result.action === "reject" ? "refused at the server" : `goes to ${result.action === "trash" ? "Trash" : "Junk"}`}. Unblock it first to change that.`,
      };
    case "duplicate":
      return { tone: "warn", text: "Already handled." };
    case "unknown":
      return {
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
      text: `✓ ${value} unblocked. The rule is gone from ${String(result.accounts.length)} place(s) and was read back from the provider.`,
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
        account: accountTag(outcome.accountId),
        status: outcome.status,
        ...(outcome.status === "failed" ? { code: outcome.code, detail: outcome.message } : {}),
        ...(outcome.status === "applied" || outcome.status === "partial"
          ? { applied: outcome.applied, failed: outcome.failed }
          : {}),
      });
      noticeIfUnsynced(outcome);
    },
  });
  const pending = new PendingBlocks();
  // The person knows an account by its address, not by the internal id.
  const labels = new Map(
    accounts.map((a) => [a.id, a.imap.user.includes("@") ? a.imap.user : a.id]),
  );
  const watchers = new Map<string, AccountWatcher>();
  const lanes = accounts.map((a) => a.id);
  // The blacklist is shared by every mailbox of the account, so the person's own addresses and domains must never
  // be refused there: a spammer can forge them in From, and real mail would bounce. Every account counts, not only
  // the ones with a key, but a freemail domain (gmail.com) is not "owned": only the full login address is.
  const own = { domains: new Set<string>(), addresses: new Set<string>() };
  for (const a of accounts) {
    for (const login of [a.imap.user, a.sieve.user]) {
      if (login.includes("@")) own.addresses.add(login.toLowerCase());
    }
    const domain = mailDomain(a);
    if (domain !== null && !isFreemail(domain)) own.domains.add(domain);
  }
  // One MXroute lane per (server, user, domain): the blacklist belongs to the domain, so five mailboxes on
  // it would otherwise send the same entries five times. The first account owns the lane and its key.
  const mxrouteGroups = new Map<string, { owner: string; mirror: boolean }>();
  for (const account of accounts) {
    const key = mxrouteGroupKey(account);
    if (key === null || account.mxroute === undefined) continue;
    const group = mxrouteGroups.get(key);
    if (group === undefined)
      mxrouteGroups.set(key, { owner: account.id, mirror: account.mxroute.enabled });
    else group.mirror ||= account.mxroute.enabled;
  }
  // One gate for every watcher: start, resume and unpause open at most MAX_CONCURRENT_LOGINS logins at once.
  const loginGate = createGate(MAX_CONCURRENT_LOGINS);

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

    const groupKey = mxrouteGroupKey(account);
    const group = groupKey === null ? undefined : mxrouteGroups.get(groupKey);
    if (account.mxroute !== undefined && group?.owner === account.id) {
      // A second lane next to the Sieve one: it mirrors single addresses onto the MXroute blacklist, or, while
      // the person has it switched off, only takes back what it put there (no request when it put nothing).
      const laneId = mxrouteLaneId(account.id);
      const domain = mailDomain(account);
      try {
        if (domain === null) throw new Error("no mail domain");
        const { mxroute } = account;
        engine.addAccount({
          id: laneId,
          initialState: initialMxrouteState(domain),
          background: true,
          adapter: new MxrouteAdapter({
            accountId: laneId,
            mirror: group.mirror,
            client: createMxrouteClient({
              server: mxroute.server,
              username: mxroute.username,
              getKey: () => decryptPassword(mxroute.apiKeyCipher),
              // Operation, HTTP status and duration only: no key, no address.
              onCall: (call) => {
                log("mxroute-call", { account: accountTag(account.id), ...call });
              },
            }),
          }),
        });
        lanes.push(laneId);
        mxrouteLanes.add(laneId);
        labels.set(laneId, `${labels.get(account.id) ?? account.id} (MXroute)`);
        log("mxroute-lane", { account: accountTag(account.id), mirror: group.mirror });
      } catch {
        log("mxroute-lane-skipped", { account: accountTag(account.id) });
      }
    }

    // Every mailbox on a domain whose lane is live and switched on gets the server-side refusal, not only the owner.
    if (
      groupKey !== null &&
      group?.mirror === true &&
      mxrouteLanes.has(mxrouteLaneId(group.owner))
    ) {
      rejectingAccounts.add(account.id);
    }

    watchers.set(
      account.id,
      new AccountWatcher({
        accountId: account.id,
        cursors: store.cursors,
        gate: loginGate,
        // One connector per account: its temporary-refusal counter must outlive a single attempt.
        connect: imapflowConnector({
          ...account.imap,
          password: () => decryptPassword(account.passwordCipher),
        }),
        onMessage: (accountId: string, message: IncomingMessage) => {
          const id = pending.add({ accountId, sender: message.from });
          log("announce", {
            account: accountTag(accountId),
            uid: message.uid,
            domain: domainOf(message.from),
          });
          toasts?.show({
            id,
            sender: message.from,
            subject: message.subject,
            account: labels.get(accountId) ?? accountId,
            spamScore: message.spamScore,
            domain: blockableDomain(message.from),
            // A wildcard address is never written to the blacklist (it would refuse a whole provider).
            rejectsAtServer: rejectingAccounts.has(accountId) && canRejectSender(message.from, own),
          });
        },
        onOverflow: (accountId, skipped) => {
          log("overflow", { account: accountTag(accountId), skipped });
          notice(
            "Senderban",
            `${String(skipped)} more new messages in ${labels.get(accountId) ?? accountId} were not announced.`,
          );
        },
        onState: (accountId, state, detail) => {
          const previous = states.get(accountId);
          states.set(accountId, state);
          updateTray();
          log("watcher", { account: accountTag(accountId), state, detail });
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
      account: accountTag(report.accountId),
      interrupted: report.interrupted,
      drifted: report.drift?.drifted,
      verifyError: report.verifyError,
    });
  }
  for (const watcher of watchers.values()) watcher.start();
  // A rule change that never reached a provider (an unblock that failed, a crash after the list
  // changed) is applied now. The plan is computed locally, so only accounts with a difference connect.
  void engine.syncAll();

  powerMonitor.on("resume", () => {
    log("resume", { paused });
    // A socket that slept is dead but not yet reported (ADR 0003): rebuild instead of trusting it.
    if (!paused) for (const watcher of watchers.values()) watcher.reconnectNow();
  });
  return { store, engine, accounts, lanes, watchers, pending, labels, own };
}

async function shutdown(): Promise<void> {
  const current = await ready.promise.catch(() => null);
  if (current === null) return;
  log("quit");
  toasts?.closeAll();
  manage?.closeAll();
  current.engine.dispose();
  await Promise.allSettled([...current.watchers.values()].map((w) => w.stop()));
  current.store.close();
}

const addAccountArg = process.argv.find((a) => a.startsWith("--add-account="));

if (addAccountArg !== undefined && !app.requestSingleInstanceLock()) {
  // The running app rewrites accounts.json too (an Advanced key save): two writers would lose one change.
  process.stderr.write("Senderban is running. Quit it from the tray, then add the account.\n");
  app.exit(1);
} else if (addAccountArg !== undefined) {
  // Bootstrap mode: store one encrypted account and exit; nothing else starts.
  void app.whenReady().then(async () => {
    try {
      const id = await addAccountFromFile(
        addAccountArg.slice("--add-account=".length),
        join(app.getPath("userData"), "accounts.json"),
      );
      log("account-saved", { account: accountTag(id) });
      app.exit(0);
    } catch (error) {
      // Only our own fixed messages are logged: anything else may quote the file with the password.
      log("account-save-failed", {
        detail: error instanceof AddAccountError ? error.message : "unexpected error",
      });
      process.stderr.write(
        `Account not saved. The plaintext file ${addAccountArg.slice("--add-account=".length)} still exists: delete it.\n`,
      );
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
    const accountsPath = join(app.getPath("userData"), "accounts.json");
    try {
      settings = await loadSettings(settingsPath);
    } catch (error) {
      log("settings-invalid", { detail: errorText(error) });
    }
    const assets = join(import.meta.dirname, "../assets");
    toasts = new Toasts({
      onIgnored: (reason) => {
        log("toast-ignored", { reason });
      },
      onError: logIpcError,
      choose: async (id, scope, action) => {
        const { store, engine, lanes, pending, labels, own } = await ready.promise;
        let clicked = null as string | null;
        let result: BlockResult;
        try {
          result = await blockPending(
            {
              pending,
              store,
              engine,
              own,
              accountIds: lanes,
              onClaimed: (accountId) => {
                clicked = accountId;
                clicking.add(accountId);
              },
            },
            id,
            scope,
            action,
          );
        } finally {
          if (clicked !== null) clicking.delete(clicked);
        }
        // The result toast tells the person about this account; a notice for the same failure would repeat it.
        if (result.status === "not-applied") unsynced.add(result.accountId);
        log("choice", {
          scope,
          action,
          result: result.status,
          verified: result.status === "blocked" ? result.verified : undefined,
        });
        manage?.notifyChanged();
        return describe(result, labels);
      },
    });
    manage = new ManageWindow(assets, {
      list: () => runtime?.store.list() ?? [],
      getSeconds: () => settings.popupSeconds,
      onError: logIpcError,
      mxrouteList: () => listMxroute(accountsPath),
      mxrouteSave: async (input) => {
        const result = await saveMxroute(accountsPath, input);
        // Account tag and outcome only: never the key, the user name or the server.
        log("mxroute-saved", { account: accountTag(input.accountId), result });
        return result;
      },
      mxrouteRemove: async (accountId) => {
        const result = await removeMxroute(accountsPath, accountId);
        log("mxroute-removed", { account: accountTag(accountId), result });
        return result;
      },
      mxrouteEnable: async (accountId, enabled) => {
        const result = await setMxrouteEnabled(accountsPath, accountId, enabled);
        log("mxroute-enabled", { account: accountTag(accountId), enabled, result });
        return result;
      },
      setSeconds: async (popupSeconds) => {
        const next = { ...settings, popupSeconds };
        await saveSettings(settingsPath, next);
        settings = next;
        log("settings-saved", { popupSeconds });
        return popupSeconds;
      },
      unblock: async (id) => {
        const { store, engine, lanes, labels } = await ready.promise;
        const value = store.list().find((e) => e.id === id)?.value ?? "This sender";
        const accountIds = lanes;
        // The window reports every account's outcome itself; background notices would repeat it.
        for (const accountId of accountIds) clicking.add(accountId);
        let result: UnblockResult;
        try {
          result = await unblock({ store, engine, accountIds }, id);
        } finally {
          for (const accountId of accountIds) clicking.delete(accountId);
        }
        if (result.status === "unblocked") {
          for (const a of result.accounts) if (!a.confirmed) unsynced.add(a.accountId);
        }
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
