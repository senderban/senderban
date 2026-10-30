import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  AdapterError,
  SIEVE_SUSPEND_WAIT_MS,
  SieveAdapter,
  SyncEngine,
  initialSieveState,
  mxrouteLaneId,
  sieveStateForReinstall,
  sieveStateHoldsRules,
} from "@senderban/core";
import type { AccountConfig, OpaqueState } from "@senderban/core";
import { Store, openDatabase } from "@senderban/core/store";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { FakeSieveServer } from "../../../packages/core/test/sieve/fake-server.js";
import type {
  AccountRemoveSteps,
  LiveAccounts,
  SieveLane,
  SieveRulesLifecycle,
} from "../src/remove-account.js";

vi.mock("electron", () => ({
  safeStorage: {
    isAsyncEncryptionAvailable: () => Promise.resolve(true),
  },
}));

const { SIEVE_UNINSTALL_MS, createSieveLifecycle, dropImapAccount, removeImapAccount } =
  await import("../src/remove-account.js");
const { loadAccounts, saveAccounts } = await import("../src/accounts-file.js");

const CIPHER = Buffer.from("opaque-cipher-bytes").toString("base64");
const ID = "you@example.com";

function imapAccount(user: string): AccountConfig {
  return {
    id: user,
    imap: { host: "mail.example.com", port: 993, secure: true, user },
    sieve: { host: "mail.example.com", port: 4190, user },
    passwordCipher: CIPHER,
  };
}

const held = (data: Record<string, unknown>): OpaqueState => {
  const empty = initialSieveState();
  return { ...empty, data: { ...(empty.data as object), ...data } };
};
const withRules = held({ rulesSha256: "a".repeat(64) });

let dir: string;
let path: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "senderban-account-remove-"));
  path = join(dir, "accounts.json");
  await saveAccounts(path, [imapAccount(ID), imapAccount("other@example.com")]);
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

function rules(answer: Awaited<ReturnType<SieveRulesLifecycle["prepare"]>>): {
  lifecycle: SieveRulesLifecycle;
  abort: ReturnType<typeof vi.fn>;
  done: ReturnType<typeof vi.fn>;
} {
  const abort = vi.fn();
  const done = vi.fn();
  return {
    lifecycle: { prepare: () => Promise.resolve(answer), abort, done },
    abort,
    done,
  };
}

const steps = (
  lifecycle: SieveRulesLifecycle,
  over: Partial<AccountRemoveSteps> = {},
): AccountRemoveSteps => ({
  confirm: () => Promise.resolve(true),
  confirmLeaveRules: () => Promise.resolve(false),
  rules: () => Promise.resolve(lifecycle),
  onRemoved: () => Promise.resolve(),
  blacklistOutlives: () => Promise.resolve(false),
  ...over,
});

const ids = async () => (await loadAccounts(path)).map((a) => a.id);

