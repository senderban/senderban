import { describe, expect, it } from "vitest";
import { AdapterError, type OpaqueState } from "../../src/adapter.js";
import type { BlockEntry, Blocklist } from "../../src/blocklist.js";
import {
  SieveAdapter,
  initialSieveState,
  sieveStateForReinstall,
  sieveStateHoldsRules,
} from "../../src/sieve/adapter.js";
import { hasInclude, isOurMain } from "../../src/sieve/rules.js";
import { FakeSieveServer } from "./fake-server.js";

const entry = (n: number, match: BlockEntry["match"], value: string): BlockEntry => ({
  id: `0b5f5f58-8f2c-4b9e-9a45-2f0a5c6d9d${String(n).padStart(2, "0")}`,
  match,
  value,
  action: "junk",
  createdAt: "2026-10-24T12:00:00.000Z",
});

function setup() {
  const server = new FakeSieveServer();
  const adapter = new SieveAdapter({
    accountId: "acct-1",
    connect: () => Promise.resolve(server.session()),
  });
  return { server, adapter };
}

async function sync(adapter: SieveAdapter, list: Blocklist, state: OpaqueState) {
  const plan = await adapter.plan(list, state);
  const result = await adapter.apply(plan);
  return { plan, result };
}

const failure = async (p: Promise<unknown>) => {
  try {
    await p;
  } catch (e) {
    return e instanceof AdapterError ? e.code : e;
  }
  return "no error";
};

describe("SieveAdapter on a clean mailbox", () => {
  it("creates rules + main, activates main, and verifies clean", async () => {
    const { server, adapter } = setup();
    const { plan, result } = await sync(
      adapter,
      [entry(1, "exactAddress", "a@example.com")],
      initialSieveState(),
    );

    expect(plan.changes.map((c) => c.kind)).toEqual(["create"]);
    expect(result.applied).toBe(1);
    expect([...server.scripts.keys()].sort()).toEqual(["senderban-main", "senderban-rules"]);
    expect(server.active).toBe("senderban-main");
    expect(server.puts[0]).toBe("senderban-rules"); // include target first
    expect(isOurMain(server.scripts.get("senderban-main") ?? "")).toBe(true);
    const proof = await adapter.verify(result.state);
    expect(proof.drifted).toBe(false);
    expect(proof.checks.map((c) => [c.name, c.ok])).toEqual([
      ["rules-present", true],
      ["rules-unchanged", true],
      ["include-active", true],
    ]);
    expect(Number.isNaN(Date.parse(proof.checkedAt))).toBe(false);
    expect(server.closed).toBeGreaterThan(0);
  });

  it("replaces the rules script on update and leaves main alone", async () => {
    const { server, adapter } = setup();
    const e1 = entry(1, "exactAddress", "a@example.com");
    const e2 = entry(2, "subdomains", "bulk.example");
    const first = await sync(adapter, [e1], initialSieveState());
    server.puts.length = 0;

    const second = await sync(adapter, [e1, e2], first.result.state);
    expect(second.plan.changes.map((c) => c.kind)).toEqual(["create"]);
    expect(server.puts).toEqual(["senderban-rules"]);
    expect(server.scripts.get("senderban-rules")).toContain('"*.bulk.example"');

    const third = await sync(adapter, [e2], second.result.state);
    expect(third.plan.changes.map((c) => c.kind)).toEqual(["remove"]);
    expect(server.scripts.get("senderban-rules")).not.toContain("a@example.com");
    expect((await adapter.verify(third.result.state)).drifted).toBe(false);
  });

  it("plans nothing when the list matches the applied state", async () => {
    const { adapter } = setup();
    const e1 = entry(1, "exactAddress", "a@example.com");
    const first = await sync(adapter, [e1], initialSieveState());
    const again = await adapter.plan([e1], first.result.state);
    expect(again.changes).toEqual([]);
  });

  it("treats an edited entry (same id, new value) as remove + create", async () => {
    const { adapter } = setup();
    const first = await sync(
      adapter,
      [entry(1, "exactAddress", "a@example.com")],
      initialSieveState(),
    );
    const edited = await sync(
      adapter,
      [entry(1, "exactAddress", "b@example.com")],
      first.result.state,
    );
    expect(edited.plan.changes.map((c) => c.kind).sort()).toEqual(["create", "remove"]);
    expect(edited.result.state.data).toMatchObject({ applied: [{ value: "b@example.com" }] });
  });

  it("refuses to overwrite a script of ours-by-name that is not ours", async () => {
    const { server, adapter } = setup();
    server.scripts.set("senderban-main", "keep;\n");
    expect(await failure(sync(adapter, [], initialSieveState()))).toBe("REMOTE_CHANGED");
    expect(server.scripts.get("senderban-main")).toBe("keep;\n");
  });
});

