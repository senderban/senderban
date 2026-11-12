import { join } from "node:path";
import {
  AccountWatcher,
  CleanLink,
  ImapCleanAdapter,
  MAX_CONCURRENT_GMAIL_POLLS,
  MAX_CONCURRENT_OUTLOOK_POLLS,
  MAX_CONCURRENT_LOGINS,
  PendingBlocks,
  SieveAdapter,
  SyncEngine,
  blockPending,
  folderAction,
  RETRO_DAYS,
  createGate,
  willRetry,
  blockableDomain,
  canRejectSender,
  initialCleanState,
  initialSieveState,
  mxrouteStateValues,
  unblock,
  MxrouteAdapter,
  createMxrouteClient,
  initialMxrouteState,
  isCleanAccount,
  isGmailAccount,
  isImapAccount,
  isMicrosoftAccount,
  mxrouteLaneId,
  createOAuthClient,
  createMicrosoftOAuthClient,
  graphEditedRules,
  graphLaneId,
  initialGraphState,
  GmailBudgets,
  GraphBudgets,
  isOwnEntry,
  isOwnMailbox,
  isQuiet,
  overSpamLimit,
  quietTarget,
  SourceSchema,
  spamRule,
  withSpamFilter,
  initialGmailState,
  gmailLaneId,
  HELP_LINKS,
} from "@senderban/core";
import type {
  MailToast,
  BlockAction,
  BlockEntry,
  BlockResult,
  CleanEvent,
  DetectFacts,
  SpamFilter,
  GmailWatcherState,
  ImapAccountConfig,
  IncomingMessage,
  MxrouteCall,
  MxrouteKeyRef,
  OwnMail,
  SyncOutcome,
  UnblockResult,
  WatcherOptions,
  WatcherState,
} from "@senderban/core";
import {
  cleanConnector,
  connectManageSieve,
  detectMailProvider,
  imapflowConnector,
  signIn,
  signInMicrosoft,
} from "@senderban/core/node";
import { Store, openDatabase } from "@senderban/core/store";
import { Menu, Tray, app, nativeImage, net, powerMonitor, safeStorage, shell } from "electron";
import { checkAccount, checkCleanAccount } from "./account-check.js";
import { cleanGapListener, cleanLane } from "./clean-lane.js";
import type { AccountCheckStage } from "./account-check.js";
import { appliedFor, laneViewOf, unsyncedReason } from "./applied.js";
import type { HeldAddresses } from "./applied.js";
import {
  AddAccountError,
  addAccountFromFile,
  addAccountFromForm,
  addCleanFromForm,
} from "./add-account.js";
import {
  decryptPassword,
  loadAccounts,
  saveAccounts,
  serialized,
  writeJsonAtomic,
} from "./accounts-file.js";
import {
  cancelGoogleSignIn,
  googleState,
  removeGoogleAccount,
  saveGoogleClientSettings,
  signInGoogle,
} from "./google-accounts.js";
import type { GoogleDeps } from "./google-accounts.js";
import { BUILTIN_CLIENT_FILE, activeGoogleClient } from "./google-client.js";
import {
  buildGmailLanes,
  createGmailLifecycle,
  createHeldLanes,
  gmailCover,
  gmailAlreadyBlockedText,
  gmailMissNote,
  gmailSkippedNote,
  skippedAfterDone,
} from "./gmail-lanes.js";
import type { GmailFilterLifecycle, GmailLane, GmailSkipped } from "./gmail-lanes.js";
import { createGmailWatchers, subjectLine } from "./gmail-watchers.js";
import { SHUTDOWN_CAP_MS, SHUTDOWN_DEADLINE_MS, settleWithin, stopThenClose } from "./deadline.js";
import {
  createSieveLifecycle,
  dropCleanAccount,
  dropImapAccount,
  dropMxrouteKey,
  removeCleanAccount,
  removeImapAccount,
} from "./remove-account.js";
import type { SieveLane, SieveRulesLifecycle } from "./remove-account.js";
import { relaunchArgs, reopenAfterStart, restartApp } from "./restart.js";
import type { GmailWatchers } from "./gmail-watchers.js";
import type { MailWatchers } from "./mail-watchers.js";
import { createOutlookWatchers } from "./outlook-watchers.js";
import { openGoogleAuthUrl, openMicrosoftAuthUrl } from "./google-url.js";
import {
  cancelMicrosoftSignIn,
  microsoftClientId,
  microsoftState,
  removeMicrosoftAccount,
  signInMicrosoftAccount,
  storeRefreshToken,
} from "./microsoft-accounts.js";
import type { MicrosoftDeps } from "./microsoft-accounts.js";
import {
  buildMicrosoftLanes,
  createMicrosoftLifecycle,
  microsoftSkippedNote,
  microsoftWideNote,
  outlookCover,
} from "./microsoft-lanes.js";
import type { MicrosoftLane, MicrosoftRuleLifecycle, MicrosoftSkipped } from "./microsoft-lanes.js";
import { collectOwnMail, createOwnMail, refreshOwnOnChange } from "./own-mail.js";
import type { OwnMailSet } from "./own-mail.js";
import { applyPause } from "./pause.js";
import { accountTag, createLog } from "./log.js";
import { UpdateChecker } from "./update-check.js";
import { ManageWindow } from "./manage.js";
import type { ManageOutcome } from "./manage.js";
import {
  blacklistOutlives,
  domainCheck,
  keyCheck,
  listMxroute,
  loadMxrouteKeys,
  migrateMxrouteKeys,
  mxrouteGroups,
  removeMxroute,
  saveMxroute,
  setMxrouteEnabled,
  strandedOnBlacklist,
} from "./mxroute-settings.js";
import { QuietStore } from "./quiet-file.js";
import { SettingsStore } from "./settings-file.js";
import { loadActivationSigner } from "./activation-key.js";
import { restoreClicked } from "./restore-click.js";
import { STORE_TOAST_ACTIVATOR_CLSID } from "./toast-activator.js";
import { guardHelpTarget, readLoginItem, storeGates, writeLoginItem } from "./store-gates.js";
import { ignoredClickHandler } from "./ignored-click.js";
import { Toasts, spamStripUrls } from "./toasts.js";
import type { ToastResult } from "./toasts.js";

// What a Store (appx) install leaves out: the update check, the sponsor link, start at sign-in (store-gates.ts).
const STORE = storeGates((process as { readonly windowsStore?: unknown }).windowsStore);

/** Written next to this file by the release build; absent in a build from source (scripts/write-builtin-client.mjs). */
const builtInClientPath = join(import.meta.dirname, BUILTIN_CLIENT_FILE);

// Groups the windows under one taskbar identity. Placeholder id: confirm before the first installer ships.
const APP_USER_MODEL_ID = "com.senderban.desktop";

app.setName("Senderban");
const logDir = join(app.getPath("userData"), "logs");
const log = createLog(logDir);
const settings = new SettingsStore(join(app.getPath("userData"), "settings.json"));
const quiet = new QuietStore(join(app.getPath("userData"), "quiet.json"));
/** The mailboxes with a spam filter: read per announced mail and per sync round, so no disk read there. */
const spamFilters = new Map<string, SpamFilter>();
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
  readonly accounts: readonly ImapAccountConfig[];
  /** Every engine lane: each account's own, plus one per MXroute blacklist (server, user, domain) in use. */
  readonly lanes: readonly string[];
  readonly watchers: ReadonlyMap<string, AccountWatcher>;
  /** The new-mail watchers of the Gmail accounts that have a lane (ADR 0009 point 5). */
  readonly gmailWatchers: GmailWatchers;
  /** The same for Outlook and Microsoft 365 (ADR 0013). */
  readonly outlookWatchers: MailWatchers;
  readonly pending: PendingBlocks;
  /** Account id -> the address the person knows it by. */
  readonly labels: ReadonlyMap<string, string>;
  /** The person's own addresses and mail domains: never refused at the server. Follows accounts.json (own-mail.ts). */
  readonly own: OwnMailSet;
  /** What removing or signing out a Gmail account does about its filters (google-accounts.ts). */
  readonly gmail: GmailFilterLifecycle;
  readonly sieve: SieveRulesLifecycle;
  /** What removing a Microsoft account does about its rules (microsoft-accounts.ts). */
  readonly microsoft: MicrosoftRuleLifecycle;
  /** Stops the lanes of a key the person removed. */
  readonly retireMxrouteKey: (ref: MxrouteKeyRef) => void;
  /** Stops a removed "Other (IMAP)" mailbox. */
  readonly retireClean: (accountId: string) => void;
}

