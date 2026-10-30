import { isIP, connect as tcpConnect, type Socket } from "node:net";
import { connect as tlsConnect, type TLSSocket } from "node:tls";
import { AdapterError } from "../adapter.js";
import { capabilitiesOf, parseResponse, type Response } from "./codec.js";
import type { SieveScriptInfo, SieveSession } from "./session.js";

// PROVISIONAL bound (milliseconds): one network step (connect, TLS handshake, one command).
const DEFAULT_TIMEOUT_MS = 15_000;

// RFC 4616 §2: each of authzid/authcid/passwd is at most 255 octets.
const SASL_FIELD_MAX_BYTES = 255;
const PORT = { min: 1, max: 65_535 } as const;
// RFC 5804 §4: a quoted string is at most 1024 octets.
const QUOTED_MAX_BYTES = 1024;

export interface ManageSieveOptions {
  readonly host: string;
  /** Default 4190 (the registered ManageSieve port). */
  readonly port?: number;
  readonly username: string;
  readonly password: string;
  readonly timeoutMs?: number;
  /** Stops the sign-in: the socket closes, so the password is not sent after the caller has given up. */
  readonly signal?: AbortSignal;
  /** Only for private CAs / tests; certificate verification is never switched off. */
  readonly tls?: { readonly ca?: string | Buffer; readonly servername?: string };
}

type Channel = Socket | TLSSocket;

/** Buffers socket bytes and hands out complete ManageSieve responses, one at a time. */
class ResponseChannel {
  readonly socket: Channel;
  readonly #timeoutMs: number;
  #buffer = Buffer.alloc(0);
  #failure: AdapterError | null = null;
  #wake: (() => void) | null = null;

