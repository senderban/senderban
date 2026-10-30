import { z } from "zod";
import { AdapterError } from "../adapter.js";

/**
 * MXroute REST API, spam blacklist (https://api.mxroute.com/openapi.yaml, read 2026-10-25; measured live the
 * same day, 007 S5). The host is fixed: a key is only ever sent to MXroute, never to an address a person typed.
 */
export const MXROUTE_API = "https://api.mxroute.com";

/** One request: connect, answer and body. Unit: milliseconds. */
export const MXROUTE_TIMEOUT_MS = 15_000;
/**
 * Bytes read from one answer, at most. A blacklist of 100 000 entries of 254 characters would be 25 MB;
 * a real one is a few KB (40 entries measured), so 4 MiB is generous and a runaway answer is cut off.
 */
export const MXROUTE_BODY_MAX_BYTES = 4_194_304;
/** The API's own bound for one blacklist entry (spec: maxLength 254, pattern below). */
export const BLACKLIST_ENTRY = /^[a-zA-Z0-9@.\-_*+=]{1,254}$/;

const ListAnswer = z.object({
  success: z.literal(true),
  data: z.array(z.string().max(254)).max(100_000),
});

export interface MxrouteClientOptions {
  /** X-Server: the mail server host name. */
  readonly server: string;
  /** X-Username: the DirectAdmin user name. */
  readonly username: string;
  /** Called for every request, so the key is decrypted just before use and never held. */
  readonly getKey: () => Promise<string>;
  readonly fetch?: typeof fetch;
  readonly timeoutMs?: number;
  /**
   * Told after every request: which operation, the HTTP status (null when it never got one) and how long it took.
   * Nothing of the request or the answer: it feeds the log, which must stay free of keys and addresses.
   */
  readonly onCall?: (call: MxrouteCall) => void;
}

export interface MxrouteCall {
  readonly op: "domains" | "list" | "add" | "remove";
  readonly status: number | null;
  readonly ms: number;
}

export interface MxrouteClient {
  /** Every domain of the login: the cheapest call that proves a key without naming a domain. */
  domains(signal?: AbortSignal): Promise<readonly string[]>;
  /** Every blacklist entry of the domain. */
  list(domain: string, signal?: AbortSignal): Promise<readonly string[]>;
  /** Adds one entry; an entry that is already there counts as added (409). */
  add(domain: string, entry: string, signal?: AbortSignal): Promise<void>;
  /** Removes one entry; an entry that is already gone counts as removed (404). */
  remove(domain: string, entry: string, signal?: AbortSignal): Promise<void>;
}

/**
 * MXroute answered 400 or 422 to adding one entry: this entry is refused, the key and the server are fine. It is
 * still a REJECTED error, but the adapter can tell it from "the stored key cannot be read" and carry on.
 */
export class EntryRefusedError extends AdapterError {
  constructor() {
    super("REJECTED", "MXroute does not accept this entry");
    this.name = "EntryRefusedError";
  }
}

/** HTTP 429: MXroute asked to slow down. A TRANSIENT error the adapter handles as "later" instead of as a failure. */
export class RateLimitedError extends AdapterError {
  constructor(what: string) {
    super("TRANSIENT", `MXroute asked to slow down (${what})`);
    this.name = "RateLimitedError";
  }
}

/** Fixed texts only: neither the key, a header nor the server's own words reach a log or the journal. */
function failure(status: number, what: string): AdapterError {
  if (status === 401 || status === 403) {
    return new AdapterError("AUTH_REQUIRED", `MXroute refused the API key (${what})`);
  }
  if (status === 429) return new RateLimitedError(what);
  if (status >= 500) {
    return new AdapterError(
      "TRANSIENT",
      `MXroute is busy or unavailable (${what}, ${String(status)})`,
    );
  }
  return new AdapterError("REJECTED", `MXroute refused the request (${what}, ${String(status)})`);
}

async function readBounded(response: Response): Promise<string> {
  const declared = Number(response.headers.get("content-length") ?? "0");
  if (declared > MXROUTE_BODY_MAX_BYTES) {
    await response.body?.cancel();
    throw new AdapterError("TRANSIENT", "MXroute answer is larger than any valid one");
  }
  const reader = response.body?.getReader();
  if (reader === undefined) return "";
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const chunk = (await reader.read()) as { done: boolean; value?: Uint8Array };
    if (chunk.done || chunk.value === undefined) break;
    const value = chunk.value;
    size += value.byteLength;
    if (size > MXROUTE_BODY_MAX_BYTES) {
      await reader.cancel();
      throw new AdapterError("TRANSIENT", "MXroute answer is larger than any valid one");
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks).toString("utf8");
}

