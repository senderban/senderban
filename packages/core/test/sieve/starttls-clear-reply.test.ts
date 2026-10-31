import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { createServer } from "node:net";
import type { AddressInfo, Server, Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { TLSSocket } from "node:tls";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { connectManageSieve, probeManageSieve } from "../../src/sieve/managesieve.js";
import { isCertificateRefusal } from "../../src/tls-refusal.js";

// A stand-in for a server that answers STARTTLS with its capabilities in clear behind the reply, the way Purelymail did on
// 2026-10-31, and says nothing after the handshake until asked. It makes its certificate with openssl, which CI's runners have.
const REAL_CAPS =
  '"SASL" "PLAIN"\r\n"SIEVE" "fileinto mailbox envelope"\r\n"VERSION" "1.0"\r\nOK\r\n';
/** What an attacker on the wire would like the client to believe, in the same clear bytes. */
const FORGED_CAPS = 'OK\r\n"SASL" "NONE"\r\n"SIEVE" "forged"\r\nOK\r\n';

const hasOpenssl = spawnSync("openssl", ["version"]).status === 0;
let dir: string;
let key: Buffer;
let cert: Buffer;
const servers: Server[] = [];

beforeAll(() => {
  if (!hasOpenssl) return;
  dir = mkdtempSync(join(tmpdir(), "senderban-starttls-"));
  execFileSync("openssl", [
    ...["req", "-x509", "-newkey", "ec", "-pkeyopt", "ec_paramgen_curve:prime256v1", "-nodes"],
    ...["-days", "2", "-subj", "/CN=localhost", "-addext", "subjectAltName=DNS:localhost"],
    ...["-keyout", join(dir, "tls.key"), "-out", join(dir, "tls.crt")],
  ]);
  key = readFileSync(join(dir, "tls.key"));
  cert = readFileSync(join(dir, "tls.crt"));
});
afterAll(async () => {
  await Promise.all(
    servers.splice(0).map(
      (server) =>
        new Promise((resolve) => {
          server.close(resolve);
        }),
    ),
  );
  if (hasOpenssl) rmSync(dir, { recursive: true, force: true });
});

interface Script {
  /** Sent in clear behind the STARTTLS reply. */
  readonly clear: string;
  /** Sent over TLS as soon as the handshake ends; a compliant server's capabilities. */
  readonly unasked?: string;
  /** The reply to AUTHENTICATE. */
  readonly login?: string;
  /** The reply to NOOP; a server past TLS may send anything. */
  readonly noop?: string;
  /** A slow server: each reply to CAPABILITY and NOOP comes this much after the one before. */
  readonly replyDelayMs?: number;
}

/** Answers lines over TLS; `heard` keeps what came through it, so a test can show where the password went. */
async function serve(script: Script): Promise<{ port: number; heard: string[] }> {
  const heard: string[] = [];
  const server = createServer((socket: Socket) => {
    socket.on("error", () => undefined);
    socket.write('"STARTTLS"\r\n"SASL" ""\r\nOK\r\n');
    socket.once("data", () => {
      socket.write(`OK\r\n${script.clear}`);
      const secure = new TLSSocket(socket, { isServer: true, key, cert });
      secure.on("error", () => undefined);
      secure.once("secure", () => {
        if (script.unasked !== undefined) secure.write(script.unasked);
      });
      secure.on("data", (chunk: Buffer) => {
        for (const line of chunk.toString("utf8").split("\r\n")) {
          if (line === "") continue;
          heard.push(line);
          const delay = script.replyDelayMs ?? 0;
          const later = (reply: string, turns: number): void => {
            if (delay === 0) secure.write(reply);
            else setTimeout(() => secure.write(reply), delay * turns);
          };
          if (line === "CAPABILITY") later(REAL_CAPS, 1);
          else if (line.startsWith("AUTHENTICATE")) secure.write(`${script.login ?? "OK"}\r\n`);
          else if (line === "NOOP") later(script.noop ?? 'OK "done"\r\n', 2);
          else secure.write("OK\r\n");
        }
      });
    });
  });
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return { port: (server.address() as AddressInfo).port, heard };
}

const endpoint = (port: number) => ({
  host: "127.0.0.1",
  port,
  timeoutMs: 5000,
  tls: { ca: cert, servername: "localhost" },
});

// The only cover of the CAPABILITY and NOOP exchange: in CI a missing openssl must show, not skip it.
it.runIf(process.env["CI"] !== undefined)("has openssl in CI", () => {
  expect(hasOpenssl).toBe(true);
});

describe.skipIf(!hasOpenssl)("a server that answers STARTTLS with capabilities in clear", () => {
  it("gives the whole exchange one deadline, not one per reply", async () => {
    const { port } = await serve({ clear: FORGED_CAPS, unasked: REAL_CAPS, replyDelayMs: 600 });
    await expect(probeManageSieve({ ...endpoint(port), timeoutMs: 900 })).rejects.toMatchObject({
      message: expect.stringContaining("timed out") as string,
    });
  });

  it("fails rather than go on with no end to the exchange in sight", async () => {
    const { port } = await serve({ clear: FORGED_CAPS, unasked: REAL_CAPS, noop: REAL_CAPS });
    await expect(probeManageSieve(endpoint(port))).rejects.toMatchObject({ code: "TRANSIENT" });
  });

  it("fails when the exchange ends in a refusal, leaving no reply to pair with the login", async () => {
    const { port } = await serve({ clear: FORGED_CAPS, noop: 'NO "no"\r\n' });
    await expect(probeManageSieve(endpoint(port))).rejects.toMatchObject({ code: "REJECTED" });
  });

  it("drops the clear bytes and asks over TLS when the server then stays silent", async () => {
    const { port, heard } = await serve({ clear: FORGED_CAPS });
    const found = await probeManageSieve(endpoint(port));
    expect(found.plain).toBe(true);
    expect(found.extensions.has("fileinto")).toBe(true);
    expect(found.extensions.has("forged")).toBe(false);
    expect(heard).toEqual(["CAPABILITY", "NOOP"]);
  });

  it("signs in only over the verified channel, on what that channel said", async () => {
    const { port, heard } = await serve({ clear: FORGED_CAPS });
    const session = await connectManageSieve({
      ...endpoint(port),
      username: "you@example.com",
      password: "not-a-real-password",
    });
    expect(session.extensions().has("forged")).toBe(false);
    session.destroy();
    expect(heard.slice(0, 2)).toEqual(["CAPABILITY", "NOOP"]);
    expect(heard[2]).toMatch(/^AUTHENTICATE "PLAIN"/u);
  });

  it("leaves no reply over to pass for the login's answer when the server repeats itself", async () => {
    const { port } = await serve({ clear: FORGED_CAPS, unasked: REAL_CAPS, login: 'NO "refused"' });
    const signIn = connectManageSieve({
      ...endpoint(port),
      username: "you@example.com",
      password: "wrong-password",
    });
    await expect(signIn).rejects.toMatchObject({ code: "AUTH_REQUIRED" });
  });

  it("never asks a compliant server", async () => {
    const { port, heard } = await serve({ clear: "", unasked: REAL_CAPS });
    expect((await probeManageSieve(endpoint(port))).plain).toBe(true);
    expect(heard).toEqual([]);
  });

  it("still refuses a certificate it cannot verify", async () => {
    const { port } = await serve({ clear: FORGED_CAPS });
    const error: unknown = await probeManageSieve({
      host: "127.0.0.1",
      port,
      timeoutMs: 5000,
    }).catch((e: unknown) => e);
    expect(isCertificateRefusal(error)).toBe(true);
    // Fixed words: Node's message quotes the certificate, and an attacker on the path chooses that.
    expect((error as Error).message).toBe("TLS handshake or certificate refused");
  });
});