  readonly #onData = (chunk: Buffer): void => {
    this.#buffer = Buffer.concat([this.#buffer, chunk]);
    this.#notify();
  };
  readonly #onError = (error: Error): void => {
    this.#failure ??= new AdapterError("TRANSIENT", `connection error: ${error.message}`);
    this.#notify();
  };
  readonly #onClose = (): void => {
    this.#failure ??= new AdapterError("TRANSIENT", "connection closed by server");
    this.#notify();
  };

  constructor(socket: Channel, timeoutMs: number) {
    this.socket = socket;
    this.#timeoutMs = timeoutMs;
    socket.on("data", this.#onData);
    socket.on("error", this.#onError);
    socket.on("close", this.#onClose);
  }

  #notify(): void {
    const wake = this.#wake;
    this.#wake = null;
    wake?.();
  }

  /** Bytes received but not yet consumed; must be zero right before a TLS upgrade. */
  get pending(): number {
    return this.#buffer.length;
  }

  detach(): Channel {
    this.socket.off("data", this.#onData);
    this.socket.off("error", this.#onError);
    this.socket.off("close", this.#onClose);
    return this.socket;
  }

  write(data: Buffer | string): void {
    this.socket.write(data);
  }

  async read(): Promise<Response> {
    const deadline = Date.now() + this.#timeoutMs;
    for (;;) {
      const parsed = parseResponse(this.#buffer);
      if (parsed !== null) {
        this.#buffer = this.#buffer.subarray(parsed.consumed);
        return parsed.response;
      }
      if (this.#failure !== null) throw this.#failure;
      const left = deadline - Date.now();
      if (left <= 0) {
        this.socket.destroy();
        throw new AdapterError("TRANSIENT", "timed out waiting for the server");
      }
      await new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, left);
        this.#wake = () => {
          clearTimeout(timer);
          resolve();
        };
      });
    }
  }
}

/** Maps a failed (NO/BYE) response to the adapter error the core understands. */
function failure(response: Response, what: string): AdapterError {
  const code = (response.code ?? "").toUpperCase();
  const text = response.text === null ? "" : `: ${response.text}`;
  if (response.status === "BYE" || code === "TRYLATER") {
    return new AdapterError("TRANSIENT", `${what} - server said ${response.status}${text}`);
  }
  if (code.startsWith("QUOTA")) {
    return new AdapterError("QUOTA_EXCEEDED", `${what} - over quota${text}`);
  }
  return new AdapterError("REJECTED", `${what} - refused${text}`);
}

/**
 * A refused AUTHENTICATE is a wrong password (permanent, never retried: some hosts block the address
 * after repeated failures) unless the server says the failure is temporary. RFC 5804 s1.3 lets any
 * NO/BYE carry TRYLATER ("temporary server failure"); a throttled login must be retried, not reported as a bad password.
 */
export function authFailure(response: Response): AdapterError {
  const code = (response.code ?? "").toUpperCase();
  // Fixed texts: the server's own words do not go into the log or the sync journal.
  if (response.status === "BYE" || code === "TRYLATER") {
    return new AdapterError("TRANSIENT", "ManageSieve login was deferred by the server");
  }
  return new AdapterError("AUTH_REQUIRED", "ManageSieve login was refused");
}

function expectOk(response: Response, what: string): void {
  if (response.status !== "OK") throw failure(response, what);
}

function quoted(value: string): string {
  if (
    value.length === 0 ||
    value.includes(String.fromCharCode(0)) ||
    value.includes("\r") ||
    value.includes("\n") ||
    Buffer.byteLength(value) > QUOTED_MAX_BYTES
  ) {
    throw new AdapterError("REJECTED", "script name not allowed");
  }
  return `"${value.replaceAll("\\", "\\\\").replaceAll('"', '\\"')}"`;
}

function checkOptions(options: ManageSieveOptions): number {
  const port = options.port ?? 4190;
  if (!Number.isInteger(port) || port < PORT.min || port > PORT.max) {
    throw new AdapterError("REJECTED", "port out of range");
  }
  if (options.host.length === 0 || options.host.length > 253) {
    throw new AdapterError("REJECTED", "host out of range");
  }
  for (const field of [options.username, options.password]) {
    const size = Buffer.byteLength(field);
    if (size === 0 || size > SASL_FIELD_MAX_BYTES || field.includes("\u0000")) {
      throw new AdapterError("REJECTED", "credential length out of range");
    }
  }
  return port;
}

async function withTimeout<T>(promise: Promise<T>, ms: number, what: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      reject(new AdapterError("TRANSIENT", `${what} timed out`));
    }, ms);
  });
  try {
    return await Promise.race([promise, timeout]);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Opens an authenticated ManageSieve session: plain TCP, STARTTLS (refused if the server does not
 * offer it, so the password never travels in clear), one SASL PLAIN attempt, no retries - a wrong
 * password is not retried because some hosts block the address after repeated failures.
 */
export async function connectManageSieve(options: ManageSieveOptions): Promise<SieveSession> {
  const port = checkOptions(options);
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const signal = options.signal;
  signal?.throwIfAborted();

  const raw = tcpConnect({ host: options.host, port });
  const onAbort = (): void => {
    raw.destroy();
  };
  signal?.addEventListener("abort", onAbort, { once: true });
  try {
    await withTimeout(
      new Promise<void>((resolve, reject) => {
        raw.once("connect", resolve);
        raw.once("error", (e) => {
          reject(new AdapterError("TRANSIENT", `connection error: ${e.message}`));
        });
        raw.once("close", () => {
          reject(new AdapterError("TRANSIENT", "connection closed"));
        });
      }),
      timeoutMs,
      "connect",
    );

    const plain = new ResponseChannel(raw, timeoutMs);
    const greeting = await plain.read();
    expectOk(greeting, "greeting");
    if (!capabilitiesOf(greeting).has("STARTTLS")) {
      throw new AdapterError(
        "CAPABILITY_NOT_SUPPORTED",
        "server does not offer STARTTLS; refusing to send credentials unencrypted",
      );
    }
    plain.write("STARTTLS\r\n");
    expectOk(await plain.read(), "STARTTLS");
    // Bytes queued behind the STARTTLS reply would be attacker-controlled plaintext.
    if (plain.pending > 0) throw new AdapterError("TRANSIENT", "data injected before TLS upgrade");

    const tlsSocket = tlsConnect({
      socket: plain.detach(),
      // Without it an IP address is checked against the certificate as `localhost`.
      host: options.host,
      minVersion: "TLSv1.2",
      ...(isIP(options.tls?.servername ?? options.host) === 0
        ? { servername: options.tls?.servername ?? options.host }
        : {}),
      ...(options.tls?.ca === undefined ? {} : { ca: options.tls.ca }),
    });
    await withTimeout(
      new Promise<void>((resolve, reject) => {
        tlsSocket.once("secureConnect", resolve);
        tlsSocket.once("error", (e: Error) => {
          reject(new AdapterError("TRANSIENT", `TLS error: ${e.message}`));
        });
        tlsSocket.once("close", () => {
          reject(new AdapterError("TRANSIENT", "connection closed during TLS handshake"));
        });
      }),
      timeoutMs,
      "TLS handshake",
    );

    const secure = new ResponseChannel(tlsSocket, timeoutMs);
    const afterTls = await secure.read();
    expectOk(afterTls, "capabilities after STARTTLS");
    const caps = capabilitiesOf(afterTls);
    if (!(caps.get("SASL") ?? "").toUpperCase().split(" ").includes("PLAIN")) {
      throw new AdapterError("CAPABILITY_NOT_SUPPORTED", "server does not offer SASL PLAIN");
    }

    signal?.throwIfAborted();
    const initial = Buffer.from(`\u0000${options.username}\u0000${options.password}`, "utf8");
    secure.write(`AUTHENTICATE "PLAIN" "${initial.toString("base64")}"\r\n`);
    const auth = await secure.read();
    if (auth.status !== "OK") throw authFailure(auth);

    const extensions = new Set(
      (caps.get("SIEVE") ?? "")
        .toLowerCase()
        .split(" ")
        .filter((e) => e.length > 0),
    );
    return new ManageSieveSession(secure, extensions);
  } catch (error) {
    raw.destroy();
    throw error;
  } finally {
    signal?.removeEventListener("abort", onAbort);
  }
}

class ManageSieveSession implements SieveSession {
  readonly #channel: ResponseChannel;
  readonly #extensions: ReadonlySet<string>;
  #queue: Promise<unknown> = Promise.resolve();

  constructor(channel: ResponseChannel, extensions: ReadonlySet<string>) {
    this.#channel = channel;
    this.#extensions = extensions;
  }

  extensions(): ReadonlySet<string> {
    return this.#extensions;
  }

  /** One command in flight at a time: ManageSieve replies are matched to commands by order. */
  #command(bytes: Buffer | string): Promise<Response> {
    const run = async (): Promise<Response> => {
      this.#channel.write(bytes);
      return this.#channel.read();
    };
    const next = this.#queue.then(run, run);
    this.#queue = next.catch(() => undefined);
    return next;
  }

  async listScripts(): Promise<readonly SieveScriptInfo[]> {
    const response = await this.#command("LISTSCRIPTS\r\n");
    expectOk(response, "LISTSCRIPTS");
    const scripts: SieveScriptInfo[] = [];
    for (const [name, flag] of response.data) {
      if (name?.kind !== "string") continue;
      scripts.push({ name: name.value, active: flag?.value.toUpperCase() === "ACTIVE" });
    }
    return scripts;
  }

  async getScript(name: string): Promise<string | null> {
    const response = await this.#command(`GETSCRIPT ${quoted(name)}\r\n`);
    if (response.status === "NO" && (response.code ?? "").toUpperCase() === "NONEXISTENT") {
      return null;
    }
    expectOk(response, "GETSCRIPT");
    const body = response.data[0]?.[0];
    if (body?.kind !== "string") {
      throw new AdapterError("TRANSIENT", "ManageSieve protocol error: GETSCRIPT without a script");
    }
    return body.value;
  }

  async haveSpace(name: string, sizeBytes: number): Promise<boolean> {
    if (!Number.isSafeInteger(sizeBytes) || sizeBytes < 0 || sizeBytes > 0xffffffff) {
      throw new AdapterError("REJECTED", "script size out of range");
    }
    const response = await this.#command(`HAVESPACE ${quoted(name)} ${String(sizeBytes)}\r\n`);
    if (response.status === "OK") return true;
    if ((response.code ?? "").toUpperCase().startsWith("QUOTA")) return false;
    throw failure(response, "HAVESPACE");
  }

  async putScript(name: string, content: string): Promise<void> {
    const body = Buffer.from(content.replace(/\r?\n/g, "\r\n"), "utf8");
    const head = Buffer.from(`PUTSCRIPT ${quoted(name)} {${String(body.length)}+}\r\n`, "utf8");
    expectOk(await this.#command(Buffer.concat([head, body, Buffer.from("\r\n")])), "PUTSCRIPT");
  }

  async setActive(name: string): Promise<void> {
    const arg = name === "" ? '""' : quoted(name);
    expectOk(await this.#command(`SETACTIVE ${arg}\r\n`), "SETACTIVE");
  }

  async deleteScript(name: string): Promise<void> {
    expectOk(await this.#command(`DELETESCRIPT ${quoted(name)}\r\n`), "DELETESCRIPT");
  }

  destroy(): void {
    this.#channel.socket.destroy();
  }

  async close(): Promise<void> {
    try {
      await this.#command("LOGOUT\r\n");
    } catch {
      // the connection is being dropped either way
    } finally {
      this.#channel.socket.destroy();
    }
  }
}