describe("SieveAdapter next to the user's own active script", () => {
  const userScript =
    'require ["fileinto"];\nif header :contains "subject" "invoice" {\n  fileinto "Bills";\n}\n';

  it("adds one include line, keeps the user's script active, and records a backup", async () => {
    const { server, adapter } = setup();
    server.scripts.set("roundcube", userScript);
    server.active = "roundcube";

    const { result } = await sync(
      adapter,
      [entry(1, "exactAddress", "a@example.com")],
      initialSieveState(),
    );
    const edited = server.scripts.get("roundcube") ?? "";
    expect(server.active).toBe("roundcube");
    expect(server.scripts.has("senderban-main")).toBe(false);
    expect(hasInclude(edited, "senderban-rules")).toBe(true);
    expect(edited).toContain('fileinto "Bills";');
    expect(result.state.data).toMatchObject({
      includeBackup: { scriptName: "roundcube", content: userScript },
    });
    expect((await adapter.verify(result.state)).drifted).toBe(false);
  });

  it("does not touch the user's script again once the include is there", async () => {
    const { server, adapter } = setup();
    server.scripts.set("roundcube", userScript);
    server.active = "roundcube";
    const first = await sync(
      adapter,
      [entry(1, "exactAddress", "a@example.com")],
      initialSieveState(),
    );
    const afterFirst = server.scripts.get("roundcube");
    server.puts.length = 0;

    await sync(
      adapter,
      [entry(1, "exactAddress", "a@example.com"), entry(2, "exactDomain", "x.example")],
      first.result.state,
    );
    expect(server.puts).toEqual(["senderban-rules"]);
    expect(server.scripts.get("roundcube")).toBe(afterFirst);
  });

  it("aborts with REMOTE_CHANGED if the user's script changes mid-edit, writing nothing to it", async () => {
    const { server, adapter } = setup();
    server.scripts.set("roundcube", userScript);
    server.active = "roundcube";
    server.beforeGet = (name, nth) => {
      if (name === "roundcube" && nth === 2)
        server.scripts.set("roundcube", `${userScript}# edited\n`);
    };
    expect(await failure(sync(adapter, [], initialSieveState()))).toBe("REMOTE_CHANGED");
    expect(server.scripts.get("roundcube")).toBe(`${userScript}# edited\n`);
  });

  it("refuses a script it cannot parse instead of guessing", async () => {
    const { server, adapter } = setup();
    server.scripts.set("roundcube", 'require "fileinto"\nkeep;');
    server.active = "roundcube";
    expect(await failure(sync(adapter, [], initialSieveState()))).toBe("REJECTED");
    expect(server.scripts.get("roundcube")).toBe('require "fileinto"\nkeep;');
  });

  it("detects a server that strips the include line (SOGo-style)", async () => {
    const { server, adapter } = setup();
    server.scripts.set("roundcube", userScript);
    server.active = "roundcube";
    const first = await sync(adapter, [], initialSieveState());
    server.scripts.set("roundcube", userScript);
    const drift = await adapter.verify(first.result.state);
    expect(drift).toMatchObject({
      drifted: true,
      detail: 'active script "roundcube" does not include the rules',
    });
  });
});