describe("removeImapAccount", () => {
  it("deletes the rules first, then the account, and refreshes once", async () => {
    const { lifecycle, done } = rules("ready");
    const prepare = vi.spyOn(lifecycle, "prepare").mockImplementation(async () => {
      expect(await ids()).toContain(ID);
      return "ready";
    });
    const onRemoved = vi.fn(() => Promise.resolve());
    expect(await removeImapAccount(path, ID, steps(lifecycle, { onRemoved }))).toBe("removed");
    expect(prepare).toHaveBeenCalledWith(ID);
    expect(done).toHaveBeenCalledWith(ID, false);
    expect(onRemoved).toHaveBeenCalledTimes(1);
    expect(await ids()).toEqual(["other@example.com"]);
  });

  it("changes nothing without the person's yes", async () => {
    const { lifecycle } = rules("ready");
    const prepare = vi.spyOn(lifecycle, "prepare");
    const confirm = () => Promise.resolve(false);
    expect(await removeImapAccount(path, ID, steps(lifecycle, { confirm }))).toBe("cancelled");
    expect(prepare).not.toHaveBeenCalled();
    expect(await ids()).toContain(ID);
  });

  it("does not know an id that is not an IMAP account", async () => {
    await saveAccounts(path, [{ id: "g", gmail: { email: "me@gmail.com" } }]);
    const { lifecycle } = rules("ready");
    const confirm = vi.fn(() => Promise.resolve(true));
    const reply = await removeImapAccount(path, "g", steps(lifecycle, { confirm }));
    expect(reply).toBe("unknown-account");
    expect(confirm).not.toHaveBeenCalled();
    expect(await ids()).toEqual(["g"]);
  });

  it("keeps the account and frees the lane when the rules stay and the person keeps it", async () => {
    const { lifecycle, abort, done } = rules("rules-left");
    expect(await removeImapAccount(path, ID, steps(lifecycle))).toBe("rules-left");
    expect(abort).toHaveBeenCalledWith(ID);
    expect(done).not.toHaveBeenCalled();
    expect(await ids()).toContain(ID);
  });

  it("removes the account when the person accepts the rules staying: a dead server holds nothing hostage", async () => {
    const { lifecycle, done } = rules("rules-left");
    const confirmLeaveRules = () => Promise.resolve(true);
    const reply = await removeImapAccount(path, ID, steps(lifecycle, { confirmLeaveRules }));
    expect(reply).toBe("removed-rules-remain");
    expect(done).toHaveBeenCalledWith(ID, true);
    expect(await ids()).not.toContain(ID);
  });

  it("asks the person when the server refuses the login: that may be a server's mood, and removal is final", async () => {
    const { lifecycle, abort } = rules("unreachable");
    expect(await removeImapAccount(path, ID, steps(lifecycle))).toBe("rules-left");
    expect(abort).toHaveBeenCalledWith(ID);
    expect(await ids()).toContain(ID);
    const confirmLeaveRules = () => Promise.resolve(true);
    const { lifecycle: again, done } = rules("unreachable");
    const reply = await removeImapAccount(path, ID, steps(again, { confirmLeaveRules }));
    expect(reply).toBe("removed-rules-remain");
    expect(done).toHaveBeenCalledWith(ID, true);
    expect(await ids()).not.toContain(ID);
  });

  it("changes nothing when a restart is needed first", async () => {
    const { lifecycle, abort } = rules("restart-first");
    expect(await removeImapAccount(path, ID, steps(lifecycle))).toBe("restart-first");
    expect(abort).toHaveBeenCalledWith(ID);
    expect(await ids()).toContain(ID);
  });

  it("says that the MXroute blacklist stays when no mailbox is left on it", async () => {
    const { lifecycle } = rules("ready");
    const outlives = vi.fn(() => Promise.resolve(true));
    const reply = await removeImapAccount(path, ID, {
      ...steps(lifecycle),
      blacklistOutlives: outlives,
    });
    expect(reply).toBe("removed-blacklist-remains");
    expect(outlives).toHaveBeenCalledWith(expect.objectContaining({ id: ID }));
  });

  it("warns when it cannot tell: the account is gone by then", async () => {
    const { lifecycle } = rules("ready");
    const reply = await removeImapAccount(path, ID, {
      ...steps(lifecycle),
      blacklistOutlives: () => Promise.reject(new Error("unreadable")),
    });
    expect(reply).toBe("removed-blacklist-remains");
    expect(await ids()).not.toContain(ID);
  });

  it("frees the lane when the rules step throws, and keeps the account", async () => {
    const { lifecycle, abort } = rules("ready");
    vi.spyOn(lifecycle, "prepare").mockRejectedValueOnce(new Error("boom"));
    await expect(removeImapAccount(path, ID, steps(lifecycle))).rejects.toThrow("boom");
    expect(abort).toHaveBeenCalledWith(ID);
    expect(await ids()).toContain(ID);
  });
});

