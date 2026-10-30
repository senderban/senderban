import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { AdapterError, type OpaqueState } from "../src/adapter.js";
import type { BlockEntry, Blocklist } from "../src/blocklist.js";
import { SieveAdapter, initialSieveState, sieveFit } from "../src/sieve/adapter.js";
import { probeManageSieve } from "../src/sieve/managesieve.js";
import { startDovecot, type Dovecot } from "./dovecot.js";

// The generic mail server path on a real Dovecot + Pigeonhole, twice: as shipped, and with `include` switched off, which is
// what Migadu and Purelymail advertise. Nothing here ran on those providers.
const USER = "someone@example.com";

const entry = (n: number, value: string): BlockEntry => ({
  id: `0b5f5f58-8f2c-4b9e-9a45-2f0a5c6d9e${String(n).padStart(2, "0")}`,
  match: "exactAddress",
  value,
  action: "junk",
  createdAt: "2026-10-31T00:00:00.000Z",
});

const mail = (from: string) => ({ from, envelopeFrom: from, subject: "hello" });

async function sync(adapter: SieveAdapter, list: Blocklist, state: OpaqueState) {
  return (await adapter.apply(await adapter.plan(list, state))).state;
}

const adapterOn = (server: Dovecot, user: string): SieveAdapter =>
  new SieveAdapter({ accountId: user, connect: () => server.connect(user) });

describe("a server as shipped", () => {
  let server: Dovecot;
  beforeAll(async () => {
    server = await startDovecot();
  });
  afterAll(() => {
    server.stop();
  });

  it("answers the probe from behind TLS, with no sign-in", async () => {
    const started = Date.now();
    const found = await probeManageSieve(server.endpoint);
    console.log(`probe ms=${String(Date.now() - started)}`);
    expect(found.plain).toBe(true);
    expect(found.extensions.has("include")).toBe(true);
    expect(sieveFit(found.extensions, [])).toBe("ok");
  });

  it("files a blocked sender in Junk and leaves anyone else in INBOX", async () => {
    const adapter = adapterOn(server, USER);
    const started = Date.now();
    const state = await sync(adapter, [entry(1, "spam@evil.example")], initialSieveState());
    console.log(`first-rule ms=${String(Date.now() - started)}`);
    await server.deliver(USER, mail("spam@evil.example"));
    await server.deliver(USER, mail("friend@good.example"));
    expect(server.count(USER, "Junk")).toBe(1);
    expect(server.count(USER, "INBOX")).toBe(1);
    expect((await adapter.verify(state)).drifted).toBe(false);
  });
});

describe("a server without include", () => {
  let server: Dovecot;
  beforeAll(async () => {
    server = await startDovecot({ noInclude: true });
  });
  afterAll(() => {
    server.stop();
  });

  it("really has no include: the probe says so, and the script compiler agrees", async () => {
    const found = await probeManageSieve(server.endpoint);
    expect(found.extensions.has("include")).toBe(false);
    expect(found.extensions.has("fileinto")).toBe(true);
    const session = await server.connect("compiler@example.com");
    try {
      await expect(
        session.putScript("x", 'require ["include"];\ninclude :personal "y";\n'),
      ).rejects.toMatchObject({ code: "REJECTED" });
    } finally {
      await session.close();
    }
  });

  it("runs the rules as the active script: block, deliver, verify, unblock, uninstall", async () => {
    const user = "direct@example.com";
    const adapter = adapterOn(server, user);
    const blocked = await sync(adapter, [entry(1, "spam@evil.example")], initialSieveState());

    const session = await server.connect(user);
    try {
      expect(await session.listScripts()).toEqual([{ name: "senderban-rules", active: true }]);
    } finally {
      await session.close();
    }
    expect((await adapter.verify(blocked)).drifted).toBe(false);

    await server.deliver(user, mail("spam@evil.example"));
    await server.deliver(user, mail("friend@good.example"));
    expect(server.count(user, "Junk")).toBe(1);
    expect(server.count(user, "INBOX")).toBe(1);

    const unblocked = await sync(adapter, [], blocked);
    await server.deliver(user, mail("spam@evil.example"));
    expect(server.count(user, "Junk")).toBe(1);
    expect(server.count(user, "INBOX")).toBe(2);

    await adapter.uninstall(unblocked);
    const after = await server.connect(user);
    try {
      expect(await after.listScripts()).toEqual([]);
    } finally {
      await after.close();
    }
  });

  it("leaves a person's active script alone and writes nothing", async () => {
    const user = "owner@example.com";
    const session = await server.connect(user);
    try {
      await session.putScript("mine", "keep;\n");
      await session.setActive("mine");
      expect(sieveFit(session.extensions(), await session.listScripts())).toBe("own-script");
    } finally {
      await session.close();
    }

    const failure = await sync(
      adapterOn(server, user),
      [entry(2, "spam@evil.example")],
      initialSieveState(),
    ).catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(AdapterError);
    expect((failure as AdapterError).code).toBe("CAPABILITY_NOT_SUPPORTED");

    const check = await server.connect(user);
    try {
      expect(await check.listScripts()).toEqual([{ name: "mine", active: true }]);
    } finally {
      await check.close();
    }
  });
});
