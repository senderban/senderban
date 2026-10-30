import { z } from "zod";
import {
  AdapterError,
  type ApplyResult,
  type BlockAdapter,
  type Capabilities,
  type Drift,
  type DriftCheck,
  type OpaqueState,
  type Plan,
  type PlannedChange,
} from "../adapter.js";
import { BlocklistSchema, checkEntry, type BlockEntry, type Blocklist } from "../blocklist.js";
import {
  DEFAULT_RENDER_OPTIONS,
  SCRIPT_NAME,
  assertScriptName,
  hasInclude,
  includeState,
  insertInclude,
  isOurMain,
  isOurRules,
  normalizeNewlines,
  removeInclude,
  renderMain,
  renderRules,
  scriptBytes,
  scriptSha256,
  type RenderOptions,
} from "./rules.js";
import type { SieveSession } from "./session.js";

export const SIEVE_ADAPTER_ID = "sieve";
/**
 * Longest `suspend` waits for a running round. Unit: milliseconds. A round ends by the engine's 60 s deadline (DEFAULT_TIMEOUT_MS);
 * 15 s more are for the answer to be handled. Past it the removal answers "rules left" instead of waiting for ever.
 */
export const SIEVE_SUSPEND_WAIT_MS = 75_000;

/** Extensions our scripts use: `fileinto`+`mailbox`+`envelope` for the rule, `include` for the hook. */
const REQUIRED_EXTENSIONS = ["fileinto", "mailbox", "envelope", "include"] as const;

// PROVISIONAL bound (bytes): size of the pre-edit copy of the user's script kept in local state.
// Replace with the measured server script limit once the Dovecot contract run (S4) has it.
const MAX_BACKUP_BYTES = 1_048_576;

const Sha256 = z.string().regex(/^[0-9a-f]{64}$/);

const StateSchema = z.strictObject({
  rulesName: z.string().regex(SCRIPT_NAME),
  mainName: z.string().regex(SCRIPT_NAME),
  /** What the remote rules script contains, as of our last successful write. */
  applied: BlocklistSchema,
  rulesSha256: Sha256.nullable(),
  /**
   * What is on the server is in doubt (an `uninstall` began and did not finish): the next round writes every wanted entry,
   * removes the others, and a missing script is no longer a sign of someone else's edit.
   */
  rewrite: z.boolean().default(false),
  /** Copy of the user's active script from before we added the include line. */
  includeBackup: z
    .strictObject({
      scriptName: z.string().min(1).max(255),
      sha256: Sha256,
      content: z.string().max(MAX_BACKUP_BYTES),
    })
    .nullable(),
});
export type SieveState = z.infer<typeof StateSchema>;

export function initialSieveState(
  rulesName = "senderban-rules",
  mainName = "senderban-main",
): OpaqueState {
  assertScriptName(rulesName);
  assertScriptName(mainName);
  const data: SieveState = {
    rulesName,
    mainName,
    applied: [],
    rulesSha256: null,
    rewrite: false,
    includeBackup: null,
  };
  return { adapterId: SIEVE_ADAPTER_ID, data };
}

function parseState(state: OpaqueState): SieveState {
  if (state.adapterId !== SIEVE_ADAPTER_ID) {
    throw new AdapterError("REJECTED", "state belongs to another adapter");
  }
  const parsed = StateSchema.safeParse(state.data);
  if (!parsed.success) throw new AdapterError("REJECTED", "sieve state failed validation");
  return parsed.data;
}

export interface SieveAdapterOptions {
  readonly accountId: string;
  /** Opens an authenticated ManageSieve session; called once per plan-free operation. */
  readonly connect: () => Promise<SieveSession>;
  readonly render?: RenderOptions;
}

const CAPABILITIES: Capabilities = {
  serverBlock: true,
  retroClean: false,
  watch: false,
  unsubscribe: false,
  quota: true,
  exactAddress: true,
  exactDomain: true,
  subdomains: true,
};