describe("createSieveLifecycle", () => {
  const uninstall = vi.fn<SieveLane["uninstall"]>();
  const resume = vi.fn<SieveLane["resume"]>();
  const retire = vi.fn<SieveLane["retire"]>();
  beforeEach(() => {
    vi.clearAllMocks();
    uninstall.mockResolvedValue(initialSieveState());
  });
  const lane = (over: Partial<SieveLane> = {}): SieveLane => ({
    suspend: () => Promise.resolve(true),
    resume,
    retire,
    uninstall,
    ...over,
  });
  const make = (
    lanes: [string, SieveLane][],
    state?: OpaqueState,
    skipped: readonly string[] = [],
  ) => {
    const log = vi.fn();
    const onResumed = vi.fn();
    const onDone = vi.fn();
    const onHold = vi.fn();
    const setState = vi.fn();
    const attemptDone = vi.fn(() => Promise.resolve());
    return {
      lifecycle: createSieveLifecycle({
        lanes: new Map(lanes),
        skipped: new Set(skipped),
        store: { getState: () => state, setState },
        attemptDone,
        log,
        onHold,
        onResumed,
        onDone,
      }),
      log,
      onResumed,
      onDone,
      onHold,
      setState,
      attemptDone,
    };
  };

  it("holds the lane, waits for the engine, then takes the rules out and keeps the new state", async () => {
    const order: string[] = [];
    const after = initialSieveState();
    const adapter = lane({
      suspend: () => {
        order.push("suspend");
        return Promise.resolve(true);
      },
      uninstall: () => {
        order.push("uninstall");
        return Promise.resolve(after);
      },
    });
    const { lifecycle, setState, attemptDone, onHold } = make([[ID, adapter]], withRules);
    attemptDone.mockImplementation(() => {
      order.push("settled");
      return Promise.resolve();
    });
    expect(await lifecycle.prepare(ID)).toBe("ready");
    expect(order).toEqual(["suspend", "settled", "uninstall"]);
    expect(setState).toHaveBeenCalledWith(ID, after);
    expect(onHold).toHaveBeenCalledWith(ID, true);
  });

  it("uninstalls even when the state says nothing is there: a lost state must not leave rules behind", async () => {
    const { lifecycle } = make([[ID, lane()]], initialSieveState());
    expect(await lifecycle.prepare(ID)).toBe("ready");
    expect(uninstall).toHaveBeenCalledTimes(1);
    const none = make([[ID, lane()]]);
    expect(await none.lifecycle.prepare(ID)).toBe("ready");
    expect(uninstall).toHaveBeenCalledTimes(2);
  });

  it("gives the uninstall a total deadline: a removal holds every other account change", async () => {
    const timeout = vi.spyOn(AbortSignal, "timeout");
    const { lifecycle } = make([[ID, lane()]], withRules);
    await lifecycle.prepare(ID);
    expect(timeout).toHaveBeenCalledWith(SIEVE_UNINSTALL_MS);
    expect(uninstall.mock.calls[0]?.[1]).toBe(timeout.mock.results[0]?.value);
    timeout.mockRestore();
  });

  it("calls a running round that will not end rules left, and never uninstalls beside it", async () => {
    const adapter = lane({ suspend: () => Promise.resolve(false) });
    const { lifecycle } = make([[ID, adapter]], withRules);
    expect(await lifecycle.prepare(ID)).toBe("rules-left");
    expect(uninstall).not.toHaveBeenCalled();
  });

  it("keeps a server failure a retryable rules-left, and logs a fixed code only", async () => {
    const secret = "server said something with you@example.com";
    uninstall.mockRejectedValueOnce(new AdapterError("TRANSIENT", secret));
    const { lifecycle, log } = make([[ID, lane()]], withRules);
    expect(await lifecycle.prepare(ID)).toBe("rules-left");
    expect(JSON.stringify(log.mock.calls)).not.toContain(secret);
    expect(JSON.stringify(log.mock.calls)).toContain("TRANSIENT");
  });

  it("marks a failed uninstall for a full rewrite: half of it may have happened", async () => {
    uninstall.mockRejectedValueOnce(new AdapterError("TRANSIENT", "lost"));
    const state = held({ rulesSha256: "a".repeat(64), applied: [] });
    const { lifecycle, setState } = make([[ID, lane()]], state);
    await lifecycle.prepare(ID);
    expect(setState).toHaveBeenLastCalledWith(ID, sieveStateForReinstall(state));
    expect(sieveStateHoldsRules(sieveStateForReinstall(state))).toBe(true);
  });

  it("writes the mark before the uninstall starts: a crash during it must not look clean", async () => {
    const order: string[] = [];
    const { lifecycle, setState } = make([[ID, lane()]], withRules);
    setState.mockImplementation(() => {
      order.push("state");
    });
    uninstall.mockImplementationOnce(() => {
      order.push("uninstall");
      return Promise.resolve(initialSieveState());
    });
    await lifecycle.prepare(ID);
    expect(order).toEqual(["state", "uninstall", "state"]);
  });

  it("gives up with rules left when the engine does not settle in time, without uninstalling", async () => {
    vi.useFakeTimers();
    try {
      const { lifecycle, attemptDone, log } = make([[ID, lane()]], withRules);
      attemptDone.mockImplementation(() => new Promise<void>(() => undefined));
      const reply = lifecycle.prepare(ID);
      await vi.advanceTimersByTimeAsync(SIEVE_SUSPEND_WAIT_MS);
      expect(await reply).toBe("rules-left");
      expect(uninstall).not.toHaveBeenCalled();
      expect(JSON.stringify(log.mock.calls)).toContain("BUSY");
    } finally {
      vi.useRealTimers();
    }
  });

  it("marks a kept row, so a re-add does not read a deleted script as someone else's edit", () => {
    const { lifecycle, setState } = make([[ID, lane()]], withRules);
    lifecycle.done(ID, true);
    expect(setState).toHaveBeenCalledWith(ID, sieveStateForReinstall(withRules));
    const clean = make([[ID, lane()]], withRules);
    clean.lifecycle.done(ID, false);
    expect(clean.setState).not.toHaveBeenCalled();
  });

  it("calls a refused login unreachable", async () => {
    uninstall.mockRejectedValueOnce(new AdapterError("AUTH_REQUIRED", "refused"));
    const { lifecycle } = make([[ID, lane()]], withRules);
    expect(await lifecycle.prepare(ID)).toBe("unreachable");
  });

  it("wants a restart for rules with no lane this session, and is ready without either", async () => {
    expect(await make([], withRules).lifecycle.prepare(ID)).toBe("restart-first");
    expect(await make([], initialSieveState()).lifecycle.prepare(ID)).toBe("ready");
    expect(await make([]).lifecycle.prepare(ID)).toBe("ready");
  });

  it("never reads or touches what is stored under a skipped account's id: it is another lane's", async () => {
    const other: OpaqueState = { adapterId: "mxroute", data: {} };
    const { lifecycle, onDone } = make([], other, [ID]);
    expect(await lifecycle.prepare(ID)).toBe("ready");
    lifecycle.done(ID, false);
    expect(onDone).not.toHaveBeenCalled();
  });

  it("frees the lane and lets it catch up on abort", () => {
    const { lifecycle, onResumed, onHold } = make([[ID, lane()]]);
    lifecycle.abort(ID);
    expect(resume).toHaveBeenCalledTimes(1);
    expect(onHold).toHaveBeenCalledWith(ID, false);
    expect(onResumed).toHaveBeenCalledWith(ID);
  });

  it("retires the lane when the removal finished", () => {
    const { lifecycle, onDone, onHold } = make([[ID, lane()]]);
    lifecycle.done(ID, true);
    expect(retire).toHaveBeenCalledTimes(1);
    expect(onHold).toHaveBeenCalledWith(ID, false);
    expect(onDone).toHaveBeenCalledWith(ID, true);
  });
});

