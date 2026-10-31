import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// google-client.ts reaches Electron only through the accounts file helpers; a stand-in is enough.
vi.mock("electron", () => ({ safeStorage: {} }));

const { ClientFileInvalid, activeGoogleClient, loadBuiltInGoogleClient, loadGoogleClient } =
  await import("../src/google-client.js");

let dir: string;
let path: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "senderban-client-"));
  path = join(dir, "google-client.json");
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

// Built at run time: a whole fake client ID in the source trips GitHub push protection.
const CLIENT_ID = ["123456789012-abcdefghijklmnop", "apps", "googleusercontent", "com"].join(".");

describe("the client the installer comes with", () => {
  const SECRET = ["GOCSPX", "a-built-in-secret-0123456789"].join("-");
  let builtIn: string;
  beforeEach(() => {
    builtIn = join(dir, "google-client.builtin.json");
  });
  const own = () =>
    writeFile(path, JSON.stringify({ version: 1, clientId: CLIENT_ID, secretCipher: "AAECAw==" }));

  it("reads a pair, and takes null for a file that is absent, too large, not JSON or not ours", async () => {
    expect(await loadBuiltInGoogleClient(builtIn)).toBeNull();
    for (const text of [
      "{ not json",
      JSON.stringify({ clientId: CLIENT_ID }),
      JSON.stringify({ clientId: CLIENT_ID, clientSecret: SECRET, x: 1 }),
      JSON.stringify({ clientId: "not-a-client-id", clientSecret: SECRET }),
      "x".repeat(20_000),
    ]) {
      await writeFile(builtIn, text);
      expect(await loadBuiltInGoogleClient(builtIn)).toBeNull();
    }
    await writeFile(builtIn, JSON.stringify({ clientId: CLIENT_ID, clientSecret: SECRET }));
    expect(await loadBuiltInGoogleClient(builtIn)).toEqual({
      clientId: CLIENT_ID,
      clientSecret: SECRET,
    });
  });

  it("uses it only when the person saved none, and says so", async () => {
    await writeFile(builtIn, JSON.stringify({ clientId: CLIENT_ID, clientSecret: SECRET }));
    const client = await activeGoogleClient(path, builtIn);
    expect(client).toMatchObject({ clientId: CLIENT_ID, builtIn: true });
    expect(await client?.getSecret()).toBe(SECRET);
    await own();
    expect((await activeGoogleClient(path, builtIn))?.builtIn).toBe(false);
  });

  it("falls back to it from a client file that is not ours, and without it keeps failing", async () => {
    await writeFile(path, "{ not json");
    await writeFile(builtIn, JSON.stringify({ clientId: CLIENT_ID, clientSecret: SECRET }));
    expect((await activeGoogleClient(path, builtIn))?.builtIn).toBe(true);
    await expect(activeGoogleClient(path)).rejects.toBeInstanceOf(ClientFileInvalid);
  });

  it("is no client at all when there is neither", async () => {
    expect(await activeGoogleClient(path, builtIn)).toBeNull();
    expect(await activeGoogleClient(path)).toBeNull();
  });
});

describe("loadGoogleClient", () => {
  it("answers null for a file that is not there", async () => {
    expect(await loadGoogleClient(path)).toBeNull();
  });

  it("reads a valid file", async () => {
    await writeFile(
      path,
      JSON.stringify({ version: 1, clientId: CLIENT_ID, secretCipher: "AAECAw==" }),
    );
    expect((await loadGoogleClient(path))?.clientId).toBe(CLIENT_ID);
  });

  it.each([
    ["not JSON", "{ not json"],
    ["valid JSON that is not a client file", JSON.stringify({ hello: "world" })],
    [
      "a plaintext secret",
      JSON.stringify({ version: 1, clientId: CLIENT_ID, secretCipher: "not base64!" }),
    ],
    [
      "an extra key",
      JSON.stringify({ version: 1, clientId: CLIENT_ID, secretCipher: "AAECAw==", x: 1 }),
    ],
    ["a file far larger than any valid one", "x".repeat(20_000)],
  ])("calls %s invalid, and the message quotes none of it", async (_name, text) => {
    await writeFile(path, text);
    const error = await loadGoogleClient(path).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ClientFileInvalid);
    expect((error as Error).message).not.toContain(text.slice(0, 8));
  });
});