/** `.` and `..` match the pattern but would be resolved as path segments by the URL: never valid entries. */
const isDotSegment = (entry: string): boolean => entry === "." || entry === "..";
/** `*` is a wildcard on the blacklist (`*@163.com` is a real entry of the person's): this client never writes or deletes one. */
const isWildcard = (entry: string): boolean => entry.includes("*");
/** `@163.com` blocks a whole domain: only the person writes those; this client handles single addresses. */
const isDomainWide = (entry: string): boolean => entry.startsWith("@");

/**
 * True when the client would write this address to the blacklist as a single entry. One predicate for the
 * adapter, this client, the toast (which offers "Block at server") and the block action, so what the person is
 * offered is exactly what can be done.
 */
export function canRefuseAtServer(address: string): boolean {
  return (
    BLACKLIST_ENTRY.test(address) &&
    !isDotSegment(address) &&
    !isWildcard(address) &&
    !isDomainWide(address)
  );
}

export function createMxrouteClient(options: MxrouteClientOptions): MxrouteClient {
  const doFetch = options.fetch ?? fetch;
  const timeoutMs = options.timeoutMs ?? MXROUTE_TIMEOUT_MS;

  async function call(
    method: "GET" | "POST" | "DELETE",
    path: string,
    what: string,
    signal: AbortSignal | undefined,
    body?: string,
  ): Promise<{ status: number; response: Response }> {
    const deadline = AbortSignal.timeout(timeoutMs);
    let key: string;
    try {
      key = await options.getKey();
    } catch {
      throw new AdapterError("REJECTED", "the stored MXroute key cannot be read");
    }
    const started = Date.now();
    const report = (status: number | null): void => {
      try {
        options.onCall?.({
          op: what as MxrouteCall["op"],
          status,
          ms: Date.now() - started,
        });
      } catch {
        // a listener must not break a request
      }
    };
    try {
      const response = await doFetch(`${MXROUTE_API}${path}`, {
        method,
        headers: {
          "X-Server": options.server,
          "X-Username": options.username,
          "X-API-Key": key,
          Accept: "application/json",
          ...(body === undefined ? {} : { "Content-Type": "application/json" }),
        },
        ...(body === undefined ? {} : { body }),
        signal: signal === undefined ? deadline : AbortSignal.any([signal, deadline]),
        redirect: "error",
      });
      report(response.status);
      return { status: response.status, response };
    } catch (error) {
      report(null);
      if (error instanceof AdapterError) throw error;
      // The abort reason of the engine's own deadline, or a network error: never the request that was sent.
      if (signal?.aborted === true && signal.reason instanceof AdapterError) throw signal.reason;
      throw new AdapterError("TRANSIENT", `MXroute could not be reached (${what})`);
    }
  }

  const base = (domain: string): string => `/domains/${encodeURIComponent(domain)}/spam/blacklist`;

  /** Both reads answer with the same list of strings. */
  async function readList(
    path: string,
    what: "domains" | "list",
    signal: AbortSignal | undefined,
  ): Promise<readonly string[]> {
    const { status, response } = await call("GET", path, what, signal);
    if (status !== 200) {
      await response.body?.cancel();
      throw failure(status, what);
    }
    let json: unknown;
    try {
      json = JSON.parse(await readBounded(response));
    } catch (error) {
      if (error instanceof AdapterError) throw error;
      throw new AdapterError("TRANSIENT", `MXroute ${what} answer is malformed`);
    }
    const parsed = ListAnswer.safeParse(json);
    if (!parsed.success) throw new AdapterError("TRANSIENT", `MXroute ${what} answer is malformed`);
    return parsed.data.data;
  }

  return {
    domains: (signal) => readList("/domains", "domains", signal),
    list: (domain, signal) => readList(base(domain), "list", signal),
    async add(domain, entry, signal) {
      if (
        !BLACKLIST_ENTRY.test(entry) ||
        isDotSegment(entry) ||
        isWildcard(entry) ||
        isDomainWide(entry)
      )
        throw new AdapterError("REJECTED", "entry is not valid for MXroute");
      const { status, response } = await call(
        "POST",
        base(domain),
        "add",
        signal,
        JSON.stringify({ entry }),
      );
      await response.body?.cancel();
      if (status === 201 || status === 409) return;
      if (status === 400 || status === 422) throw new EntryRefusedError();
      throw failure(status, "add");
    },
    async remove(domain, entry, signal) {
      if (
        !BLACKLIST_ENTRY.test(entry) ||
        isDotSegment(entry) ||
        isWildcard(entry) ||
        isDomainWide(entry)
      )
        throw new AdapterError("REJECTED", "entry is not valid for MXroute");
      const { status, response } = await call(
        "DELETE",
        `${base(domain)}/${encodeURIComponent(entry)}`,
        "remove",
        signal,
      );
      await response.body?.cancel();
      if (status === 204 || status === 404) return;
      throw failure(status, "remove");
    },
  };
}
