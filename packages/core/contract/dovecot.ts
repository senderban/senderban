import { execFileSync, spawnSync } from "node:child_process";
import { connect as tlsConnect } from "node:tls";
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { connectManageSieve } from "../src/sieve/managesieve.js";
import type { ManageSieveEndpoint } from "../src/sieve/managesieve.js";
import type { SieveSession } from "../src/sieve/session.js";

// Exact tag, measured on Docker Hub on 2026-10-24 (published 2026-10-05).
export const DOVECOT_IMAGE = "dovecot/dovecot:2.4.5";
const PASSWORD = "contract-pw";
const MANAGESIEVE_PORT = 34190;
const DOVEADM = "/dovecot/bin/doveadm";
const LMTPS_PORT = 31024;
const IMAPS_PORT = 31993;

export interface Dovecot {
  readonly password: string;
  /** Host ports, and the certificate the container serves: its name is `localhost`. */
  readonly port: number;
  readonly imapPort: number;
  readonly ca: Buffer;
  readonly endpoint: ManageSieveEndpoint;
  /** Where IMAP over TLS answers, and what to trust there. */
  readonly imap: { readonly host: string; readonly port: number; readonly ca: Buffer };
  connect(user: string, password?: string): Promise<SieveSession>;
  /** Delivers over LMTPS, the path a real MX uses, so the user's active Sieve script runs. */
  deliver(
    user: string,
    mail: { from: string; envelopeFrom: string; subject: string; headers?: readonly string[] },
  ): Promise<void>;
  count(user: string, mailbox: string): number;
  stop(): void;
}

function docker(args: string[], input?: string): string {
  const result = spawnSync("docker", args, { input, encoding: "utf8" });
  if (result.status !== 0) {
    throw new Error(`docker ${args.slice(0, 2).join(" ")} failed: ${result.stderr}`);
  }
  return result.stdout;
}

export interface DovecotOptions {
  /** Switches the Sieve `include` extension off, as a server that does not advertise it. */
  readonly noInclude?: boolean;
}

/** Dovecot 2.4 boolean list: `sieve_extensions` keeps its defaults, minus this one. */
const NO_INCLUDE_CONF = "sieve_extensions {\n  include = no\n}\n";