/** Resolves once the store, engine and watchers exist; an activation that launched the app waits for it. */
const ready = Promise.withResolvers<Runtime>();
let paused = false;
let quitting = false;
const states = new Map<string, WatcherState | GmailWatcherState>();
let tray: Tray | null = null;
let toasts: Toasts | null = null;
let manage: ManageWindow | null = null;
/** The once-a-day release check; null until start() has read the settings. */
let updates: UpdateChecker | null = null;
/** Set once start() has finished; the manage window reads the list from it. */
let runtime: Runtime | null = null;
let startFailed = false;

/** A toast without buttons: a state change the person should know about. */
function notice(title: string, body: string): void {
  toasts?.notice(title, body);
}

/** Accounts whose last sync failed and whose person was told; cleared by the next sync that did not fail. */
const unsynced = new Set<string>();
/**
 * Lanes whose block was written but not read back. Apart from `unsynced`, whose job is one notice per failure: this one must not
 * silence a later real failure. Cleared by the next round that wrote something.
 */
const unconfirmed = new Set<string>();

/**
 * Each running MXroute lane's addresses, kept until the lane's next round. Reading them on every list read would cost the main
 * process 0.5 s at 50 lanes of 5,000 (measured 2026-10-30). One set per running lane, 22 MB at most at that size.
 */
const refusedByLane = new Map<string, ReadonlySet<string>>();

/** Asks whether a running MXroute lane holds an address, or null when a lane's state cannot be read. */
function refusedAddresses(): HeldAddresses | null {
  for (const laneId of refusedByLane.keys()) {
    if (!mxrouteLanes.has(laneId)) refusedByLane.delete(laneId);
  }
  const held: ReadonlySet<string>[] = [];
  try {
    for (const laneId of mxrouteLanes) {
      let values = refusedByLane.get(laneId) ?? null;
      if (values === null) {
        const state = runtime?.store.getState(laneId);
        if (state === undefined) continue;
        values = mxrouteStateValues(state);
        if (values === null) return null;
        refusedByLane.set(laneId, values);
      }
      held.push(values);
    }
  } catch {
    // No detail: a parse error quotes the row, and the row holds addresses.
    log("list-state-failed", {});
    return null;
  }
  return { has: (value) => held.some((set) => set.has(value)) };
}
/**
 * Lanes whose last round left nothing to send (`unchanged`, or `applied` with no `deferred` backlog). A Gmail toast says "goes to Trash"
 * only for a lane in here: the signal is positive, so a start-up pass, a queued sync or a backlog read as "not confirmed yet".
 */
const gmailSettled = new Set<string>();
/** Accounts a toast click is working on right now: the result toast reports their outcome, a notice would repeat it. */
const clicking = new Set<string>();
/** Engine lanes that write to an MXroute blacklist: their failures are about the API key, not the mail password. */
const mxrouteLanes = new Set<string>();
/** Engine lanes that write Gmail filters: their failures are about Google's sign-in, not a mail password. */
const gmailLanes = new Set<string>();
/** Engine lanes that write Outlook rules: their failures are about Microsoft's sign-in, not a mail password. */
const microsoftLanes = new Set<string>();
/** Every Gmail lane that announced mail this session, removed ones included (at most MAX_ACCOUNTS): their toasts are trash-only. */
const gmailToastLanes = new Set<string>();
/** Gmail lanes held still while their account is being removed (a failed fan-out round is not news then). */
const heldGmailLanes = createHeldLanes();
const heldSieveLanes = createHeldLanes();

/** What the toast of a mail from `sender` offers on an IMAP account. */
function imapOffer(
  accountId: string,
  sender: string,
  own: ReturnType<OwnMailSet["get"]>,
): Pick<MailToast, "domain" | "rejectsAtServer"> {
  return {
    domain: blockableDomain(sender, own),
    // A wildcard address is never written to the blacklist (it would refuse a whole provider).
    rejectsAtServer: rejectingAccounts.has(accountId) && canRejectSender(sender, own),
  };
}

/** A click carries no mail text, so a toast of an earlier run comes back without its subject. */
const SUBJECT_NOT_KEPT = "(subject not kept after a restart)";

/** Gmail accounts that have no lane this session (signed out, expired, no client): a block or an Unblock does not reach them. */
let gmailSkipped: GmailSkipped[] = [];
/** Microsoft accounts that have no lane this session: a block or an Unblock does not reach them. */
let microsoftSkipped: MicrosoftSkipped[] = [];
/** Lanes that move mail themselves ("Other (IMAP)"): no rule on a server, so nothing may claim one. */
const cleanLanes = new Set<string>();
/** Cleaning lanes the person was told cannot move their mail; cleared by the next move that works. */
const cleanFailing = new Set<string>();
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
  refusedByLane.delete(id);
  if (outcome.status === "applied" && unconfirmed.delete(id)) manage?.notifyListSoon();
  if (
    outcome.status === "unchanged" ||
    (outcome.status === "applied" && (outcome.deferred ?? 0) === 0)
  ) {
    // Their entries stop reading "Not confirmed" now.
    if ((gmailLanes.has(id) || microsoftLanes.has(id)) && !gmailSettled.has(id)) {
      manage?.notifyListSoon();
    }
    gmailSettled.add(id);
  } else {
    gmailSettled.delete(id);
  }
  if (ok) {
    // An MXroute round is what makes a fresh "Block at server" true, and it ends after the list was last drawn.
    if (unsynced.delete(id)) manage?.notifyChanged();
    else if (mxrouteLanes.has(id) && outcome.status === "applied") manage?.notifyListSoon();
    return;
  }
  if (clicking.has(id) || heldGmailLanes.has(id) || heldSieveLanes.has(id) || unsynced.has(id)) {
    return;
  }
  unsynced.add(id);
  manage?.notifyChanged();
  const label = runtime?.labels.get(id) ?? id;
  const why = unsyncedReason(outcome);
  const next =
    outcome.status !== "failed"
      ? "Open Blocked senders to check."
      : willRetry(outcome.code)
        ? "Senderban will try again."
        : outcome.code === "AUTH_REQUIRED"
          ? mxrouteLanes.has(id)
            ? "MXroute refused the API key: fix it under Accounts in Senderban, then restart Senderban."
            : gmailLanes.has(id)
              ? "Google refused the sign-in: sign in again under Accounts in Senderban, then restart Senderban."
              : microsoftLanes.has(id)
                ? "Microsoft refused the sign-in: sign in again under Accounts in Senderban, then restart Senderban. If your organization must approve Senderban, ask your administrator."
                : "The password was refused: Senderban will not use it again for 30 minutes. Fix it, then restart Senderban."
          : outcome.code === "REMOTE_CHANGED"
            ? "Someone else changed Senderban's script on the server, so it stopped instead of overwriting it. It will not try again by itself."
            : "Check the account in Senderban.";
  notice("Senderban", `The block list is not up to date on ${label} (${why}). ${next}`);
}

/** Mail a past-mail pass has moved so far, per lane: the person hears one number when the pass ends. At most one per cleaning lane. */
const cleanedMail = new Map<string, { readonly moved: number; readonly failed: number }>();

/** Moving old mail out of an inbox is a change the person should see, and Unblock does not undo it. */
function noticeCleaned(id: string, label: string, event: CleanEvent): void {
  if (event.kind !== "retro") return;
  const before = cleanedMail.get(id) ?? { moved: 0, failed: 0 };
  const moved = before.moved + event.moved;
  const failed = before.failed + event.failed;
  if ((event.left ?? 0) > 0) {
    cleanedMail.set(id, { moved, failed });
    return;
  }
  cleanedMail.delete(id);
  if (moved === 0 && failed === 0) return;
  const done =
    moved === 0
      ? ""
      : `${String(moved)} older message(s) from blocked senders moved out of the inbox of ${label}, to Junk or Trash. Unblock does not bring them back.`;
  const unread =
    failed === 0
      ? ""
      : ` ${String(failed)} older message(s) in ${label} could not be read and were left in the inbox, blocked or not.`;
  notice("Senderban", (done + unread).trim());
}