const entryKey = (e: BlockEntry): string => JSON.stringify([e.id, e.match, e.value, e.action]);

/** The session, but every command refuses to start once `signal` has aborted (red-team KC-2). */
function cancellable(session: SieveSession, signal: AbortSignal): SieveSession {
  const guard =
    <A extends unknown[], R>(call: (...args: A) => Promise<R>) =>
    async (...args: A): Promise<R> => {
      signal.throwIfAborted();
      return call(...args);
    };
  return {
    extensions: () => session.extensions(),
    listScripts: guard(() => session.listScripts()),
    getScript: guard((name) => session.getScript(name)),
    haveSpace: guard((name, size) => session.haveSpace(name, size)),
    putScript: guard((name, content) => session.putScript(name, content)),
    setActive: guard((name) => session.setActive(name)),
    deleteScript: guard((name) => session.deleteScript(name)),
    close: () => session.close(),
    destroy: () => {
      session.destroy();
    },
  };
}

/**
 * When `signal` aborts the connection is dropped at once and no further command is sent, so a round the
 * engine gave up on cannot write after a newer round has. A `connect` still pending at that moment
 * finishes on its own bounded steps; its session is dropped the moment it arrives.
 */
async function withSession<T>(
  connect: () => Promise<SieveSession>,
  fn: (session: SieveSession) => Promise<T>,
  signal?: AbortSignal,
): Promise<T> {
  signal?.throwIfAborted();
  const session = await connect();
  if (signal?.aborted === true) {
    session.destroy();
    signal.throwIfAborted();
  }
  const onAbort = (): void => {
    session.destroy();
  };
  signal?.addEventListener("abort", onAbort, { once: true });
  try {
    return await fn(signal === undefined ? session : cancellable(session, signal));
  } finally {
    signal?.removeEventListener("abort", onAbort);
    if (signal?.aborted !== true) await session.close().catch(() => undefined);
  }
}

function requireExtensions(session: SieveSession): void {
  const missing = REQUIRED_EXTENSIONS.filter((name) => !session.extensions().has(name));
  if (missing.length > 0) {
    throw new AdapterError(
      "CAPABILITY_NOT_SUPPORTED",
      `server lacks Sieve extensions: ${missing.join(", ")}`,
    );
  }
}

/**
 * Makes sure the user's active script runs our rules script and returns a backup of their script
 * when it had to be edited. Idempotent: calling it again changes nothing.
 */
async function ensureInclude(
  session: SieveSession,
  state: SieveState,
): Promise<SieveState["includeBackup"]> {
  const scripts = await session.listScripts();
  const active = scripts.find((s) => s.active);

  if (active === undefined || active.name === state.mainName) {
    // Ours: either nothing is active (we activate our own script) or our script already is.
    const current = await session.getScript(state.mainName);
    if (current !== null && !isOurMain(current)) {
      throw new AdapterError("REMOTE_CHANGED", `script "${state.mainName}" exists and is not ours`);
    }
    const wanted = renderMain(state.rulesName);
    if (current === null || !hasInclude(current, state.rulesName)) {
      await session.putScript(state.mainName, wanted);
    }
    if (active === undefined) await session.setActive(state.mainName);
    return null;
  }

  // The user's own active script: add one include line, never activate anything else.
  const before = await session.getScript(active.name);
  if (before === null) throw new AdapterError("REMOTE_CHANGED", "active script disappeared");
  const present = includeState(before, state.rulesName);
  if (present === "yes") return null;
  if (present === "unreadable") {
    throw new AdapterError("REJECTED", "active script could not be read, so it was not edited");
  }

  if (scriptBytes(before) > MAX_BACKUP_BYTES) {
    throw new AdapterError("REJECTED", "active script too large to back up before editing");
  }
  const edited = insertInclude(before, state.rulesName);
  const recheck = await session.getScript(active.name);
  if (recheck === null || scriptSha256(recheck) !== scriptSha256(before)) {
    throw new AdapterError("REMOTE_CHANGED", "active script changed while we were reading it");
  }
  if (!(await session.haveSpace(active.name, scriptBytes(edited)))) {
    throw new AdapterError("QUOTA_EXCEEDED", "no room for the include line");
  }
  await session.putScript(active.name, edited);

  const after = await session.getScript(active.name);
  if (after === null || !hasInclude(after, state.rulesName)) {
    throw new AdapterError("REJECTED", "server did not keep the include line");
  }
  return {
    scriptName: active.name,
    sha256: scriptSha256(before),
    content: normalizeNewlines(before),
  };
}

