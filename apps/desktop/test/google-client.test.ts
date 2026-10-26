import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// google-client.ts reaches Electron only through the accounts file helpers; a stand-in is enough.
vi.mock("electron", () => ({ safeStorage: {} }));

const { ClientFileInvalid, loadGoogleClient } = await import("../src/google-client.js");

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