describe("the removal against a real engine", () => {
  it("takes out the rules of a first round that is still running", async () => {
    const server = new FakeSieveServer();
    let release: () => void = () => undefined;
    const closing = new Promise<void>((resolve) => {
      release = resolve;
    });
    let held = false;
    let opened: () => void = () => undefined;
    const roundOpen = new Promise<void>((resolve) => {
      opened = resolve;
    });
    const adapter = new SieveAdapter({
      accountId: ID,
      connect: () => {
        const session = server.session();
        if (held) return Promise.resolve(session);
        held = true;
        opened();
        return Promise.resolve({
          ...session,
          extensions: () => session.extensions(),
          listScripts: () => session.listScripts(),
          getScript: (name: string) => session.getScript(name),
          haveSpace: (name: string, size: number) => session.haveSpace(name, size),
          putScript: (name: string, text: string) => session.putScript(name, text),
          setActive: (name: string) => session.setActive(name),
          deleteScript: (name: string) => session.deleteScript(name),
          destroy: () => {
            session.destroy();
          },
          // The round has written everything; the engine has not saved its state yet.
          close: () => closing.then(() => session.close()),
        });
      },
    });
    const store = new Store(openDatabase(":memory:"));
    const engine = new SyncEngine(store);
    engine.addAccount({ id: ID, initialState: initialSieveState(), adapter });
    store.add({
      id: crypto.randomUUID(),
      match: "exactAddress",
      value: "a@example.com",
      action: "junk",
      createdAt: new Date().toISOString(),
    });
    const round = engine.sync(ID);
    await roundOpen;
    const lifecycle = createSieveLifecycle({
      lanes: new Map([[ID, adapter]]),
      skipped: new Set(),
      store,
      attemptDone: (id) => engine.attemptDone(id),
      log: vi.fn(),
      onHold: vi.fn(),
      onResumed: vi.fn(),
      onDone: vi.fn(),
    });
    const prepared = lifecycle.prepare(ID);
    await vi.waitFor(() => {
      expect(server.scripts.size).toBeGreaterThan(0);
    });
    release();
    await round;
    expect(await prepared).toBe("ready");
    expect(server.scripts.size).toBe(0);
    expect(server.active).toBeNull();
    engine.dispose();
  });
});

