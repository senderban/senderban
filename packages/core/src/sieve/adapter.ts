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
  insertInclude,
  isOurMain,
  normalizeNewlines,
  renderMain,
  renderRules,
  scriptBytes,
  scriptSha256,
  type RenderOptions,
} from "./rules.js";
import type { SieveSession } from "./session.js";

export const SIEVE_ADAPTER_ID = "sieve";

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

async function withSession<T>(
  connect: () => Promise<SieveSession>,
  fn: (session: SieveSession) => Promise<T>,
): Promise<T> {
  const session = await connect();
  try {
    return await fn(session);
  } finally {
    await session.close().catch(() => undefined);
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
  if (hasInclude(before, state.rulesName)) return null;

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

export class SieveAdapter implements BlockAdapter {
  readonly id = SIEVE_ADAPTER_ID;
  readonly #options: SieveAdapterOptions;
  readonly #render: RenderOptions;

  constructor(options: SieveAdapterOptions) {
    this.#options = options;
    this.#render = options.render ?? DEFAULT_RENDER_OPTIONS;
  }

  capabilities(): Capabilities {
    return CAPABILITIES;
  }

  plan(list: Blocklist, state: OpaqueState): Promise<Plan> {
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
      if (!have.has(key)) changes.push({ kind: "create", entry, match: entry.match });
    }
    return { accountId: this.#options.accountId, changes, basedOn: state };
  }

  /**
   * One atomic PUTSCRIPT of the whole rules script, so there is no window with a half-applied
   * list. Retrying after a failure is safe: an already-written script is recognised by its hash.
   */
  async apply(plan: Plan): Promise<ApplyResult> {
    const state = parseState(plan.basedOn);
    const removed = new Set(plan.changes.filter((c) => c.kind === "remove").map((c) => c.entry.id));
    const created = plan.changes.filter((c) => c.kind === "create").map((c) => c.entry);
    const applied = BlocklistSchema.parse([
      ...state.applied.filter((e) => !removed.has(e.id)),
      ...created,
    ]);
    const rules = renderRules(applied, this.#render);
    const sha = scriptSha256(rules);

    return withSession(this.#options.connect, async (session) => {
      requireExtensions(session);

      const remote = await session.getScript(state.rulesName);
      if (remote === null) {
        if (state.rulesSha256 !== null) {
          throw new AdapterError("REMOTE_CHANGED", "rules script was deleted on the server");
        }
      } else {
        const remoteSha = scriptSha256(remote);
        if (remoteSha !== sha && remoteSha !== state.rulesSha256) {
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
        includeBackup: backup ?? state.includeBackup,
      };
      return {
        applied: plan.changes.length,
        failed: [],
        state: { adapterId: SIEVE_ADAPTER_ID, data: next },
      };
    });
  }

  async verify(state: OpaqueState): Promise<Drift> {
    const current = parseState(state);
    return withSession(this.#options.connect, async (session) => {
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
    });
  }
}