/** True while this state says rules of ours are on the server; a false answer needs no connection to take them out. */
export function sieveStateHoldsRules(state: OpaqueState): boolean {
  const current = parseState(state);
  return current.applied.length > 0 || current.rulesSha256 !== null;
}

/**
 * The state to hold while an `uninstall` runs, and after one that did not finish: the next plan writes every entry and takes out
 * the ones no longer wanted, so nothing rests on a script that may be half gone. `applied` stays: an Unblock must still produce
 * a removal. The hash stays too: it still proves a script found on the server is ours.
 */
export function sieveStateForReinstall(state: OpaqueState): OpaqueState {
  return { adapterId: SIEVE_ADAPTER_ID, data: { ...parseState(state), rewrite: true } };
}

export class SieveAdapter implements BlockAdapter {
  readonly id = SIEVE_ADAPTER_ID;
  readonly #options: SieveAdapterOptions;
  readonly #render: RenderOptions;
  /** Set while the account's rules are being taken out: no round starts (see `suspend`). */
  #suspended = false;
  /** The account is gone for good: rounds have nothing to do for the rest of the session. */
  #retired = false;
  #active = 0;
  #idle: (() => void)[] = [];

  constructor(options: SieveAdapterOptions) {
    this.#options = options;
    this.#render = options.render ?? DEFAULT_RENDER_OPTIONS;
  }

  capabilities(): Capabilities {
    return CAPABILITIES;
  }