describe("a failed uninstall against a real engine", () => {
  const entry = () => ({
    id: crypto.randomUUID(),
    match: "exactAddress",
    value: "a@example.com",
    action: "junk",
    createdAt: new Date().toISOString(),
  });

  function setup() {
    const server = new FakeSieveServer();
    let down = false;
    const adapter = new SieveAdapter({
      accountId: ID,
      connect: () =>
        down
          ? Promise.reject(new AdapterError("TRANSIENT", "down"))
          : Promise.resolve(server.session()),
    });
    const store = new Store(openDatabase(":memory:"));
    const engine = new SyncEngine(store);
    engine.addAccount({ id: ID, initialState: initialSieveState(), adapter });
    const lifecycle = createSieveLifecycle({
      lanes: new Map([[ID, adapter]]),
      skipped: new Set(),
      store,
      attemptDone: (id) => engine.attemptDone(id),
      log: vi.fn(),
      onHold: vi.fn(),
      onResumed: vi.fn(),
      onDone: vi.fn(),
    });
    return {
      server,
      store,
      engine,
      lifecycle,
      setDown: (value: boolean) => {
        down = value;
      },
    };
  }

  it("takes the rule off the server when the last entry is unblocked afterwards", async () => {
    const { server, store, engine, lifecycle, setDown } = setup();
    const added = store.add(entry());
    if (!added.ok) throw new Error("not added");
    await engine.sync(ID);
    const rules = () => [...server.scripts.values()].join("\n");
    expect(rules()).toContain("a@example.com");
    setDown(true);
    expect(await lifecycle.prepare(ID)).toBe("rules-left");
    lifecycle.abort(ID);
    setDown(false);
    store.remove(added.entry.id);
    const outcome = await engine.sync(ID);
    expect(outcome.status).toBe("applied");
    expect(rules()).not.toContain("a@example.com");
    engine.dispose();
  });

  it("rebuilds rules the person deleted by hand instead of stopping for good", async () => {
    const { server, store, engine, lifecycle, setDown } = setup();
    store.add(entry());
    await engine.sync(ID);
    setDown(true);
    await lifecycle.prepare(ID);
    lifecycle.abort(ID);
    setDown(false);
    server.scripts.clear();
    server.active = null;
    const outcome = await engine.sync(ID);
    expect(outcome.status).toBe("applied");
    expect([...server.scripts.values()].join("\n")).toContain("a@example.com");
    engine.dispose();
  });
});