describe("SieveAdapter failure handling", () => {
  it("reports REMOTE_CHANGED when the rules script was edited on the server", async () => {
    const { server, adapter } = setup();
    const first = await sync(
      adapter,
      [entry(1, "exactAddress", "a@example.com")],
      initialSieveState(),
    );
    server.scripts.set("senderban-rules", "keep;\n");
    expect((await adapter.verify(first.result.state)).detail).toContain("rules script edited");
    expect(await failure(sync(adapter, [], first.result.state))).toBe("REMOTE_CHANGED");
    expect(server.scripts.get("senderban-rules")).toBe("keep;\n");
  });

  it("adopts our own empty rules script when no state was recorded", async () => {
    const { server, adapter } = setup();
    await sync(adapter, [], initialSieveState());
    const lost = initialSieveState(); // state row gone, script still on the server
    const { result } = await sync(adapter, [entry(1, "exactAddress", "a@example.com")], lost);
    expect(result.applied).toBe(1);
    expect(server.scripts.get("senderban-rules")).toContain("a@example.com");
    expect((await adapter.verify(result.state)).drifted).toBe(false);
  });

  it.each([
    ["different content", "keep;\n"],
    [
      "our empty script plus a comment",
      'require ["fileinto", "mailbox", "envelope"];\n# senderban-managed v1\n# hi\n',
    ],
    [
      "our empty script with a trailing space",
      'require ["fileinto", "mailbox", "envelope"]; \n# senderban-managed v1\n',
    ],
  ])("still refuses an unrecorded rules script with %s", async (_name, remote) => {
    const { server, adapter } = setup();
    server.scripts.set("senderban-rules", remote);
    const list = [entry(1, "exactAddress", "a@example.com")];
    expect(await failure(sync(adapter, list, initialSieveState()))).toBe("REMOTE_CHANGED");
    expect(server.scripts.get("senderban-rules")).toBe(remote);
  });

  it("does not adopt an empty script once a state is recorded (it counts as edited)", async () => {
    const { server, adapter } = setup();
    const first = await sync(
      adapter,
      [entry(1, "exactAddress", "a@example.com")],
      initialSieveState(),
    );
    const emptied = 'require ["fileinto", "mailbox", "envelope"];\n# senderban-managed v1\n';
    server.scripts.set("senderban-rules", emptied);
    const other = [entry(2, "exactAddress", "b@example.com")];
    expect(await failure(sync(adapter, other, first.result.state))).toBe("REMOTE_CHANGED");
    expect(server.scripts.get("senderban-rules")).toBe(emptied);
  });

  it("reports REMOTE_CHANGED when the rules script was deleted", async () => {
    const { server, adapter } = setup();
    const first = await sync(adapter, [], initialSieveState());
    server.scripts.delete("senderban-rules");
    expect((await adapter.verify(first.result.state)).detail).toContain("rules script missing");
    expect(await failure(sync(adapter, [], first.result.state))).toBe("REMOTE_CHANGED");
  });

  it("repairs a deleted include on the next apply", async () => {
    const { server, adapter } = setup();
    const first = await sync(adapter, [], initialSieveState());
    server.scripts.set("senderban-main", "# senderban-managed\nkeep;\n");
    expect((await adapter.verify(first.result.state)).drifted).toBe(true);
    await sync(adapter, [], first.result.state);
    expect((await adapter.verify(first.result.state)).drifted).toBe(false);
  });

  it("recovers from a failure after the first rules write (retry is idempotent)", async () => {
    const { server, adapter } = setup();
    const start = initialSieveState();
    const list = [entry(1, "exactAddress", "a@example.com")];
    server.failSetActiveOnce = true;
    expect(await failure(sync(adapter, list, start))).toBe("TRANSIENT");
    expect(server.active).toBeNull();

    const retry = await sync(adapter, list, start);
    expect(server.active).toBe("senderban-main");
    expect((await adapter.verify(retry.result.state)).drifted).toBe(false);
  });

  it("fails with QUOTA_EXCEEDED and writes nothing when the script would not fit", async () => {
    const { server, adapter } = setup();
    server.maxScriptBytes = 10;
    expect(
      await failure(
        sync(adapter, [entry(1, "exactAddress", "a@example.com")], initialSieveState()),
      ),
    ).toBe("QUOTA_EXCEEDED");
    expect(server.scripts.size).toBe(0);
  });

  it("fails with CAPABILITY_NOT_SUPPORTED when include is missing", async () => {
    const { server, adapter } = setup();
    server.extensions.delete("include");
    expect(await failure(sync(adapter, [], initialSieveState()))).toBe("CAPABILITY_NOT_SUPPORTED");
    expect(server.scripts.size).toBe(0);
  });

  it("rejects state that is not ours or malformed", async () => {
    const { adapter } = setup();
    expect(await failure(adapter.plan([], { adapterId: "gmail", data: {} }))).toBe("REJECTED");
    expect(await failure(adapter.plan([], { adapterId: "sieve", data: { rulesName: "x" } }))).toBe(
      "REJECTED",
    );
  });
});

