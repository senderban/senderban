import { buildMailToastXml, parseActivation } from "@senderban/core";
import type { BlockAction, BlockScope, MailToast } from "@senderban/core";
import { Notification } from "electron";

// Scale budget: the watcher announces at most 5 messages per drain per account (DEFAULT_MAX_PER_DRAIN), so
// toasts are a burst, not a rate. Windows queues and stacks them. Here only the Notification objects whose
// click we still wait for are kept, at most MAX_TRACKED, oldest dropped. No timers run in this module.
const MAX_TRACKED = 50;

/** What a finished block says to the person; shown as a second toast. */
export interface ToastResult {
  readonly tone: "ok" | "warn" | "error";
  readonly text: string;
}

export interface ToastHandlers {
  /** Runs the block and describes the outcome. */
  readonly choose: (id: string, scope: BlockScope, action: BlockAction) => Promise<ToastResult>;
  /** A click was not one of our buttons or was malformed; `reason` is a fixed string, never the input. */
  readonly onIgnored: (reason: string) => void;
  /** A handler threw: the log gets the channel and a sanitised message, the person a generic failure. */
  readonly onError: (channel: string, error: unknown) => void;
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

  constructor(handlers: ToastHandlers) {
    this.#handlers = handlers;
    Notification.handleActivation((details) => {
      void this.#activated(details);
    });
  }

  /** A mail announcement with buttons. */
  show(toast: MailToast): void {
    const notification = new Notification({ toastXml: buildMailToastXml(toast) });
    this.#live.set(toast.id, notification);
    while (this.#live.size > MAX_TRACKED) {
      const oldest = this.#live.keys().next().value;
      if (oldest === undefined) break;
      this.#live.delete(oldest);
    }
    notification.on("close", () => {
      if (this.#live.get(toast.id) === notification) this.#live.delete(toast.id);
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
    const parsed = parseActivation(details);
    if (!parsed.ok) {
      this.#handlers.onIgnored(parsed.reason);
      return;
    }
    const { id, scope, action } = parsed.activation;
    // Windows can deliver the same click twice (toast and Action Center); the pending id is single-use anyway.
    if (this.#busy.has(id)) return;
    this.#busy.add(id);
    this.#live.delete(id);
    let result: ToastResult;
    try {
      result = await this.#handlers.choose(id, scope, action);
    } catch (error) {
      this.#handlers.onError("toast:choose", error);
      result = { tone: "error", text: "Something went wrong. See the log." };
    } finally {
      this.#busy.delete(id);
    }
    this.notice("Senderban", `${MARK[result.tone]}${result.text}`);
  }
}