describe("dropImapAccount", () => {
  const LANE = mxrouteLaneId(ID);
  const live = () => {
    const stop = vi.fn(() => Promise.resolve());
    const retireLane = vi.fn();
    const forgetAccount = vi.fn();
    const forgetCursor = vi.fn();
    const state: LiveAccounts = {
      lanes: [ID, LANE, "sibling@example.com"],
      labels: new Map([
        [ID, ID],
        [LANE, `${ID} (MXroute)`],
      ]),
      mxrouteLanes: new Set([LANE]),
      mxrouteAdapters: new Map([[LANE, { retire: retireLane }]]),
      rejectingAccounts: new Set([ID, "sibling@example.com", "elsewhere@example.org"]),
      blacklistGroup: () => [ID, "sibling@example.com"],
      pending: { dropAccount: vi.fn() },
      store: { forgetAccount, forgetCursor },
      settled: () => Promise.resolve(),
      sieveLanes: new Map([[ID, {}]]),
      watchers: new Map([[ID, { stop }]]),
      states: new Map([[ID, "watching"]]),
    };
    return { state, stop, retireLane, forgetAccount, forgetCursor };
  };

  it("stops the lane's key and the promise of a refusal for every mailbox that shared it", async () => {
    const { state, stop, retireLane, forgetAccount } = live();
    dropImapAccount(ID, false, state);
    await Promise.resolve();
    await Promise.resolve();
    expect(state.sieveLanes.size).toBe(0);
    expect(retireLane).toHaveBeenCalledTimes(1);
    expect([...state.rejectingAccounts]).toEqual(["elsewhere@example.org"]);
    expect(state.lanes).toEqual(["sibling@example.com"]);
    expect(state.labels.size).toBe(0);
    expect(state.mxrouteLanes.size).toBe(0);
    expect(stop).toHaveBeenCalledTimes(1);
    expect(state.watchers.size).toBe(0);
    expect(state.states.size).toBe(0);
    expect(forgetAccount).toHaveBeenCalledWith(ID);
    expect(forgetAccount).toHaveBeenCalledWith(LANE);
  });

  it("forgets the lane's row only after its last round: a round in flight would write it back", async () => {
    const { state, forgetAccount } = live();
    let finish: () => void = () => undefined;
    const settled = new Promise<void>((resolve) => {
      finish = resolve;
    });
    dropImapAccount(ID, false, { ...state, settled: () => settled });
    await Promise.resolve();
    expect(forgetAccount).not.toHaveBeenCalledWith(LANE);
    finish();
    await settled;
    await Promise.resolve();
    expect(forgetAccount).toHaveBeenCalledWith(LANE);
  });

  it("keeps the state when rules stay on the server: it is the only record of them", () => {
    const { state, forgetAccount, forgetCursor } = live();
    dropImapAccount(ID, true, state);
    expect(forgetAccount).not.toHaveBeenCalledWith(ID);
    expect(forgetCursor).toHaveBeenCalledWith(ID);
  });

  it("leaves another account's lane alone when this one owned none", () => {
    const { state, retireLane, forgetAccount } = live();
    state.mxrouteLanes.clear();
    dropImapAccount(ID, false, state);
    expect(retireLane).not.toHaveBeenCalled();
    expect(state.rejectingAccounts.has("sibling@example.com")).toBe(true);
    expect(forgetAccount).not.toHaveBeenCalledWith(LANE);
  });
});