export async function startDovecot(options: DovecotOptions = {}): Promise<Dovecot> {
  const dir = mkdtempSync(join(tmpdir(), "senderban-dovecot-"));
  execFileSync("openssl", [
    ...["req", "-x509", "-newkey", "ec", "-pkeyopt", "ec_paramgen_curve:prime256v1", "-nodes"],
    ...["-days", "2", "-subj", "/CN=localhost", "-addext", "subjectAltName=DNS:localhost"],
    ...["-keyout", join(dir, "tls.key"), "-out", join(dir, "tls.crt")],
  ]);
  for (const file of ["tls.key", "tls.crt"]) chmodSync(join(dir, file), 0o644);
  chmodSync(dir, 0o755);
  const ca = readFileSync(join(dir, "tls.crt"));
  const conf = join(dir, "sieve-test.conf");
  if (options.noInclude === true) {
    writeFileSync(conf, NO_INCLUDE_CONF);
    chmodSync(conf, 0o644);
  }

  const name = `senderban-contract-${String(process.pid)}-${options.noInclude === true ? "bare" : "full"}`;
  docker([
    ...["run", "-d", "--name", name],
    ...["-e", `USER_PASSWORD={PLAIN}${PASSWORD}`],
    ...["-p", `127.0.0.1::${String(MANAGESIEVE_PORT)}`],
    ...["-p", `127.0.0.1::${String(LMTPS_PORT)}`],
    ...["-p", `127.0.0.1::${String(IMAPS_PORT)}`],
    ...["-v", `${dir}:/etc/dovecot/ssl:ro`],
    ...(options.noInclude === true ? ["-v", `${conf}:/etc/dovecot/conf.d/sieve-test.conf:ro`] : []),
    DOVECOT_IMAGE,
  ]);
  const stop = (): void => {
    spawnSync("docker", ["rm", "-f", name]);
    rmSync(dir, { recursive: true, force: true });
  };

  try {
    const hostPort = (containerPort: number): number => {
      const mapped = docker(["port", name, `${String(containerPort)}/tcp`])
        .trim()
        .split("\n")[0];
      return Number(mapped?.split(":").pop());
    };
    const port = hostPort(MANAGESIEVE_PORT);
    const lmtpPort = hostPort(LMTPS_PORT);
    const imapPort = hostPort(IMAPS_PORT);
    const endpoint = {
      host: "127.0.0.1",
      port,
      timeoutMs: 5000,
      tls: { ca, servername: "localhost" },
    };
    const connect = (user: string, password = PASSWORD): Promise<SieveSession> =>
      connectManageSieve({ ...endpoint, username: user, password });

    const deadline = Date.now() + 60_000;
    for (;;) {
      try {
        await (await connect("ready@example.test")).close();
        break;
      } catch (error) {
        if (Date.now() > deadline) throw error;
        await new Promise((resolve) => setTimeout(resolve, 500));
      }
    }

    return {
      password: PASSWORD,
      port,
      imapPort,
      ca,
      endpoint,
      imap: { host: "127.0.0.1", port: imapPort, ca },
      connect,
      deliver(user, mail) {
        const extra = (mail.headers ?? []).map((line) => `${line}\r\n`).join("");
        const raw = `From: ${mail.from}\r\nTo: ${user}\r\nSubject: ${mail.subject}\r\n${extra}\r\nbody\r\n`;
        return lmtpDeliver(lmtpPort, ca, user, mail.envelopeFrom, raw);
      },
      count(user, mailbox) {
        try {
          const args = ["exec", name, DOVEADM, "search", "-u", user, "mailbox", mailbox, "all"];
          return docker(args)
            .split("\n")
            .filter((line) => line.trim() !== "").length;
        } catch {
          return 0; // the mailbox does not exist yet
        }
      },
      stop,
    };
  } catch (error) {
    stop();
    throw error;
  }
}

/** Minimal LMTP client (RFC 2033): one message, one recipient, implicit TLS. */
function lmtpDeliver(
  port: number,
  ca: Buffer,
  recipient: string,
  envelopeFrom: string,
  message: string,
): Promise<void> {
  return new Promise((resolve, reject) => {
    const socket = tlsConnect({ host: "127.0.0.1", port, ca, servername: "localhost" });
    const steps = [
      "LHLO contract.test",
      `MAIL FROM:<${envelopeFrom}>`,
      `RCPT TO:<${recipient}>`,
      "DATA",
      `${message}.`,
      "QUIT",
    ];
    const expected = ["250", "250", "250", "354", "250", "221"];
    let step = -1; // -1: waiting for the 220 greeting
    let buffered = "";
    const fail = (error: Error): void => {
      socket.destroy();
      reject(error);
    };
    socket.setTimeout(10_000, () => {
      fail(new Error("LMTP timed out"));
    });
    socket.on("error", fail);
    socket.on("data", (chunk: Buffer) => {
      buffered += chunk.toString("latin1");
      for (;;) {
        const end = buffered.indexOf("\r\n");
        if (end === -1) return;
        const line = buffered.slice(0, end);
        buffered = buffered.slice(end + 2);
        if (/^\d{3}-/.test(line)) continue; // continuation of a multi-line reply
        const want = step === -1 ? "220" : expected[step];
        if (!line.startsWith(`${want ?? "?"} `) && line !== want) {
          fail(new Error(`LMTP expected ${want ?? "?"}, got: ${line}`));
          return;
        }
        step += 1;
        const next = steps[step];
        if (next === undefined) {
          socket.end();
          resolve();
          return;
        }
        socket.write(`${next}\r\n`);
      }
    });
  });
}
