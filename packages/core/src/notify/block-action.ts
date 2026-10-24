import { randomUUID } from "node:crypto";
import type { Store } from "../store/store.js";
import type { SyncEngine, SyncOutcome } from "../sync/engine.js";
import { activationTag } from "./pending.js";
import type { PendingBlocks } from "./pending.js";

/** The only toast button we add is the first one. */
export const BLOCK_BUTTON_INDEX = 0;

/** The parts of Electron's `ActivationArguments` this logic reads. */
export interface Activation {
  readonly type: string;
  readonly actionIndex?: number | undefined;
  readonly arguments: string;
}

export interface BlockActionDeps {
  readonly pending: PendingBlocks;
  readonly store: Pick<Store, "add">;
  readonly engine: Pick<SyncEngine, "sync" | "requestSync">;
  /** Every account on this device: the list is global, so each one must pick the new entry up. */
  readonly accountIds: readonly string[];
  /** Shows a result toast. */
  readonly say: (title: string, body: string) => void;
  readonly now?: () => Date;
  readonly newId?: () => string;
}

function describeOutcome(outcome: SyncOutcome): string {
  switch (outcome.status) {
    case "unchanged":
      return "already in place";
    case "applied":
      return "rule written";
    case "partial":
      return `${String(outcome.failed)} change(s) failed`;
    case "failed":
      return `${outcome.code}: ${outcome.message}`;
  }
}

/** What a click led to; for the diagnostics log. */
export type ActivationResult =
  "ignored" | "duplicate" | "unknown" | "refused" | "blocked" | "not-applied";

/**
 * A click on [Block sender]: look the sender up by notification id, add it to the list, write the
 * rule to the clicked account at once (for the confirmation) and to the others through the debounce.
 * Windows delivers one click as two activations, so the id is consumed exactly once.
 */
export async function handleBlockActivation(
  deps: BlockActionDeps,
  activation: Activation,
): Promise<ActivationResult> {
  if (activation.type !== "action" || activation.actionIndex !== BLOCK_BUTTON_INDEX) {
    return "ignored";
  }
  const tag = activationTag(activation.arguments);
  if (tag === null) return "ignored";

  const claimed = deps.pending.consume(tag);
  if (claimed.status === "duplicate") return "duplicate";
  if (claimed.status === "unknown") {
    deps.say("Senderban", "This notification has expired, so the sender was not blocked.");
    return "unknown";
  }

  const { accountId, sender } = claimed.block;
  const added = deps.store.add({
    id: (deps.newId ?? randomUUID)(),
    match: "exactAddress",
    value: sender,
    action: "junk",
    createdAt: (deps.now?.() ?? new Date()).toISOString(),
  });
  if (!added.ok) {
    deps.say("Could not block", `${sender}: ${added.reason}`);
    return "refused";
  }

  const outcome = await deps.engine.sync(accountId);
  for (const id of deps.accountIds) if (id !== accountId) deps.engine.requestSync(id);

  if (outcome.status === "failed" || outcome.status === "partial") {
    deps.say("Block not applied", `${sender}: ${describeOutcome(outcome)}`);
    return "not-applied";
  }
  deps.say("Sender blocked", `${sender}: future mail goes to Junk (${describeOutcome(outcome)}).`);
  return "blocked";
}
