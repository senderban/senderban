import {
  QUIET_CHOICE,
  REOPEN_CHOICE,
  SPAM_LEVELS,
  buildMailToastXml,
  parseActivation,
} from "@senderban/core";
import type {
  ActivationRestore,
  ActivationSigner,
  BlockAction,
  BlockScope,
  MailToast,
  Settings,
  SpamLevel,
} from "@senderban/core";
import { Notification } from "electron";
import { release } from "node:os";
import { join, sep } from "node:path";
import { pathToFileURL } from "node:url";

// Scale budget: the watcher announces at most 5 messages per drain per account (DEFAULT_MAX_PER_DRAIN), so
// toasts are a burst, not a rate. Windows queues and stacks them. Here only the Notification objects whose
// click we still wait for, and the toasts behind them, are kept, at most MAX_TRACKED each, oldest dropped. No timers run in this module.
const MAX_TRACKED = 50;

/** What a finished block says to the person; shown as a second toast. */
export interface ToastResult {
  readonly tone: "ok" | "warn" | "error";
  readonly text: string;
}

export interface ToastHandlers {
  /** The person's choices, read at each toast and each click, so a change on the Settings page applies to the next one. */
  readonly settings: () => Settings;
  /** `spamStripUrls`: the coloured line of a toast that has a spam score. */
  readonly spamStrips: Readonly<Record<SpamLevel, string>>;
  /** Signs and checks the tail of each click; null when this machine keeps no key, so no toast carries a sender. One promise, read once. */
  readonly signer: () => Promise<ActivationSigner | null>;
  /** Runs the block and describes the outcome. */
  readonly choose: (
    id: string,
    scope: BlockScope,
    action: BlockAction,
    restore: ActivationRestore | undefined,
  ) => Promise<ToastResult>;
  /** Puts the sender or domain of that toast on the "Don't ask again" list. */
  readonly quiet: (
    id: string,
    scope: BlockScope,
    restore: ActivationRestore | undefined,
  ) => Promise<ToastResult>;
  /** A click on a toast's body: the toast to show again, or why there is none. */
  readonly reopen: (
    id: string,
    restore: ActivationRestore | undefined,
  ) => Promise<MailToast | ToastResult>;
  /** Windows delivered an activation (any click on a toast of ours): the log line that tells "not delivered" from "ignored". */
  readonly onActivation: () => void;
  /** A click was not one of our buttons or was malformed; `reason` is a fixed string, never the input. */
  readonly onIgnored: (reason: string) => void;
  /** Windows refused a toast: a mail was announced and never shown. A fixed log line, not Windows' text. */
  readonly onRefused: () => void;
  /** A handler threw: the log gets the channel and a sanitised message, the person a generic failure. */
  readonly onError: (channel: string, error: unknown) => void;
  /** Runs a click as a step of the window, so a restart after an add waits for it as it waits for the window's own steps. */
  readonly hold: <T>(work: () => Promise<T>) => Promise<T>;
}

/**
 * The strips of `assets/toast`. Windows draws them, not Electron, and Windows cannot read inside app.asar: an installed build keeps them
 * in app.asar.unpacked (`asarUnpack`, electron-builder.yml).
 */
export function spamStripUrls(assets: string): Readonly<Record<SpamLevel, string>> {
  const folder = join(assets, "toast").replace(`app.asar${sep}`, `app.asar.unpacked${sep}`);
  const url = (level: SpamLevel): string => pathToFileURL(join(folder, `spam-${level}.png`)).href;
  return Object.fromEntries(SPAM_LEVELS.map((level) => [level, url(level)])) as Record<
    SpamLevel,
    string
  >;
}

/** First Windows 11 build (21H2). Unit: Windows build number (`os.release()` is "10.0.<build>"). */
const WINDOWS_11_BUILD = 22000;
/** Red/green toast buttons (`hint-buttonStyle`) are a Windows 11 feature; an older Windows gets the plain button instead of a toast it may refuse. */
const BUTTON_STYLE = Number(release().split(".")[2] ?? 0) >= WINDOWS_11_BUILD;

function dropOldest(tracked: Map<string, unknown>): void {
  while (tracked.size > MAX_TRACKED) {
    const oldest = tracked.keys().next().value;
    if (oldest === undefined) break;
    tracked.delete(oldest);
  }
}

function optionalSigner(signer: ActivationSigner | null): { signer?: ActivationSigner } {
  return signer === null ? {} : { signer };
}

const MARK: Readonly<Record<ToastResult["tone"], string>> = { ok: "", warn: "! ", error: "✗ " };

