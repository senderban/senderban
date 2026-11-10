import { TAIL_REFUSED } from "@senderban/core";
import type { IgnoredReason } from "@senderban/core";

/** One "expired" notice per this gap: Windows can deliver one click twice, and same-user code can call the activator (ADR 0019). */
export const EXPIRED_NOTICE_GAP_MS = 10_000;

export const EXPIRED_NOTICE = "This message has expired, so nothing was blocked.";

export interface IgnoredClickDeps {
  readonly log: (reason: IgnoredReason) => void;
  readonly notice: (body: string) => void;
  readonly now?: () => number;
}

/**
 * Handles a toast click that was not acted on. Every one is logged; a refused tail (a key made again after the toast was shown) also tells the
 * person, because the toast vanished on the click. The notice is throttled and never throws.
 */
export function ignoredClickHandler(deps: IgnoredClickDeps): (reason: IgnoredReason) => void {
  const now = deps.now ?? Date.now;
  let lastNoticeAt = Number.NEGATIVE_INFINITY;
  return (reason) => {
    deps.log(reason);
    if (reason !== TAIL_REFUSED) return;
    const at = now();
    if (at - lastNoticeAt < EXPIRED_NOTICE_GAP_MS) return;
    lastNoticeAt = at;
    try {
      deps.notice(EXPIRED_NOTICE);
    } catch {
      // A notice that cannot be shown changes nothing; the log line above already holds the event.
    }
  };
}