  /**
   * Stops writing, as `GmailAdapter.suspend` does: a running round finishes (each command has its own deadline), a new one
   * does not start. While suspended `plan` and `apply` answer TRANSIENT, never "nothing to do": the engine must not read the
   * pause as a clean round. Resolves true when no round is running, false when one still runs after `timeoutMs`.
   */
  suspend(timeoutMs: number = SIEVE_SUSPEND_WAIT_MS): Promise<boolean> {
    this.#suspended = true;
    if (this.#active === 0) return Promise.resolve(true);
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        resolve(false);
      }, timeoutMs);
      this.#idle.push(() => {
        clearTimeout(timer);
        resolve(true);
      });
    });
  }

  resume(): void {
    this.#suspended = false;
  }

  /** The account was removed: the lane stays in the engine, which cannot drop one, with nothing to do this session. */
  retire(): void {
    this.#retired = true;
  }

  plan(list: Blocklist, state: OpaqueState): Promise<Plan> {
    if (this.#retired) {
      return Promise.resolve({ accountId: this.#options.accountId, changes: [], basedOn: state });
    }
    if (this.#suspended) {
      return Promise.reject(new AdapterError("TRANSIENT", "Sieve rules are being removed"));
    }
    try {
      return Promise.resolve(this.#plan(list, state));
    } catch (error) {
      return Promise.reject(error instanceof Error ? error : new Error(String(error)));
    }
  }

  #plan(list: Blocklist, state: OpaqueState): Plan {
    const current = parseState(state);
    const wanted = new Map<string, BlockEntry>();
    for (const raw of list) {
      const checked = checkEntry(raw);
      if (!checked.ok) {
        throw new AdapterError("REJECTED", `entry ${raw.id} refused: ${checked.reason}`);
      }
      wanted.set(entryKey(checked.entry), checked.entry);
    }
    const have = new Map(current.applied.map((e) => [entryKey(e), e]));

    const changes: PlannedChange[] = [];
    for (const [key, entry] of have) {
      if (!wanted.has(key)) changes.push({ kind: "remove", entry, match: entry.match });
    }
    for (const [key, entry] of wanted) {
      if (current.rewrite || !have.has(key)) {
        changes.push({ kind: "create", entry, match: entry.match });
      }
    }
    return { accountId: this.#options.accountId, changes, basedOn: state };
  }

  /**
   * One atomic PUTSCRIPT of the whole rules script, so there is no window with a half-applied
   * list. Retrying after a failure is safe: an already-written script is recognised by its hash.
   */
  async apply(plan: Plan, signal?: AbortSignal): Promise<ApplyResult> {
    if (this.#suspended || this.#retired) {
      throw new AdapterError("TRANSIENT", "Sieve rules are being removed");
    }
    this.#active += 1;
    try {
      return await this.#applyPlan(plan, signal);
    } finally {
      this.#active -= 1;
      if (this.#active === 0) for (const wake of this.#idle.splice(0)) wake();
    }
  }

  async #applyPlan(plan: Plan, signal?: AbortSignal): Promise<ApplyResult> {
    const state = parseState(plan.basedOn);
    const removed = new Set(plan.changes.filter((c) => c.kind === "remove").map((c) => c.entry.id));
    const created = plan.changes.filter((c) => c.kind === "create").map((c) => c.entry);
    // Under `rewrite` a created entry can already be in `applied`.
    const fresh = new Set(created.map((e) => e.id));
    const applied = BlocklistSchema.parse([
      ...state.applied.filter((e) => !removed.has(e.id) && !fresh.has(e.id)),
      ...created,
    ]);
    const rules = renderRules(applied, this.#render);
    const sha = scriptSha256(rules);

    return withSession(
      this.#options.connect,
      async (session) => {
        requireExtensions(session);

        const remote = await session.getScript(state.rulesName);
        if (remote === null) {
          if (state.rulesSha256 !== null && !state.rewrite) {
            throw new AdapterError("REMOTE_CHANGED", "rules script was deleted on the server");
          }
        } else {
          const remoteSha = scriptSha256(remote);
          // No recorded state (lost DB, first run after a crash) is not an edit: a script that is
          // byte-for-byte our empty rule set holds nothing of anyone's, so adopting it loses nothing.
          const isOurEmpty =
            state.rulesSha256 === null && remoteSha === scriptSha256(renderRules([], this.#render));
          if (remoteSha !== sha && remoteSha !== state.rulesSha256 && !isOurEmpty) {
            throw new AdapterError("REMOTE_CHANGED", "rules script was edited on the server");
          }
        }
        const needsWrite = remote === null || scriptSha256(remote) !== sha;
        if (needsWrite && !(await session.haveSpace(state.rulesName, scriptBytes(rules)))) {
          throw new AdapterError("QUOTA_EXCEEDED", "server has no room for the rules script");
        }

        // The include target must exist before anything points at it (servers compile includes).
        if (remote === null) await session.putScript(state.rulesName, rules);
        const backup = await ensureInclude(session, state);
        if (remote !== null && needsWrite) await session.putScript(state.rulesName, rules);

        const next: SieveState = {
          ...state,
          applied,
          rulesSha256: sha,
          rewrite: false,
          includeBackup: backup ?? state.includeBackup,
        };
        return {
          applied: plan.changes.length,
          failed: [],
          state: { adapterId: SIEVE_ADAPTER_ID, data: next },
        };
      },
      signal,
    );
  }

  /**
   * Takes the include out first, then deletes the rules script, so no moment exists where the
   * user's script points at something that is gone. The user's own script gets back its original
   * text; our own main script is deactivated and deleted.
   */
  async uninstall(state: OpaqueState, signal?: AbortSignal): Promise<OpaqueState> {
    const current = parseState(state);
    const uninstall = async (session: SieveSession): Promise<OpaqueState> => {
      const scripts = await session.listScripts();
      const active = scripts.find((s) => s.active);
      // Before anything changes: a script of that name without our marker is someone else's, and gets no copy here.
      if (scripts.some((s) => s.name === current.rulesName)) {
        const rules = await session.getScript(current.rulesName);
        // The hash, as `apply` does it: a rule the person added to our script is theirs and has no other copy.
        const edited =
          rules !== null &&
          current.rulesSha256 !== null &&
          scriptSha256(rules) !== current.rulesSha256;
        if (rules !== null && (edited || !isOurRules(rules))) {
          throw new AdapterError("REMOTE_CHANGED", `script "${current.rulesName}" is not ours`);
        }
      }

      if (active?.name === current.mainName) {
        const text = await session.getScript(current.mainName);
        if (text === null || !isOurMain(text)) {
          throw new AdapterError("REMOTE_CHANGED", `script "${current.mainName}" is not ours`);
        }
        await session.setActive("");
        await session.deleteScript(current.mainName);
      } else if (active !== undefined) {
        const text = await session.getScript(active.name);
        const included = text === null ? "no" : includeState(text, current.rulesName);
        // Deleting the rules script under an include nobody could see would break every delivery to this mailbox.
        if (included === "unreadable") {
          throw new AdapterError("REJECTED", "active script could not be read");
        }
        if (text !== null && included === "yes") {
          const original =
            current.includeBackup?.scriptName === active.name
              ? current.includeBackup.content
              : null;
          await session.putScript(active.name, removeInclude(text, current.rulesName, original));
          const after = await session.getScript(active.name);
          if (after === null || hasInclude(after, current.rulesName)) {
            throw new AdapterError("REJECTED", "server did not keep the include removal");
          }
        }
      } else if (scripts.some((s) => s.name === current.mainName)) {
        const text = await session.getScript(current.mainName);
        if (text !== null && isOurMain(text)) await session.deleteScript(current.mainName);
      }

      if (scripts.some((s) => s.name === current.rulesName)) {
        await session.deleteScript(current.rulesName);
      }
      const next: SieveState = {
        ...current,
        applied: [],
        rulesSha256: null,
        rewrite: false,
        includeBackup: null,
      };
      return { adapterId: SIEVE_ADAPTER_ID, data: next };
    };
    return withSession(this.#options.connect, uninstall, signal);
  }

  async verify(state: OpaqueState, signal?: AbortSignal): Promise<Drift> {
    // No round runs for a retired lane, so a clean read here would confirm a change nothing wrote.
    if (this.#retired) throw new AdapterError("TRANSIENT", "the account was removed");
    const current = parseState(state);
    return withSession(
      this.#options.connect,
      async (session) => {
        const checks: DriftCheck[] = [];
        const check = (name: string, ok: boolean, detail: string): void => {
          checks.push({ name, ok, detail });
        };

        const remote = await session.getScript(current.rulesName);
        check("rules-present", remote !== null, remote === null ? "rules script missing" : "found");
        if (remote !== null) {
          const same = scriptSha256(remote) === current.rulesSha256;
          check("rules-unchanged", same, same ? "matches what we wrote" : "rules script edited");
        }

        const active = (await session.listScripts()).find((s) => s.active);
        if (active === undefined) {
          check("include-active", false, "no active script");
        } else {
          const text = await session.getScript(active.name);
          const included = text !== null && hasInclude(text, current.rulesName);
          check(
            "include-active",
            included,
            included
              ? `active script "${active.name}" includes the rules`
              : `active script "${active.name}" does not include the rules`,
          );
        }

        const failed = checks.filter((c) => !c.ok);
        return {
          drifted: failed.length > 0,
          detail:
            failed.length === 0
              ? "rules and include in place"
              : failed.map((c) => c.detail).join("; "),
          checkedAt: new Date().toISOString(),
          checks,
        };
      },
      signal,
    );
  }
}