/** A server that refuses the move leaves blocked mail in the Inbox: said once, not per mail. */
function noticeCleanFailure(id: string, label: string, event: CleanEvent): void {
  if (event.kind !== "arrival") return;
  if (event.failed === 0) {
    cleanFailing.delete(id);
    return;
  }
  if (cleanFailing.has(id)) return;
  cleanFailing.add(id);
  notice(
    "Senderban",
    `${label} refused to move mail from a blocked sender, so it is still in the inbox. Check that the mailbox has a Junk folder.`,
  );
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
      if (cleanLanes.has(result.accountId)) {
        // Not a plain success: no rule was written, so this shows with "Confirm each block" off too.
        return {
          tone: "warn",
          text: `${result.target}: while it runs, Senderban moves its mail in ${where} to ${destination(folderAction(result.action))}, also from the last ${String(RETRO_DAYS)} days. This is no rule on the server, and Unblock does not bring moved mail back.${others}`,
        };
      }
      // A toast outlives the choice it offered: the key may have been removed while it was on screen.
      if (result.action === "reject" && !rejectingAccounts.has(result.accountId)) {
        return {
          tone: "warn",
          text: `${result.target}: rule verified on ${where}, but the server will not refuse this sender: the MXroute blacklist is not in use. Its mail goes to Junk.${others}`,
        };
      }
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
    const read = result.accounts.some((a) => !cleanLanes.has(a.accountId))
      ? " and was read back from the provider"
      : "";
    const moved = result.accounts.some((a) => cleanLanes.has(a.accountId))
      ? " Mail Senderban already moved stays where it is."
      : "";
    return {
      tone: "ok",
      text: `✓ ${value} unblocked. The rule is gone from ${String(result.accounts.length)} place(s)${read}.${moved}`,
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
  manage?.notifyStatus();
  if (tray === null) return;
  const lines = [...states].map(([id, state]) => ({
    // A Microsoft lane's id means nothing to the person.
    label: `${microsoftLanes.has(id) ? (runtime?.labels.get(id) ?? id) : id}: ${state}`,
    enabled: false,
  }));
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
          void setPaused(!paused, "tray");
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

async function setPaused(value: boolean, by: "tray" | "window"): Promise<void> {
  paused = value;
  const started = Date.now();
  const { watchers, gmailWatchers, outlookWatchers } = await ready.promise;
  const result = await applyPause(value, [...watchers.values()], {
    stop: () => {
      gmailWatchers.stop();
      outlookWatchers.stop();
    },
    resume: () => {
      gmailWatchers.resume();
      outlookWatchers.resume();
    },
  });
  log("pause", { paused: value, by, ...result, ms: Date.now() - started });
  updateTray();
}

/**
 * The MXroute keys for this run. Trouble with them never stops the app: without a key there is no blacklist lane, and
 * Sieve goes on blocking. What 0.1.2 and older kept inside a mailbox moves to the key file first.
 */
async function startMxrouteKeys(keysPath: string, accountsPath: string) {
  try {
    const moved = await migrateMxrouteKeys(keysPath, accountsPath);
    if (moved > 0) log("mxroute-migrated", { accounts: moved });
  } catch {
    // A move that stopped halfway has written the key file: the keys below still work, and the next start finishes it.
    log("mxroute-keys-failed", { step: "move" });
  }
  try {
    return await loadMxrouteKeys(keysPath);
  } catch {
    log("mxroute-keys-failed", { step: "read" });
    return [];
  }
}

/** Never the key, the user name or the server. */
const keyTag = (key: MxrouteKeyRef): string => accountTag(`${key.username}@${key.server}`);

async function start(): Promise<Runtime> {
  const dir = app.getPath("userData");
  // Before any watcher: the first toast already follows the person's choices.
  await settings.load((reason) => {
    log("settings-unreadable", { reason });
  });
  updates = new UpdateChecker({
    statePath: join(dir, "update.json"),
    current: app.getVersion(),
    fetch: (url, init) => net.fetch(url, init),
    writeState: writeJsonAtomic,
    // A Store install is updated by the Store; asking GitHub there would only offer a second, different installer.
    enabled: () => settings.current.checkUpdates && STORE.updateCheck,
    onNew: (version) => {
      notice(
        `Senderban ${version} is out`,
        "Open Senderban, then Help, for the release notes and the download.",
      );
    },
    log,
  });
  // A Store build never starts it: no request, no daily timer.
  if (STORE.updateCheck) void updates.start();
  await quiet.load((reason) => {
    log("quiet-unreadable", { reason });
  });
  const mxrouteKeys = await startMxrouteKeys(
    join(dir, "mxroute-keys.json"),
    join(dir, "accounts.json"),
  );
  const configured = await loadAccounts(join(dir, "accounts.json"));
  // IMAP/Sieve accounts get a watcher and a Sieve lane; a Gmail account gets a background filter lane and a new-mail
  // watcher (below).
  const accounts = configured.filter(isImapAccount);
  const store = new Store(openDatabase(join(dir, "senderban.db")));
  log("start", {
    accounts: accounts.length,
    clean: configured.filter(isCleanAccount).length,
    skipped: configured.length - accounts.length,
    electron: process.versions.electron,
    // Windows started this process for a click on a toast (build/appx-extensions.xml): a run of these without a click is a restart loop.
    cold: process.argv.includes("-ToastActivated"),
  });
  // Never-refuse set for "Block at server" (ADR 0008 point 3); see own-mail.ts.
  const own = createOwnMail(collectOwnMail(configured), () =>
    loadAccounts(join(dir, "accounts.json")),
  );
  // One test per own set (it changes only when accounts change), so the engine can keep its filtered list.
  let ownCache: { readonly own: OwnMail; readonly test: (entry: BlockEntry) => boolean } | null =
    null;
  const ownTest = (current: OwnMail) => {
    if (ownCache?.own !== current)
      ownCache = { own: current, test: (entry) => isOwnEntry(entry, current) };
    return ownCache.test;
  };
  const engine = new SyncEngine(store, {
    // An entry that reaches the person's own mail is never written to any provider, whenever it was stored (ADR 0009 point 6).
    exclude: () => ownTest(own.get()),
    onOutcome: (outcome) => {
      log("sync", {
        account: accountTag(outcome.accountId),
        status: outcome.status,
        ...(outcome.status === "failed" ? { code: outcome.code, detail: outcome.message } : {}),
        ...(outcome.status === "applied" || outcome.status === "partial"
          ? { applied: outcome.applied, failed: outcome.failed, deferred: outcome.deferred }
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
  const blacklists = mxrouteGroups(
    mxrouteKeys,
    accounts,
    (id) => store.getState(mxrouteLaneId(id)) !== undefined,
  );
  // One gate for every watcher: start, resume and unpause open at most MAX_CONCURRENT_LOGINS logins at once.
  const loginGate = createGate(MAX_CONCURRENT_LOGINS);
  const sieveLanes = new Map<string, SieveLane>();
  const mxrouteAdapters = new Map<string, MxrouteAdapter>();
  const skippedAccounts = new Set<string>();

  // What a new mail, a burst or a state change means is the same for every kind of IMAP watcher.
  const announce: Pick<WatcherOptions, "onMessage" | "onOverflow" | "onUnreadable" | "onState"> = {
    onMessage: (accountId: string, message: IncomingMessage) => {
      // The same rule as the Gmail watcher: an own address is never blocked (blockPending refuses it), so no button.
      if (isOwnMailbox(message.from, own.get())) {
        log("announce", {
          account: accountTag(accountId),
          uid: message.uid,
          sender: "own-address",
        });
        notice(
          "Senderban",
          `New mail in ${labels.get(accountId) ?? accountId} claims to come from your own address, so there is no Block button.${subjectLine(message.subject)}`,
        );
        return;
      }
      if (isQuiet(message.from, quiet.entries)) {
        log("announce", { account: accountTag(accountId), uid: message.uid, sender: "quiet" });
        return;
      }
      const id = pending.add({ accountId, sender: message.from });
      log("announce", {
        account: accountTag(accountId),
        uid: message.uid,
        domain: domainOf(message.from),
      });
      toasts?.show({
        id,
        accountId,
        issuedAt: Math.floor(Date.now() / 1000),
        sender: message.from,
        subject: message.subject,
        account: labels.get(accountId) ?? accountId,
        spamScore: message.spamScore,
        overSpamLimit: overSpamLimit(spamFilters.get(accountId) ?? null, message.spamScore),
        ...imapOffer(accountId, message.from, own.get()),
      });
    },
    onOverflow: (accountId, skipped) => {
      log("overflow", { account: accountTag(accountId), skipped });
      notice(
        "Senderban",
        `${String(skipped)} more new messages in ${labels.get(accountId) ?? accountId} were not announced.`,
      );
    },
    onUnreadable: (accountId, skipped) => {
      log("unreadable-mail", { account: accountTag(accountId), skipped });
      notice(
        "Senderban",
        `A mail in ${labels.get(accountId) ?? accountId} was too large to read, so up to ${String(skipped)} new messages were not announced. Check that inbox.`,
      );
    },
    onState: (accountId, state, detail) => {
      const previous = states.get(accountId);
      states.set(accountId, state);
      updateTray();
      // Its list rows depend on this: nothing moves while the watcher is away.
      if (cleanLanes.has(accountId)) manage?.notifyListSoon();
      log("watcher", { account: accountTag(accountId), state, detail });
      if (state === "halted" && previous !== "halted") {
        notice(
          "Senderban stopped watching",
          `${labels.get(accountId) ?? accountId}: ${detail ?? "sign-in failed"}`,
        );
      }
    },
  };

  for (const account of accounts) {
    if (account.spamFilter !== undefined) spamFilters.set(account.id, account.spamFilter);
    const sieveAdapter = new SieveAdapter({
      accountId: account.id,
      spamRule: () => spamRule(spamFilters.get(account.id) ?? null),
      connect: async () =>
        connectManageSieve({
          host: account.sieve.host,
          port: account.sieve.port,
          username: account.sieve.user,
          password: await decryptPassword(account.passwordCipher),
        }),
    });
    try {
      engine.addAccount({
        id: account.id,
        initialState: initialSieveState(),
        adapter: sieveAdapter,
      });
    } catch {
      // A hand-edited file can hold an id that is another lane's: that one account stays off, the rest of the app starts.
      log("account-skipped", { account: accountTag(account.id) });
      skippedAccounts.add(account.id);
      const at = lanes.indexOf(account.id);
      if (at >= 0) lanes.splice(at, 1);
      notice(
        "Senderban",
        `${account.imap.user} could not start: its id clashes with another account. Remove it under Accounts and add it again.`,
      );
      continue;
    }
    sieveLanes.set(account.id, sieveAdapter);

    const group = blacklists.get(account.id);
    if (group?.owner === account.id) {
      // A second lane next to the Sieve one: it mirrors single addresses onto the MXroute blacklist, or, while
      // the person has it switched off, only takes back what it put there (no request when it put nothing).
      const laneId = mxrouteLaneId(account.id);
      const { key, domain } = group;
      try {
        const mxrouteAdapter = new MxrouteAdapter({
          accountId: laneId,
          mirror: group.mirror,
          client: createMxrouteClient({
            server: key.server,
            username: key.username,
            getKey: () => decryptPassword(key.apiKeyCipher),
            // Operation, HTTP status and duration only: no key, no address.
            onCall: (call) => {
              log("mxroute-call", { account: accountTag(account.id), ...call });
            },
          }),
        });
        engine.addAccount({
          id: laneId,
          initialState: initialMxrouteState(domain),
          background: true,
          adapter: mxrouteAdapter,
        });
        mxrouteAdapters.set(laneId, mxrouteAdapter);
        lanes.push(laneId);
        mxrouteLanes.add(laneId);
        labels.set(laneId, `${labels.get(account.id) ?? account.id} (MXroute)`);
        log("mxroute-lane", { account: accountTag(account.id), mirror: group.mirror });
      } catch {
        log("mxroute-lane-skipped", { account: accountTag(account.id) });
      }
    }

    // Every mailbox on a domain whose lane is live and switched on gets the server-side refusal, not only the owner.
    if (group?.mirror === true && mxrouteLanes.has(mxrouteLaneId(group.owner))) {
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
        ...announce,
      }),
    );
    states.set(account.id, "stopped");
  }

  // "Other (IMAP)" mailboxes: no rule on any server, so the lane's rules act on the watcher's own connection (ADR 0014).
  const cleanAdapters = new Map<string, ImapCleanAdapter>();
  for (const account of configured.filter(isCleanAccount)) {
    const link = new CleanLink();
    let adapter: ImapCleanAdapter;
    try {
      adapter = new ImapCleanAdapter({
        accountId: account.id,
        link,
        initialState: store.getState(account.id) ?? initialCleanState(),
        updateState: (change) => {
          store.setState(account.id, change(store.getState(account.id) ?? initialCleanState()));
        },
        onRested: () => {
          engine.requestSync(account.id);
        },
        onClean: (event) => {
          log("clean", { account: accountTag(account.id), ...event });
          noticeCleanFailure(account.id, account.clean.address, event);
          noticeCleaned(account.id, account.clean.address, event);
        },
      });
      engine.addAccount(cleanLane(account.id, adapter));
    } catch {
      log("account-skipped", { account: accountTag(account.id) });
      notice(
        "Senderban",
        `${account.clean.address} could not start: its id clashes with another account, or its saved state cannot be read. Remove it under Accounts and add it again.`,
      );
      continue;
    }
    cleanAdapters.set(account.id, adapter);
    lanes.push(account.id);
    cleanLanes.add(account.id);
    labels.set(account.id, account.clean.address);
    // A queue left by a round that found the mailbox away goes on as soon as there is one.
    link.onOpen(() => {
      if (adapter.hasWork) engine.requestSync(account.id);
    });
    const onCleanGap = cleanGapListener({
      sweepAll: (force) => {
        adapter.sweepAll(force);
      },
      requestSync: () => {
        engine.requestSync(account.id);
      },
      log: (fields) => {
        log("sweep-save-failed", { account: accountTag(account.id), ...fields });
      },
    });
    const { host, port, secure, user } = account.clean;
    watchers.set(
      account.id,
      new AccountWatcher({
        accountId: account.id,
        cursors: store.cursors,
        gate: loginGate,
        connect: cleanConnector(
          { host, port, secure, user, password: () => decryptPassword(account.passwordCipher) },
          link,
        ),
        screen: (fresh) => adapter.screen(fresh),
        onGap: (_, reason) => {
          onCleanGap(reason);
        },
        ...announce,
      }),
    );
    states.set(account.id, "stopped");
  }

  // Gmail: one background lane per signed-in account (filters, Trash, single addresses). A restart picks up a sign-in made
  // while the app runs, as for MXroute.
  let oauth: ReturnType<typeof createOAuthClient> | null = null;
  let noClientReason: "no-client" | "client-unreadable" = "no-client";
  try {
    const activeClient = await activeGoogleClient(
      join(dir, "google-client.json"),
      builtInClientPath,
    );
    if (activeClient !== null) {
      oauth = createOAuthClient({
        clientId: activeClient.clientId,
        getClientSecret: activeClient.getSecret,
        onCall: (call) => {
          log("google-call", { ...call });
        },
      });
    }
  } catch {
    // An unreadable client file is shown on the Gmail page; the lanes wait for it.
    noClientReason = "client-unreadable";
  }
  const built = buildGmailLanes({
    accounts: configured,
    oauth,
    noClientReason,
    // A Gmail lane id that another lane already holds (an IMAP account named `me.gmail` next to a Gmail account `me`) is
    // left out, so one entry of accounts.json cannot stop the whole app from starting.
    reservedLaneIds: new Set(lanes),
    budgets: new GmailBudgets(),
    isOwn: (address) => isOwnMailbox(address, own.get()),
    saveState: (laneId, state) => {
      store.setState(laneId, state);
    },
    decrypt: decryptPassword,
    log,
  });
  gmailSkipped = [...built.skipped];
  const gmailLaneByAccount = new Map<string, GmailLane>();
  for (const lane of built.lanes) {
    try {
      engine.addAccount({
        id: lane.laneId,
        initialState: initialGmailState(),
        background: true,
        adapter: lane.adapter,
      });
    } catch {
      // The engine refused it (lane limit): left out like the others, and told in the result toasts.
      log("gmail-lane-skipped", { account: accountTag(lane.accountId), reason: "engine" });
      gmailSkipped.push({ accountId: lane.accountId, email: lane.email, reason: "lane-id" });
      continue;
    }
    lanes.push(lane.laneId);
    gmailLanes.add(lane.laneId);
    gmailLaneByAccount.set(lane.accountId, lane);
    labels.set(lane.laneId, `${lane.email} (Gmail)`);
  }
  // One new-mail watcher per Gmail lane that the engine accepted. The lane id is the account id of the pending block, the toast
  // click and the cursor, so a click on a Gmail toast syncs the Gmail lane (a trash-only account, see `choose`).
  const gmailWatchers = createGmailWatchers({
    lanes: [...gmailLaneByAccount.values()].map((lane) => {
      gmailToastLanes.add(lane.laneId);
      return lane;
    }),
    cursors: store.gmailCursors,
    // Its own gate: a Google outage (every poll waiting out its request) must not hold the slots the IMAP logins need.
    gate: createGate(MAX_CONCURRENT_GMAIL_POLLS),
    isHeld: (laneId) => heldGmailLanes.has(laneId),
    isOwn: (address) => isOwnMailbox(address, own.get()),
    isQuiet: (address) => isQuiet(address, quiet.entries),
    pending,
    showMail: (toast) => {
      toasts?.show(toast);
    },
    notice,
    labelOf: (laneId) => labels.get(laneId) ?? laneId,
    onState: (laneId, state) => {
      states.set(laneId, state);
      updateTray();
    },
    log,
  });
  const gmail = createGmailLifecycle({
    lanes: gmailLaneByAccount,
    store,
    log,
    // While a lane is held still for a removal, a failed fan-out round is not news: the removal reports its own outcome.
    // Its mail watcher is held with it: a poll that announces mail for an account being removed would offer a Block button
    // for a lane that is going away.
    onHold: (laneId, held) => {
      heldGmailLanes.hold(laneId, held);
      if (held) gmailWatchers.stopOne(laneId);
    },
    skipReasonOf: (accountId) => gmailSkipped.find((s) => s.accountId === accountId)?.reason,
    // A removal that did not finish: the lane catches up with the blocks and Unblocks made while it was held, and its
    // watcher looks again (unless the person paused watching meanwhile).
    onResumed: (laneId) => {
      engine.requestSync(laneId);
      if (!paused) gmailWatchers.startOne(laneId);
    },
    // A removed or signed-out account no longer takes part in a block or an Unblock; a signed-out one is named in the toasts.
    onDone: (accountId, why, lane) => {
      if (lane !== undefined) {
        const at = lanes.indexOf(lane.laneId);
        if (at >= 0) lanes.splice(at, 1);
        gmailLanes.delete(lane.laneId);
        labels.delete(lane.laneId);
        gmailLaneByAccount.delete(accountId);
        // Its watcher is dropped and its cursor deleted (a new sign-in starts from "now", not from a stale position).
        gmailWatchers.forget(lane.laneId);
        // A toast of this account that is still on screen answers "expired" now, not "read back from the provider".
        pending.dropAccount(lane.laneId);
        states.delete(lane.laneId);
        gmailSettled.delete(lane.laneId);
        updateTray();
        // The open window's rows said "Gmail: Trash" for this lane.
        manage?.notifyChanged();
      }
      // An account that had no lane this session may still have a cursor from an earlier one. A removed account takes its
      // state and journal with it; a signed-out one keeps them (its filters may still be in Gmail, and a new sign-in reuses the id).
      if (why === "removed") store.forgetAccount(gmailLaneId(accountId));
      else store.gmailCursors.delete(gmailLaneId(accountId));
      gmailSkipped = skippedAfterDone(gmailSkipped, accountId, why, lane?.email);
      log("gmail-lane-retired", {
        account: accountTag(accountId),
        why,
        hadLane: lane !== undefined,
      });
    },
  });

  // Microsoft: one background lane per signed-in account, and a new-mail watcher on it (ADR 0013).
  const microsoftId = microsoftClientId();
  const graphBudgets = new GraphBudgets();
  const microsoftBuilt = buildMicrosoftLanes({
    accounts: configured,
    oauth:
      microsoftId === null
        ? null
        : createMicrosoftOAuthClient({
            clientId: microsoftId,
            onCall: (call) => {
              log("microsoft-call", { ...call });
            },
          }),
    budgets: graphBudgets,
    own: () => own.get(),
    reservedLaneIds: new Set(lanes),
    saveState: (laneId, state) => {
      store.setState(laneId, state);
    },
    decrypt: decryptPassword,
    saveRefreshToken: (accountId, token) =>
      storeRefreshToken(join(dir, "accounts.json"), accountId, token),
    log,
  });
  microsoftSkipped = [...microsoftBuilt.skipped];
  const microsoftLaneByAccount = new Map<string, MicrosoftLane>();
  for (const lane of microsoftBuilt.lanes) {
    try {
      engine.addAccount({
        id: lane.laneId,
        initialState: initialGraphState(),
        background: true,
        ownGate: true,
        adapter: lane.adapter,
      });
    } catch {
      log("graph-lane-skipped", { account: accountTag(lane.accountId), reason: "engine" });
      microsoftSkipped.push({ accountId: lane.accountId, email: lane.email, reason: "lane-id" });
      continue;
    }
    lanes.push(lane.laneId);
    microsoftLanes.add(lane.laneId);
    microsoftLaneByAccount.set(lane.accountId, lane);
    labels.set(lane.laneId, `${lane.email} (Outlook)`);
  }
  const outlookWatchers = createOutlookWatchers({
    lanes: [...microsoftLaneByAccount.values()],
    cursors: store.outlookCursors,
    gate: createGate(MAX_CONCURRENT_OUTLOOK_POLLS),
    own: () => own.get(),
    isHeld: (laneId) => heldGmailLanes.has(laneId),
    isOwn: (address) => isOwnMailbox(address, own.get()),
    isQuiet: (address) => isQuiet(address, quiet.entries),
    pending,
    showMail: (toast) => {
      toasts?.show(toast);
    },
    notice,
    labelOf: (laneId) => labels.get(laneId) ?? laneId,
    onState: (laneId, state) => {
      states.set(laneId, state);
      updateTray();
    },
    log,
  });
  const microsoft = createMicrosoftLifecycle({
    lanes: microsoftLaneByAccount,
    store,
    log,
    // The same set as Gmail's: while a lane is held for a removal, a failed fan-out round is not news, and a poll must not offer a Block button for a lane that is going away.
    onHold: (laneId, held) => {
      heldGmailLanes.hold(laneId, held);
      if (held) outlookWatchers.stopOne(laneId);
    },
    onResumed: (laneId) => {
      engine.requestSync(laneId);
      if (!paused) outlookWatchers.startOne(laneId);
    },
    skipReasonOf: (accountId) => microsoftSkipped.find((s) => s.accountId === accountId)?.reason,
    onDone: (accountId, lane) => {
      if (lane !== undefined) {
        const at = lanes.indexOf(lane.laneId);
        if (at >= 0) lanes.splice(at, 1);
        microsoftLanes.delete(lane.laneId);
        labels.delete(lane.laneId);
        microsoftLaneByAccount.delete(accountId);
        graphBudgets.forget(lane.laneId);
        outlookWatchers.forget(lane.laneId);
        pending.dropAccount(lane.laneId);
        states.delete(lane.laneId);
        updateTray();
        manage?.notifyChanged();
      }
      store.forgetAccount(graphLaneId(accountId));
      microsoftSkipped = microsoftSkipped.filter((s) => s.accountId !== accountId);
      log("graph-lane-retired", { account: accountTag(accountId), hadLane: lane !== undefined });
    },
  });

  const sieve = createSieveLifecycle({
    lanes: sieveLanes,
    skipped: skippedAccounts,
    store,
    log,
    attemptDone: (accountId) => engine.attemptDone(accountId),
    // A failed round during the removal is not news: the removal reports its own outcome.
    onHold: (accountId, held) => {
      heldSieveLanes.hold(accountId, held);
    },
    onResumed: (accountId) => {
      engine.requestSync(accountId);
    },
    // A removed account no longer takes part in a block or an Unblock.
    onDone: (accountId, rulesRemain) => {
      dropImapAccount(accountId, rulesRemain, {
        lanes,
        labels,
        mxrouteLanes,
        mxrouteAdapters,
        rejectingAccounts,
        blacklistGroup: (id) => blacklists.get(id)?.members ?? [],
        pending,
        store,
        settled: (id) => engine.settled(id),
        sieveLanes,
        watchers,
        states,
      });
      updateTray();
      manage?.notifyChanged();
    },
  });

  // Interrupted syncs from a previous run are repaired in the background: `recover()` closes the interrupted journal rows
  // before its first await, so a block clicked later queues behind the repair on its lane (one round per lane at a time),
  // and new mail is announced meanwhile instead of after up to 60 s per wave of stuck lanes.
  const recovery = engine.recover();
  for (const watcher of watchers.values()) watcher.start();
  gmailWatchers.start();
  outlookWatchers.start();
  void recovery
    .then((reports) => {
      for (const report of reports) {
        log("recovered", {
          account: accountTag(report.accountId),
          interrupted: report.interrupted,
          drifted: report.drift?.drifted,
          verifyError: report.verifyError,
        });
      }
    })
    .catch((error: unknown) => {
      log("recover-failed", { detail: errorText(error) });
    })
    // A rule change that never reached a provider (an unblock that failed, a crash after the list
    // changed) is applied now. The plan is computed locally, so only accounts with a difference connect.
    .then(() => engine.syncAll());

  powerMonitor.on("resume", () => {
    log("resume", { paused });
    // A socket that slept is dead but not yet reported (ADR 0003): rebuild instead of trusting it.
    if (!paused) for (const watcher of watchers.values()) watcher.reconnectNow();
    // A poll that slept may have died unreported: look soon, spread over 30 s like a start (50 accounts do not tick together).
    if (!paused) gmailWatchers.resumeNow();
    if (!paused) outlookWatchers.resumeNow();
  });
  return {
    store,
    engine,
    accounts,
    lanes,
    watchers,
    gmailWatchers,
    outlookWatchers,
    pending,
    labels,
    own,
    gmail,
    sieve,
    microsoft,
    retireMxrouteKey: (ref) => {
      dropMxrouteKey(ref, blacklists.values(), {
        lanes,
        labels,
        mxrouteLanes,
        mxrouteAdapters,
        rejectingAccounts,
        pending,
      });
    },
    retireClean: (accountId) => {
      cleanLanes.delete(accountId);
      cleanFailing.delete(accountId);
      cleanedMail.delete(accountId);
      dropCleanAccount(accountId, {
        cleanLanes: cleanAdapters,
        lanes,
        labels,
        pending,
        store,
        settled: (id) => engine.settled(id),
        watchers,
        states,
      });
      updateTray();
    },
  };
}

async function shutdown(): Promise<void> {
  updates?.stop();
  cancelGoogleSignIn();
  cancelMicrosoftSignIn();
  const current = await ready.promise.catch(() => null);
  if (current === null) return;
  log("quit");
  toasts?.closeAll();
  manage?.closeAll();
  current.engine.dispose();
  current.gmailWatchers.stop();
  current.outlookWatchers.stop();
  // A session still logging out is cut by the process exit that follows; the store closes either way.
  await stopThenClose({
    stop: () => Promise.allSettled([...current.watchers.values()].map((w) => w.stop())),
    closeStore: () => {
      current.store.close();
    },
    log,
    ms: SHUTDOWN_DEADLINE_MS,
  });
}

const addAccountArg = process.argv.find((a) => a.startsWith("--add-account="));

if (addAccountArg !== undefined && !app.requestSingleInstanceLock()) {
  // The running app rewrites accounts.json too (a key save under Accounts): two writers would lose one change.
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
  // A packaged toast click reaches handleActivation only through the COM activator in the manifest; without it Windows starts a new
  // process with the button's arguments and drops the Junk/Trash choice (.task/store-msix.md).
  if (STORE.storeInstall) app.setToastActivatorCLSID(STORE_TOAST_ACTIVATOR_CLSID);

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
    // The cap also covers a start still running (`ready` not settled), which `stopThenClose` does not.
    void settleWithin(shutdown(), SHUTDOWN_CAP_MS).then((outcome) => {
      if (outcome === "timeout") log("quit-cap", { ms: SHUTDOWN_CAP_MS });
      app.exit(0);
    });
  });

  void app.whenReady().then(() => {
    const accountsPath = join(app.getPath("userData"), "accounts.json");
    const keysPath = join(app.getPath("userData"), "mxroute-keys.json");
    const assets = join(import.meta.dirname, "../assets");
    const googleDeps: GoogleDeps = {
      accountsPath,
      clientPath: join(app.getPath("userData"), "google-client.json"),
      builtInClientPath,
      makeOAuth: (clientId, getClientSecret) =>
        createOAuthClient({
          clientId,
          getClientSecret,
          // Operation, HTTP status and duration only: no token, no code, no secret.
          onCall: (call) => {
            log("google-call", { ...call });
          },
        }),
      signIn,
      openBrowser: openGoogleAuthUrl((url) => shell.openExternal(url)),
      // A Gmail address connected or removed while the app runs changes who must never be refused at the server.
      // The lifecycle exists once start() has finished; a removal asked before that waits for it.
      filters: {
        classify: (accountId) => runtime?.gmail.classify(accountId) ?? "ready",
        prepare: async (accountId) => (await ready.promise).gmail.prepare(accountId),
        abort: (accountId) => {
          runtime?.gmail.abort(accountId);
        },
        done: (accountId, why) => {
          runtime?.gmail.done(accountId, why);
        },
      },
      onAccountsChanged: refreshOwnOnChange(
        async () => (await ready.promise).own,
        (error) => {
          log("own-refresh-failed", { detail: errorText(error) });
        },
      ),
    };
    const microsoftDeps: MicrosoftDeps = {
      accountsPath,
      clientId: microsoftClientId(),
      editedRules: (accountId) => {
        const state = runtime?.store.getState(graphLaneId(accountId));
        return state === undefined ? 0 : graphEditedRules(state);
      },
      makeOAuth: (clientId) =>
        createMicrosoftOAuthClient({
          clientId,
          // Operation, HTTP status and duration only: no token, no code.
          onCall: (call) => {
            log("microsoft-call", { ...call });
          },
        }),
      signIn: (options) =>
        signInMicrosoft({
          ...options,
          onWiderGrant: (extras) => {
            log("graph-scope-wider", { extras });
          },
          profile: {
            onCall: (call) => {
              log("microsoft-call", { ...call });
            },
          },
        }),
      openBrowser: openMicrosoftAuthUrl((url) => shell.openExternal(url)),
      rules: {
        prepare: async (accountId) => (await ready.promise).microsoft.prepare(accountId),
        abort: (accountId) => {
          runtime?.microsoft.abort(accountId);
        },
        done: (accountId) => {
          runtime?.microsoft.done(accountId);
        },
      },
      ...(googleDeps.onAccountsChanged === undefined
        ? {}
        : { onAccountsChanged: googleDeps.onAccountsChanged }),
    };
    // A click that started this process is handed over as soon as the handler is set, so it waits for this key.
    const activationSigner = loadActivationSigner(
      join(app.getPath("userData"), "activation-key.json"),
      {
        available: () => safeStorage.isAsyncEncryptionAvailable(),
        encrypt: (plain) => safeStorage.encryptStringAsync(plain),
        decrypt: async (cipher) => (await safeStorage.decryptStringAsync(cipher)).result,
      },
      (reason) => {
        log("toast-key", { result: "new", reason });
      },
    );
    void activationSigner.then((signer) => {
      if (signer === null) log("toast-key", { result: "none" });
    });
    toasts = new Toasts({
      settings: () => settings.current,
      spamStrips: spamStripUrls(assets),
      signer: () => activationSigner,
      onActivation: () => {
        log("toast-activation");
      },
      onIgnored: ignoredClickHandler({
        log: (reason) => {
          log("toast-ignored", { reason });
        },
        notice: (body) => {
          notice("Senderban", body);
        },
      }),
      onRefused: () => {
        log("toast-refused");
      },
      onReshown: (shown, waitedMs) => {
        log("toast-reshown", { shown, ms: waitedMs });
      },
      hold: (work) => (manage === null ? work() : manage.hold(work)),
      quiet: async (id, scope, restore) => {
        const { pending, own, lanes, labels } = await ready.promise;
        const restored = restoreClicked(pending, lanes, id, restore);
        const target = quietTarget(pending, id, scope, own.get());
        if (target.status !== "ok")
          log("quiet", { scope, result: target.status, restore: restored });
        if (target.status === "duplicate") return { tone: "warn", text: "Already handled." };
        if (target.status !== "ok") {
          return { tone: "warn", text: "This message has expired, so nothing changed." };
        }
        // The domain only, as `announce` logs it: enough to tell a second address of one sender from a list that did not hold.
        const listed = quiet.entries.has(target.value);
        // The mailbox it was chosen in, for the page's filter; a name the schema refuses is left out, not the click.
        const named = SourceSchema.safeParse(labels.get(target.accountId));
        const added = await quiet.add(target.value, named.success ? named.data : undefined);
        log("quiet", {
          scope,
          result: added ? (listed ? "listed" : "ok") : "full",
          domain: domainOf(target.value),
        });
        if (!added) {
          return {
            tone: "warn",
            text: "The Don't ask again list is full. Open Senderban and remove some entries.",
          };
        }
        manage?.notifyChanged();
        return { tone: "ok", text: `${target.value}: you will not be asked again.` };
      },
      onError: logIpcError,
      reopen: async (id, restore) => {
        const { pending, lanes, labels, own, gmailWatchers, outlookWatchers } = await ready.promise;
        const restored = restoreClicked(pending, lanes, id, restore);
        const seen = pending.peek(id);
        log("toast-reopen", { result: seen.status, restore: restored });
        if (seen.status === "duplicate") return { tone: "warn", text: "Already handled." };
        if (seen.status !== "ok") {
          return { tone: "warn", text: "This message has expired, so nothing changed." };
        }
        const { accountId, sender } = seen.block;
        return {
          id,
          accountId,
          issuedAt: restore?.issuedAt ?? Math.floor(Date.now() / 1000),
          sender,
          // The body's click keeps the subject (0.3.2); a button, or a toast from before, does not.
          subject: restore?.subject ?? SUBJECT_NOT_KEPT,
          account: labels.get(accountId) ?? accountId,
          spamScore: null,
          ...(gmailWatchers.toastOffer(accountId, sender) ??
            outlookWatchers.toastOffer(accountId, sender) ??
            imapOffer(accountId, sender, own.get())),
        };
      },
      choose: async (id, scope, action, restore) => {
        const { store, engine, lanes, pending, labels, own } = await ready.promise;
        const restored = restoreClicked(pending, lanes, id, restore);
        let clicked = null as string | null;
        let result: BlockResult;
        try {
          result = await blockPending(
            {
              pending,
              store,
              engine,
              own: own.get(),
              accountIds: lanes,
              // A Gmail filter takes single addresses and Trash only: a click from a Gmail toast is held to that.
              // Kept for the whole session: a toast of an account removed since is still held to it.
              trashOnlyAccount: (accountId) => gmailToastLanes.has(accountId),
              // The mailbox the click came from, as Accounts names it: shown on the list only.
              sourceOf: (accountId) => labels.get(accountId),
              onClaimed: (accountId) => {
                clicked = accountId;
                clicking.add(accountId);
              },
              // Before the round, not after it: a Gmail round that ends during the read-back is news, and no second one comes.
              onListed: () => {
                gmailSettled.clear();
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
        if (result.status === "not-applied") {
          unsynced.add(result.accountId);
          gmailSettled.delete(result.accountId);
        }
        // Written but not read back: the toast says so once, and the list keeps saying it until a round confirms.
        if (result.status === "blocked" && !result.verified) {
          unconfirmed.add(result.accountId);
          gmailSettled.delete(result.accountId);
        }
        log("choice", {
          scope,
          action,
          result: result.status,
          verified: result.status === "blocked" ? result.verified : undefined,
          restore: restored,
        });
        manage?.notifyChanged();
        // On a Gmail account every single-address entry is a Trash filter, whatever action the list holds for it.
        if (
          result.status === "already-blocked" &&
          clicked !== null &&
          gmailToastLanes.has(clicked)
        ) {
          return {
            tone: "warn",
            text: gmailAlreadyBlockedText(
              store.list(),
              result.target,
              (a) => isOwnMailbox(a, own.get()),
              clicking.size > 0 || !gmailSettled.has(clicked),
            ),
          };
        }
        const toast = describe(result, labels);
        if (result.status !== "blocked") return toast;
        // ADR 0009 point 6: the toast says where the choice was not applied (Gmail takes single addresses and Trash only).
        const gmailNote =
          (gmailLanes.size > 0
            ? gmailMissNote(store.list(), result.target, (a) => isOwnMailbox(a, own.get()))
            : "") + gmailSkippedNote(gmailSkipped);
        const microsoftNote =
          (microsoftLanes.size > 0
            ? microsoftWideNote(store.list(), result.target, own.get())
            : "") + microsoftSkippedNote(microsoftSkipped);
        const notes = gmailNote + microsoftNote;
        // A place the block did not reach is a warning, so "Confirm each block" off cannot hide it.
        return { tone: notes === "" ? toast.tone : "warn", text: toast.text + notes };
      },
    });
    // How many list entries reach the person's own mail, so none of them applies. Never throws: an account is stored by then.
    const ownEntryCount = async (): Promise<number> => {
      try {
        const { store, own } = await ready.promise;
        const current = own.get();
        return store.list().filter((entry) => isOwnEntry(entry, current)).length;
      } catch (error) {
        log("own-refresh-failed", { detail: errorText(error) });
        return 0;
      }
    };
    manage = new ManageWindow(assets, {
      // `gmailLanes` is the lanes that run this session: with none, a row says nothing about Gmail.
      list: () => {
        const own = runtime?.own.get();
        const isOwn = (a: string) => own !== undefined && isOwnMailbox(a, own);
        // Not an empty list: "Nothing is blocked yet" would be a claim about a store that never opened.
        if (startFailed) throw new Error("start failed");
        const entries = runtime?.store.list() ?? [];
        const view = laneViewOf({
          entries,
          running: runtime?.lanes ?? [],
          // A cleaning lane moves nothing while its watcher is away: its entries are not confirmed then, whatever the last round said.
          failed: [
            ...unsynced,
            ...unconfirmed,
            ...[...cleanLanes].filter((id) => states.get(id) !== "watching"),
          ],
          mxroute: mxrouteLanes,
          gmail: gmailLanes,
          settled: gmailSettled,
          skipped: gmailSkipped.length > 0,
          skippedAll: microsoftSkipped.length > 0,
          rules: microsoftLanes,
          refused: refusedAddresses,
        });
        return entries.map((entry) => {
          const gmail = gmailLanes.size > 0 ? gmailCover(entry, isOwn) : null;
          const isOwnSender = own !== undefined && isOwnEntry(entry, own);
          const outlook =
            microsoftLanes.size > 0 && own !== undefined ? outlookCover(entry, own) : null;
          return {
            ...entry,
            gmail,
            outlook,
            own: isOwnSender,
            ...appliedFor(entry, isOwnSender, gmail, view, outlook),
            local: cleanLanes.size > 0,
          };
        });
      },
      onError: logIpcError,
      openHelp: async (target) => {
        log("help-open", { target });
        guardHelpTarget(STORE, target);
        if (target !== "logs") {
          await shell.openExternal(HELP_LINKS[target]);
          return;
        }
        // openPath answers with an error text, empty when the folder opened; it does not throw.
        const failed = await shell.openPath(logDir);
        if (failed !== "") throw new Error("the log folder did not open");
      },
      mxrouteList: async () => {
        const page = await listMxroute(keysPath, accountsPath);
        if (page.keysUnreadable) log("mxroute-keys-failed", {});
        const stored = await loadAccounts(accountsPath);
        const clean = stored
          .filter(isCleanAccount)
          .map((a) => ({ accountId: a.id, label: a.clean.address }));
        // From the file, not the running set: start-up may not have got this far.
        const filters = new Map(
          stored.filter(isImapAccount).map((a) => [a.id, a.spamFilter ?? null]),
        );
        const accounts = page.accounts.map((a) => ({
          ...a,
          spamFilter: filters.get(a.accountId) ?? null,
        }));
        return { ...page, accounts, clean };
      },
      mxrouteSave: async (input) => {
        const onCall = (call: MxrouteCall) => {
          log("mxroute-call", { key: keyTag(input), ...call });
        };
        const result = await saveMxroute(keysPath, input, keyCheck(onCall));
        log("mxroute-saved", { key: keyTag(input), result });
        return result;
      },
      mxrouteRemove: async (ref, confirm) => {
        const result = await removeMxroute(keysPath, accountsPath, ref, confirm);
        log("mxroute-removed", { key: keyTag(ref), result });
        if (result === "saved") {
          await ready.promise.then(
            (current) => {
              current.retireMxrouteKey(ref);
            },
            () => undefined,
          );
          updateTray();
        }
        return result;
      },
      mxrouteEnable: async (input) => {
        const onCall = (call: MxrouteCall) => {
          log("mxroute-call", { key: keyTag(input), ...call });
        };
        const result = await setMxrouteEnabled(keysPath, accountsPath, input, domainCheck(onCall));
        log("mxroute-enabled", { key: keyTag(input), enabled: input.enabled, result });
        return result;
      },
      accountDetect: async (address, signal) => {
        const started = Date.now();
        let facts: DetectFacts = { records: 0, probes: 0, dnsError: null };
        const found = await detectMailProvider(domainOf(address), signal, (seen) => {
          facts = seen;
        });
        log("account-detect", { kind: found.kind, ms: Date.now() - started, ...facts });
        return found;
      },
      accountAdd: async (input, request) => {
        const started = Date.now();
        const stages: Partial<Record<AccountCheckStage["stage"], AccountCheckStage>> = {};
        const result = await addAccountFromForm(accountsPath, input, {
          confirm: request.confirm,
          check: (account, signal) =>
            checkAccount(account, undefined, {
              signal,
              onStage: (stage) => {
                stages[stage.stage] = stage;
              },
            }),
          signal: request.signal,
          // The never-refuse set must hold the new address now, not after the restart, and the list rows show what it changed.
          onSaved: async () => {
            const before = await ownEntryCount();
            await googleDeps.onAccountsChanged?.();
            manage?.notifyChanged();
            const stopped = (await ownEntryCount()) > before;
            // Entries over the new domain leave the rules now, not at the next change.
            if (stopped) runtime?.engine.requestSync();
            return stopped;
          },
        });
        // Account tag, outcome and times only: never the address, the server or the password.
        log("account-added", {
          account: accountTag(input.address),
          provider: input.provider,
          result,
          ms: Date.now() - started,
          reachMs: stages.reach?.ms,
          imapMs: stages.imap?.ms,
          sieveMs: stages.sieve?.ms,
          timedOut: Object.values(stages).find((stage) => stage.timedOut)?.stage,
        });
        return result;
      },
      cleanAdd: async (input, request) => {
        const started = Date.now();
        const result = await addCleanFromForm(accountsPath, input, {
          confirm: request.confirm,
          check: (account, signal) => checkCleanAccount(account, undefined, { signal }),
          signal: request.signal,
          onSaved: async () => {
            const before = await ownEntryCount();
            await googleDeps.onAccountsChanged?.();
            manage?.notifyChanged();
            const stopped = (await ownEntryCount()) > before;
            if (stopped) runtime?.engine.requestSync();
            return stopped;
          },
        });
        log("account-added", {
          account: accountTag(input.address),
          kind: "clean",
          result,
          ms: Date.now() - started,
        });
        return result;
      },
      accountRemove: async (accountId, request) => {
        const started = Date.now();
        const onRemoved = async (): Promise<void> => {
          spamFilters.delete(accountId);
          await googleDeps.onAccountsChanged?.();
          manage?.notifyChanged();
        };
        const known = await loadAccounts(accountsPath);
        const result = known.some((a) => a.id === accountId && isCleanAccount(a))
          ? await removeCleanAccount(accountsPath, accountId, {
              confirm: request.confirmClean,
              retire: async (id) => {
                (await ready.promise).retireClean(id);
              },
              onRemoved,
            })
          : await removeImapAccount(accountsPath, accountId, {
              ...request,
              rules: async () => (await ready.promise).sieve,
              onRemoved,
              blacklistOutlives: (account) => blacklistOutlives(keysPath, accountsPath, account),
            });
        log("account-removed", {
          account: accountTag(accountId),
          result,
          ms: Date.now() - started,
        });
        return result;
      },
      googleState: () => googleState(googleDeps),
      googleSaveClient: async (input) => {
        const started = Date.now();
        const reply = await saveGoogleClientSettings(googleDeps, input);
        log("google-client", { reply, ms: Date.now() - started });
        return reply;
      },
      googleSignIn: async (request) => {
        const started = Date.now();
        const outcome = await signInGoogle(googleDeps, request);
        // The outcome word and the time only: no address, no token.
        log("google-sign-in", {
          reply: outcome.reply,
          again: request.accountId !== undefined,
          ms: Date.now() - started,
        });
        return outcome;
      },
      googleCancel: () => {
        cancelGoogleSignIn();
        cancelMicrosoftSignIn();
      },
      status: async () => ({
        version: app.getVersion(),
        update: updates?.available ?? null,
        storeManaged: STORE.storeInstall,
        paused,
        behind: [
          ...[...new Set([...unsynced, ...unconfirmed])]
            .filter((id) => runtime?.lanes.includes(id))
            .map((id) => runtime?.labels.get(id) ?? id),
          ...gmailSkipped.map((s) => s.email),
          ...microsoftSkipped.map((s) => s.email),
        ],
        accounts: (await loadAccounts(accountsPath)).map((a) => {
          const lane = isGmailAccount(a)
            ? gmailLaneId(a.id)
            : isMicrosoftAccount(a)
              ? graphLaneId(a.id)
              : a.id;
          return {
            accountId: a.id,
            state: states.get(lane) ?? null,
            label: runtime?.labels.get(lane) ?? null,
          };
        }),
      }),
      pause: (value) => setPaused(value, "window"),
      quiet: () => quiet.rows,
      quietRemove: async (value) => {
        await quiet.remove(value);
        log("quiet-remove", { domain: domainOf(value) });
      },
      saveSpamFilter: async (accountId, filter) => {
        // Start-up fills the running set from the file it read: a save before that would be written over.
        await ready.promise.catch(() => undefined);
        const saved = await serialized(async () => {
          const accounts = await loadAccounts(accountsPath);
          if (!accounts.some((a) => a.id === accountId && isImapAccount(a))) return false;
          await saveAccounts(accountsPath, withSpamFilter(accounts, accountId, filter));
          return true;
        });
        if (!saved) return "unknown";
        if (filter === null) spamFilters.delete(accountId);
        else spamFilters.set(accountId, filter);
        log("spam-filter", { account: accountTag(accountId), ...(filter ?? { limit: null }) });
        runtime?.engine.requestSync(accountId);
        return "saved";
      },
      settings: () => settings.current,
      // Windows keeps the answer (HKCU Run, Electron app.setLoginItemSettings): nothing to keep in sync here. A Store package
      // starts at sign-in only through a manifest StartupTask, which it does not declare, so the switch is not offered there.
      // Turning it on writes the key enabled again (store-gates.ts reads it back).
      loginItem: () => readLoginItem(STORE, app),
      saveLoginItem: (on) => {
        const now = writeLoginItem(STORE, app, on);
        log("login-item", { on, now });
        if (now !== on) throw new Error("Windows did not take the change");
      },
      saveSettings: async (next) => {
        const wasChecking = settings.current.checkUpdates;
        await settings.save(next);
        log("settings", next);
        // Turned back on: ask after the first delay, not at the next daily tick.
        if (next.checkUpdates && !wasChecking) updates?.nudge();
      },
      noRestart: (reason) => {
        log("restart-skipped", { reason });
      },
      restart: (why) => {
        restartApp(
          {
            isQuitting: () => quitting,
            log: (event, fields) => {
              log(event, { ...fields });
            },
            releaseLock: () => {
              app.releaseSingleInstanceLock();
            },
            isOpen: () => manage?.isOpen() ?? false,
            relaunch: (reopen) => {
              app.relaunch({ args: relaunchArgs(process.argv, reopen) });
            },
            quit: () => {
              app.quit();
            },
          },
          why,
        );
      },
      microsoftState: () => microsoftState(microsoftDeps),
      microsoftSignIn: async (request) => {
        const started = Date.now();
        const reply = await signInMicrosoftAccount(microsoftDeps, request);
        // The outcome word and the time only: no address, no token.
        log("microsoft-sign-in", {
          reply,
          again: request.accountId !== undefined,
          ms: Date.now() - started,
        });
        return reply;
      },
      microsoftRemove: async (accountId) => {
        const reply = await removeMicrosoftAccount(microsoftDeps, accountId);
        log("microsoft-removed", { account: accountTag(accountId), reply });
        return reply;
      },
      googleRemove: async (accountId) => {
        const reply = await removeGoogleAccount(googleDeps, accountId);
        log("google-removed", { account: accountTag(accountId), reply });
        return reply;
      },
      unblock: async (id) => {
        const { store, engine, lanes, labels, accounts } = await ready.promise;
        const value = store.list().find((e) => e.id === id)?.value ?? "This sender";
        // Read before the Unblock: a lane that is gone cannot take the address off, and its mail goes on being refused.
        const stranded = strandedOnBlacklist(
          value,
          accounts.map((a) => a.id),
          lanes,
          (laneId) => store.getState(laneId),
        );
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
          gmailSettled.clear();
          for (const a of result.accounts) {
            if (a.confirmed) gmailSettled.add(a.accountId);
            else unsynced.add(a.accountId);
          }
        }
        log("unblock", {
          result: result.status,
          confirmed:
            result.status === "unblocked"
              ? result.accounts.filter((a) => a.confirmed).length
              : undefined,
          accounts: result.status === "unblocked" ? result.accounts.length : undefined,
        });
        const outcome = describeUnblock(value, result, labels);
        // A Gmail account with no lane keeps its filter: the person is told, or "unblocked" would read as done.
        if (result.status !== "unblocked") return outcome;
        const withGmail =
          outcome.text + gmailSkippedNote(gmailSkipped) + microsoftSkippedNote(microsoftSkipped);
        return stranded
          ? {
              tone: "warn",
              text: `${withGmail} It may still be on your MXroute blacklist, which refuses its mail: delete it in your MXroute panel.`,
            }
          : { ...outcome, text: withGmail };
      },
    });
    tray = new Tray(nativeImage.createFromPath(join(assets, "icon.ico")));
    tray.on("click", () => {
      manage?.show();
    });
    updateTray();
    start().then(ready.resolve, ready.reject);
    reopenAfterStart(process.argv, ready.promise, () => manage);
    void ready.promise.then((current) => {
      runtime = current;
      updateTray();
      manage?.notifyChanged();
    });
    ready.promise.catch((error: unknown) => {
      log("start-failed", { detail: errorText(error) });
      startFailed = true;
      manage?.notifyChanged();
      notice("Senderban could not start", "See the log for details.");
    });
  });
}