describe("SieveAdapter.suspend", () => {
  const blocked = [entry(1, "exactAddress", "a@example.com")];

  it("refuses to plan or apply while suspended, as a failure and never as nothing to do", async () => {
    const { adapter } = setup();
    expect(await adapter.suspend()).toBe(true);
    expect(await failure(adapter.plan(blocked, initialSieveState()))).toBe("TRANSIENT");
    adapter.resume();
    const plan = await adapter.plan(blocked, initialSieveState());
    await adapter.suspend();
    expect(await failure(adapter.apply(plan))).toBe("TRANSIENT");
    adapter.resume();
    expect((await adapter.apply(plan)).state).toBeDefined();
  });

  it("waits for a running round, then answers true", async () => {
    const { server, adapter } = setup();
    const plan = await adapter.plan(blocked, initialSieveState());
    const round = adapter.apply(plan);
    expect(await adapter.suspend()).toBe(true);
    await round;
    expect(server.scripts.size).toBeGreaterThan(0);
  });

  it("answers false when a round outlives the wait", async () => {
    const connect = () => new Promise<never>(() => undefined);
    const adapter = new SieveAdapter({ accountId: "main", connect });
    const plan = await adapter.plan(blocked, initialSieveState());
    void adapter.apply(plan);
    expect(await adapter.suspend(1)).toBe(false);
  });

  it("does not confirm anything once retired: no round wrote it", async () => {
    const { adapter } = setup();
    const { result } = await sync(
      adapter,
      [entry(1, "exactAddress", "a@example.com")],
      initialSieveState(),
    );
    adapter.retire();
    expect(await failure(adapter.verify(result.state))).toBe("TRANSIENT");
  });

  it("has nothing to do once retired, for the rest of the session", async () => {
    const { adapter } = setup();
    adapter.retire();
    const plan = await adapter.plan(blocked, initialSieveState());
    expect(plan.changes).toEqual([]);
    await expect(adapter.apply(plan)).rejects.toThrow();
  });
});

describe("sieveStateForReinstall", () => {
  const one = entry(1, "exactAddress", "a@example.com");

  it("removes an entry that left the list, never an empty plan while rules may be there", async () => {
    const { server, adapter } = setup();
    const { result } = await sync(adapter, [one], initialSieveState());
    const { plan } = await sync(adapter, [], sieveStateForReinstall(result.state));
    expect(plan.changes.map((c) => c.kind)).toEqual(["remove"]);
    expect([...server.scripts.values()].join("\n")).not.toContain("a@example.com");
  });

  it("writes an entry twice over without doubling it, and ends the rewrite", async () => {
    const { adapter } = setup();
    const { result } = await sync(adapter, [one], initialSieveState());
    const again = await sync(adapter, [one], sieveStateForReinstall(result.state));
    expect(again.plan.changes.map((c) => c.kind)).toEqual(["create"]);
    expect((again.result.state.data as { applied: unknown[] }).applied).toHaveLength(1);
    expect((await adapter.plan([one], again.result.state)).changes).toEqual([]);
  });

  it("accepts a missing script while rewriting, and only then", async () => {
    const { server, adapter } = setup();
    const { result } = await sync(adapter, [one], initialSieveState());
    server.scripts.clear();
    server.active = null;
    const two = [one, entry(2, "exactAddress", "b@example.com")];
    expect(await failure(sync(adapter, two, result.state))).toBe("REMOTE_CHANGED");
    await sync(adapter, two, sieveStateForReinstall(result.state));
    expect([...server.scripts.values()].join("\n")).toContain("b@example.com");
  });

  it("reads an old state row, which has no flag", async () => {
    const { adapter } = setup();
    const { data } = initialSieveState();
    const old = { ...(data as Record<string, unknown>) };
    delete old.rewrite;
    const plan = await adapter.plan([one], { adapterId: "sieve", data: old });
    expect(plan.changes).toHaveLength(1);
  });
});

describe("SieveAdapter and a script it cannot read", () => {
  const unreadable = 'require ["fileinto"];\nif true { fileinto "Open;\n';
  const blocked = [entry(1, "exactAddress", "a@example.com")];

  it("does not delete the rules under an include nobody could see", async () => {
    const { server, adapter } = setup();
    const { result } = await sync(adapter, blocked, initialSieveState());
    server.scripts.set("mine", unreadable);
    server.active = "mine";
    expect(await failure(adapter.uninstall(result.state))).toBe("REJECTED");
    expect(server.scripts.has("senderban-rules")).toBe(true);
    expect(server.scripts.get("mine")).toBe(unreadable);
  });

  it("never edits it to add the include", async () => {
    const { server, adapter } = setup();
    server.scripts.set("mine", unreadable);
    server.active = "mine";
    expect(await failure(sync(adapter, blocked, initialSieveState()))).toBe("REJECTED");
    expect(server.scripts.get("mine")).toBe(unreadable);
  });

  it("takes the include out of a script with a vacation text, which it can read", async () => {
    const { server, adapter } = setup();
    server.scripts.set("mine", 'require ["vacation"];\nvacation text:\nHe said "back\n.\n;\n');
    server.active = "mine";
    const { result } = await sync(adapter, blocked, initialSieveState());
    expect(hasInclude(server.scripts.get("mine") ?? "", "senderban-rules")).toBe(true);
    await adapter.uninstall(result.state);
    expect(hasInclude(server.scripts.get("mine") ?? "", "senderban-rules")).toBe(false);
    expect(server.scripts.has("senderban-rules")).toBe(false);
  });

  it("does not delete a rules script the person edited, as `apply` would not overwrite it", async () => {
    const { server, adapter } = setup();
    const { result } = await sync(adapter, blocked, initialSieveState());
    const edited = `${server.scripts.get("senderban-rules") ?? ""}\n# mine\n`;
    server.scripts.set("senderban-rules", edited);
    expect(await failure(adapter.uninstall(result.state))).toBe("REMOTE_CHANGED");
    expect(server.scripts.get("senderban-rules")).toBe(edited);
  });

  it("stops an uninstall when the signal ends", async () => {
    const { adapter } = setup();
    const { result } = await sync(adapter, blocked, initialSieveState());
    const abort = new AbortController();
    abort.abort(new Error("out of time"));
    await expect(adapter.uninstall(result.state, abort.signal)).rejects.toThrow("out of time");
  });
});

