import { mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// accounts-file.ts imports Electron's safeStorage; a bad file must fail before it is ever called.
vi.mock("electron", () => ({ safeStorage: {} }));

const { ADD_ACCOUNT_FILE_MAX_BYTES, AddAccountError, addAccountFromFile } =
  await import("../src/add-account.js");

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "senderban-add-account-"));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

async function rejection(content: string): Promise<unknown> {
  const input = join(dir, "account.json");
  await writeFile(input, content, "utf8");
  return addAccountFromFile(input, join(dir, "accounts.json")).then(
    () => undefined,
    (error: unknown) => error,
  );
}

describe("addAccountFromFile on a hand-typed file", () => {
  it("never quotes the password of a malformed file in the error", async () => {
    const error = await rejection(`{"id":"acc",'password':'S3cretPw!'}`);
    expect(error).toBeInstanceOf(AddAccountError);
    expect((error as Error).message).toBe("account file is not valid JSON");
    expect((error as Error).message).not.toContain("S3cretPw");
  });

  it("refuses a file larger than one account can be", async () => {
    const error = await rejection(" ".repeat(ADD_ACCOUNT_FILE_MAX_BYTES + 1));
    expect((error as Error).message).toBe("account file is too large");
  });

  it("leaves the plaintext file on disk when the add fails, and says so by failing", async () => {
    await rejection("not json");
    expect((await stat(join(dir, "account.json"))).isFile()).toBe(true);
  });
});
