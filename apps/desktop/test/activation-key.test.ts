import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { loadActivationSigner } from "../src/activation-key.js";
import type { KeyVault } from "../src/activation-key.js";

let dir = "";
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "senderban-key-"));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

/** Stands in for safeStorage: a reversible mask, so the file never holds the key in the clear. */
const vault = (available = true): KeyVault => ({
  available: () => Promise.resolve(available),
  encrypt: (plain) => Promise.resolve(Buffer.from(`vault:${plain}`, "utf8")),
  decrypt: (cipher) => {
    const text = cipher.toString("utf8");
    if (!text.startsWith("vault:")) return Promise.reject(new Error("not ours"));
    return Promise.resolve(text.slice("vault:".length));
  },
});
const tag = (signer: NonNullable<Awaited<ReturnType<typeof loadActivationSigner>>>) =>
  signer.sign("sender", "id", "acct", "a@example.com", 1);

describe("loadActivationSigner", () => {
  it("makes a key the first time, keeps it with the OS, and signs the same after a restart", async () => {
    const path = join(dir, "activation-key.json");
    const first = await loadActivationSigner(path, vault());
    const second = await loadActivationSigner(path, vault());
    expect(first).not.toBeNull();
    expect(second).not.toBeNull();
    expect(tag(first ?? never())).toBe(tag(second ?? never()));
    const file = JSON.parse(await readFile(path, "utf8")) as { version: number; key: string };
    expect(file.version).toBe(1);
    // The file holds ciphertext only: the 64 hex characters of the key are not in it.
    expect(Buffer.from(file.key, "base64").toString("utf8")).toMatch(/^vault:/u);
    expect(file.key).not.toMatch(/^[0-9a-f]{64}$/u);
  });

  it("makes a new key, not a crash, when the file is damaged or cannot be opened", async () => {
    const path = join(dir, "activation-key.json");
    const first = await loadActivationSigner(path, vault());
    await writeFile(path, "not json", "utf8");
    const second = await loadActivationSigner(path, vault());
    expect(second).not.toBeNull();
    expect(tag(first ?? never())).not.toBe(tag(second ?? never()));
    await writeFile(path, JSON.stringify({ version: 1, key: "AAAA" }), "utf8");
    expect(await loadActivationSigner(path, vault())).not.toBeNull();
  });

  it("says why a new key was made: the first time, then when the file could not be used", async () => {
    const path = join(dir, "activation-key.json");
    const reasons: string[] = [];
    await loadActivationSigner(path, vault(), (r) => reasons.push(r));
    await loadActivationSigner(path, vault(), (r) => reasons.push(r));
    await writeFile(path, JSON.stringify({ version: 1, key: "AAAA", extra: true }), "utf8");
    await loadActivationSigner(path, vault(), (r) => reasons.push(r));
    expect(reasons).toEqual(["first", "replaced"]);
  });

  it("refuses a key file with the wrong shape instead of trusting it", async () => {
    const path = join(dir, "activation-key.json");
    await writeFile(path, JSON.stringify({ version: 2, key: "AAAA" }), "utf8");
    const signer = await loadActivationSigner(path, vault());
    expect(signer).not.toBeNull();
    const file = JSON.parse(await readFile(path, "utf8")) as { version: number };
    expect(file.version).toBe(1);
  });

  it("gives no signer when the OS cannot keep a secret, and writes nothing", async () => {
    const path = join(dir, "activation-key.json");
    expect(await loadActivationSigner(path, vault(false))).toBeNull();
    await expect(readFile(path, "utf8")).rejects.toThrow();
  });

  it("gives no signer when the key cannot be written", async () => {
    expect(
      await loadActivationSigner(join(dir, "missing", "activation-key.json"), vault()),
    ).toBeNull();
  });
});

function never(): never {
  throw new Error("expected a signer");
}