describe("SieveAdapter.uninstall and a script of that name", () => {
  it("leaves a rules script that is not ours, and changes nothing", async () => {
    const { server, adapter } = setup();
    server.scripts.set("senderban-rules", 'require ["fileinto"];\nfileinto "Theirs";\n');
    expect(await failure(adapter.uninstall(initialSieveState()))).toBe("REMOTE_CHANGED");
    expect(server.scripts.has("senderban-rules")).toBe(true);
  });
});

describe("sieveStateHoldsRules", () => {
  it("says no for a new state and yes after a round", async () => {
    const { adapter } = setup();
    expect(sieveStateHoldsRules(initialSieveState())).toBe(false);
    const { result } = await sync(
      adapter,
      [entry(1, "exactAddress", "a@example.com")],
      initialSieveState(),
    );
    expect(sieveStateHoldsRules(result.state)).toBe(true);
  });
});

describe("SieveAdapter.uninstall", () => {
  const userScript =
    'require ["fileinto"];\nif header :contains "subject" "x" {\n  fileinto "X";\n}\n';

  it("removes our scripts from a clean mailbox and resets the state", async () => {
    const { server, adapter } = setup();
    const { result } = await sync(
      adapter,
      [entry(1, "exactAddress", "a@example.com")],
      initialSieveState(),
    );
    const next = await adapter.uninstall(result.state);
    expect(server.scripts.size).toBe(0);
    expect(server.active).toBeNull();
    expect(next.data).toMatchObject({ applied: [], rulesSha256: null, includeBackup: null });
    // and it can be installed again from the returned state
    await sync(adapter, [entry(1, "exactAddress", "a@example.com")], next);
    expect(server.active).toBe("senderban-main");
  });

  it("gives the user's script back byte for byte when nobody edited it since", async () => {
    const { server, adapter } = setup();
    server.scripts.set("roundcube", userScript);
    server.active = "roundcube";
    const { result } = await sync(
      adapter,
      [entry(1, "exactAddress", "a@example.com")],
      initialSieveState(),
    );
    await adapter.uninstall(result.state);
    expect(server.scripts.get("roundcube")).toBe(userScript);
    expect(server.active).toBe("roundcube");
    expect([...server.scripts.keys()]).toEqual(["roundcube"]);
  });

  it("keeps the user's later edits and drops only our two lines", async () => {
    const { server, adapter } = setup();
    server.scripts.set("roundcube", userScript);
    server.active = "roundcube";
    const { result } = await sync(adapter, [], initialSieveState());
    server.scripts.set(
      "roundcube",
      `${server.scripts.get("roundcube") ?? ""}# added later\nkeep;\n`,
    );
    await adapter.uninstall(result.state);
    const after = server.scripts.get("roundcube") ?? "";
    expect(hasInclude(after, "senderban-rules")).toBe(false);
    expect(after).toContain("# added later");
    expect(after).not.toContain("senderban-managed");
    expect(server.scripts.has("senderban-rules")).toBe(false);
  });

  it("refuses to delete a main script that is not ours", async () => {
    const { server, adapter } = setup();
    const { result } = await sync(adapter, [], initialSieveState());
    server.scripts.set("senderban-main", "keep;\n");
    expect(await failure(adapter.uninstall(result.state))).toBe("REMOTE_CHANGED");
    expect(server.scripts.has("senderban-rules")).toBe(true);
  });
});
