import { afterAll, describe, expect, it } from "vitest";
import type { BlockEntry } from "../src/blocklist.js";
import { SieveAdapter, initialSieveState } from "../src/sieve/adapter.js";
import { connectManageSieve } from "../src/sieve/managesieve.js";

// Writes two scripts to a REAL mailbox and removes them again. Skipped unless the environment names
// a host; never put credentials in the repository. Needs an account with no Sieve scripts.
//   SENDERBAN_LIVE_SIEVE_HOST, SENDERBAN_LIVE_SIEVE_USER, SENDERBAN_LIVE_SIEVE_PASSWORD,
//   SENDERBAN_LIVE_SIEVE_SENDER (an address that is safe to block for the test)
const host = process.env["SENDERBAN_LIVE_SIEVE_HOST"];
const user = process.env["SENDERBAN_LIVE_SIEVE_USER"] ?? "";
const password = process.env["SENDERBAN_LIVE_SIEVE_PASSWORD"] ?? "";
const sender = process.env["SENDERBAN_LIVE_SIEVE_SENDER"] ?? "";

const entry = (n: number, value: string): BlockEntry => ({
  id: `0b5f5f58-8f2c-4b9e-9a45-2f0a5c6d9d${String(n).padStart(2, "0")}`,
  match: "exactAddress",
  value,
  action: "junk",
  createdAt: "2026-10-24T12:00:00.000Z",
});

describe.skipIf(host === undefined)("live ManageSieve account", () => {
  const adapter = new SieveAdapter({
    accountId: user,
    connect: () => connectManageSieve({ host: host ?? "", username: user, password }),
  });
  let state = initialSieveState();

  afterAll(async () => {
    await adapter.uninstall(state).catch(() => undefined);
  });

  it("installs, updates in place, verifies and uninstalls", async () => {
    const before = await connectManageSieve({ host: host ?? "", username: user, password });
    expect(await before.listScripts(), "account must start without scripts").toEqual([]);
    await before.close();

    const first = [entry(1, sender)];
    state = (await adapter.apply(await adapter.plan(first, state))).state;
    const check = await connectManageSieve({ host: host ?? "", username: user, password });
    const listed = [...(await check.listScripts())].sort((a, b) => a.name.localeCompare(b.name));
    expect(listed).toEqual([
      { name: "senderban-main", active: true },
      { name: "senderban-rules", active: false },
    ]);
    await check.close();
    expect(await adapter.verify(state)).toMatchObject({ drifted: false });

    const second = [...first, entry(2, "second-test@example.invalid")];
    const plan = await adapter.plan(second, state);
    expect(plan.changes.map((c) => c.kind)).toEqual(["create"]);
    state = (await adapter.apply(plan)).state;
    const proof = await adapter.verify(state);
    expect(proof.drifted, proof.detail).toBe(false);

    state = await adapter.uninstall(state);
    const after = await connectManageSieve({ host: host ?? "", username: user, password });
    expect(await after.listScripts()).toEqual([]);
    await after.close();
  });
});