/**
 * Native Windows toasts instead of our own popup window (ADR 0007): Windows stacks them with other apps'
 * toasts, honours Focus Assist, and keeps them in the Action Center. A click comes back as a string,
 * parsed and validated in core (`parseActivation`) before anything runs.
 */
export class Toasts {
  readonly #handlers: ToastHandlers;
  readonly #live = new Map<string, Notification>();
  readonly #busy = new Set<string>();
  /** What each toast said, so one shown again has its subject; a toast of an earlier run does not. */
  readonly #announced = new Map<string, MailToast>();
  /** Null until the key is read (a few milliseconds from start): a toast shown before that carries no sender, as one with no key does. */
  #signer: ActivationSigner | null = null;

  constructor(handlers: ToastHandlers) {
    this.#handlers = handlers;
    void handlers.signer().then((signer) => {
      this.#signer = signer;
    });
    // Never shown. Without a Notification object a click made while the app was closed starts the app but never reaches
    // handleActivation; with it the click arrives at once. A side effect of creating one, measured in the Store package on
    // Electron 45.2.1 (.task/store-msix.md), not something the docs promise: measure again on every Electron bump (ADR 0019).
    new Notification({ title: "Senderban" });
    Notification.handleActivation((details) => {
      this.#handlers.onActivation();
      void this.#activated(details);
    });
  }

  /** A mail announcement with buttons. `untilAnswered`: the person asked for it, so it stays whatever the Settings say. */
  show(toast: MailToast, untilAnswered = false): void {
    const notification = new Notification({
      toastXml: buildMailToastXml(toast, {
        ...this.#handlers.settings(),
        ...(untilAnswered ? { toastDuration: "until-closed" as const } : {}),
        buttonStyle: BUTTON_STYLE,
        spamStrips: this.#handlers.spamStrips,
        ...optionalSigner(this.#signer),
      }),
    });
    // Deleted first: `Map.set` keeps the place of a key it holds, and a toast shown again is the newest, not the first to be dropped.
    this.#live.delete(toast.id);
    this.#announced.delete(toast.id);
    this.#live.set(toast.id, notification);
    this.#announced.set(toast.id, toast);
    dropOldest(this.#live);
    dropOldest(this.#announced);
    notification.on("close", () => {
      if (this.#live.get(toast.id) === notification) this.#live.delete(toast.id);
    });
    notification.on("failed", () => {
      if (this.#live.get(toast.id) === notification) this.#live.delete(toast.id);
      this.#handlers.onRefused();
    });
    notification.show();
  }

  /** A state change the person should know about; no buttons. */
  notice(title: string, body: string): void {
    new Notification({ title, body }).show();
  }

  /** Removes the toasts that are still on screen; called at quit. */
  closeAll(): void {
    for (const notification of this.#live.values()) notification.close();
    this.#live.clear();
  }

  async #activated(details: unknown): Promise<void> {
    const signer = await this.#handlers.signer();
    const parsed = parseActivation(
      details,
      this.#handlers.settings().defaultAction,
      signer ?? undefined,
    );
    if (!parsed.ok) {
      this.#handlers.onIgnored(parsed.reason);
      return;
    }
    const { id, scope, action, restore } = parsed.activation;
    // Windows can deliver the same click twice (toast and Action Center); the pending id is single-use anyway.
    if (this.#busy.has(id)) return;
    this.#busy.add(id);
    if (action === REOPEN_CHOICE) {
      await this.#reopen(id, restore);
      return;
    }
    this.#live.delete(id);
    this.#announced.delete(id);
    let result: ToastResult;
    try {
      result = await this.#handlers.hold(() =>
        action === QUIET_CHOICE
          ? this.#handlers.quiet(id, scope, restore)
          : this.#handlers.choose(id, scope, action, restore),
      );
    } catch (error) {
      this.#handlers.onError("toast:choose", error);
      result = { tone: "error", text: "Something went wrong. See the log." };
    } finally {
      this.#busy.delete(id);
    }
    // A warning or a failure always shows: only a block that worked may stay quiet.
    if (result.tone !== "ok" || this.#handlers.settings().confirmBlocks) {
      this.notice("Senderban", `${MARK[result.tone]}${result.text}`);
    }
  }

  async #reopen(id: string, restore: ActivationRestore | undefined): Promise<void> {
    try {
      const answer = await this.#handlers.hold(() => this.#handlers.reopen(id, restore));
      if ("tone" in answer) {
        this.notice("Senderban", `${MARK[answer.tone]}${answer.text}`);
        return;
      }
      this.show(this.#announced.get(id) ?? answer, true);
    } catch (error) {
      this.#handlers.onError("toast:reopen", error);
      this.notice("Senderban", `${MARK.error}Something went wrong. See the log.`);
    } finally {
      this.#busy.delete(id);
    }
  }
}
