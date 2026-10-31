import {
  AdapterError,
  CleanLink,
  FatalWatchError,
  isCertificateRefusal,
  sieveFit,
} from "@senderban/core";
import type { NewAccount, NewCleanAccount, SieveFit } from "@senderban/core";
import {
  cleanConnector,
  connectManageSieve,
  imapflowConnector,
  isAuthFailure,
  NoStartTlsError,
  probeManageSieve,
} from "@senderban/core/node";

/**
 * Deadlines of the steps in the form, as a whole: a click waits a minute at most, and the socket closes with it. The first
 * step sends no password, so a host without ManageSieve answers before anything of the person's left the device.
 */
export const ACCOUNT_CHECK_REACH_MS = 15_000;
export const ACCOUNT_CHECK_IMAP_MS = 30_000;
export const ACCOUNT_CHECK_SIEVE_MS = 15_000;

export type AccountCheckResult =
  | "ok"
  | "login-refused"
  /** Nothing speaks ManageSieve at that host and port. */
  | "sieve-missing"
  /** ManageSieve answers, but offers no STARTTLS: the password is not sent in clear. */
  | "sieve-no-tls"
  /** ManageSieve answers, but lacks the sign-in or the extensions the rules need. */
  | "sieve-unsupported"
  /** The person has an active script of their own and the server has no `include` to add to it. */
  | "sieve-own-script"
  /** The login worked, but this server cannot take mail out of the Inbox safely. */
  | "cannot-move"
  | "unreachable"
  | "tls-refused"
  | "cancelled";

/** The first step sends nothing of the person's; the other two are one login each, and both close again. `signal` ends at the step's deadline or when the person gives up. Only a fake in a test replaces them. */
export interface AccountProbes {
  readonly reach: (account: NewAccount, signal: AbortSignal) => Promise<SieveFit>;
  readonly imap: (account: NewAccount, signal: AbortSignal) => Promise<void>;
  readonly sieve: (account: NewAccount, signal: AbortSignal) => Promise<SieveFit>;
}

const liveProbes: AccountProbes = {
  reach: async (account, signal) => {
    const { host, port } = account.sieve;
    const server = await probeManageSieve({ host, port, signal });
    return server.plain ? sieveFit(server.extensions, []) : "missing-extensions";
  },
  imap: async (account, signal) => {
    const connect = imapflowConnector({ ...account.imap, password: account.password });
    const session = await connect(signal);
    // The login is the answer: a slow or failed logout neither holds the form up nor fails the check.
    void session.close().catch(() => undefined);
  },
  sieve: async (account, signal) => {
    const session = await connectManageSieve({
      host: account.sieve.host,
      port: account.sieve.port,
      username: account.sieve.user,
      password: account.password,
      signal,
    });
    const onAbort = (): void => {
      session.destroy();
    };
    signal.addEventListener("abort", onAbort, { once: true });
    try {
      return sieveFit(session.extensions(), await session.listScripts());
    } finally {
      signal.removeEventListener("abort", onAbort);
      void session.close().catch(() => undefined);
    }
  },
};

/** What a step cost, for the log: never the address, the server or an error text. */
export interface AccountCheckStage {
  readonly stage: "reach" | "imap" | "sieve";
  readonly ms: number;
  readonly timedOut: boolean;
}

export interface AccountCheckOptions {
  /** The person gave up (the window closed). */
  readonly signal?: AbortSignal;
  readonly onStage?: (stage: AccountCheckStage) => void;
}

/** Runs one login under its deadline; the probe's socket closes on the same signal, so nothing goes on behind the answer. */
async function withDeadline<T>(
  stage: AccountCheckStage["stage"],
  run: (signal: AbortSignal) => Promise<T>,
  ms: number,
  options: AccountCheckOptions,
): Promise<T> {
  const started = Date.now();
  const deadline = new AbortController();
  const timer = setTimeout(() => {
    deadline.abort(new Error("account check timed out"));
  }, ms);
  const signal =
    options.signal === undefined
      ? deadline.signal
      : AbortSignal.any([deadline.signal, options.signal]);
  let onAbort = (): void => undefined;
  const stopped = new Promise<never>((_, reject) => {
    onAbort = () => {
      reject(signal.reason as Error);
    };
    if (signal.aborted) onAbort();
    else signal.addEventListener("abort", onAbort, { once: true });
  });
  try {
    return await Promise.race([run(signal), stopped]);
  } finally {
    clearTimeout(timer);
    signal.removeEventListener("abort", onAbort);
    options.onStage?.({ stage, ms: Date.now() - started, timedOut: deadline.signal.aborted });
  }
}

const FIT_RESULT: Readonly<Record<Exclude<SieveFit, "ok">, AccountCheckResult>> = {
  "missing-extensions": "sieve-unsupported",
  "own-script": "sieve-own-script",
};

/** The fixed word for a failed IMAP login. */
function imapFailure(error: unknown, options: AccountCheckOptions): AccountCheckResult {
  if (options.signal?.aborted === true) return "cancelled";
  if (isCertificateRefusal(error)) return "tls-refused";
  return error instanceof FatalWatchError && isAuthFailure(error.cause)
    ? "login-refused"
    : "unreachable";
}

/** One read-write login that closes again; the answer is whether the server can move mail. Only a fake in a test replaces it. */
export type CleanProbe = (account: NewCleanAccount, signal: AbortSignal) => Promise<boolean>;

const liveCleanProbe: CleanProbe = async (account, signal) => {
  const link = new CleanLink();
  const { host, port, secure, user } = account.clean;
  const connect = cleanConnector({ host, port, secure, user, password: account.password }, link);
  const session = await connect(signal);
  const movable = link.current?.canMove() === true;
  void session.close().catch(() => undefined);
  return movable;
};

/**
 * Signs in once before anything is stored: cleaning needs IMAP only, but it needs the mailbox writable and a server that can move
 * by UID, which a wrong answer here would only show as mail that never moves.
 */
export async function checkCleanAccount(
  account: NewCleanAccount,
  probe: CleanProbe = liveCleanProbe,
  options: AccountCheckOptions = {},
): Promise<AccountCheckResult> {
  const answer = { movable: false };
  try {
    await withDeadline(
      "imap",
      async (signal) => {
        answer.movable = await probe(account, signal);
      },
      ACCOUNT_CHECK_IMAP_MS,
      options,
    );
  } catch (error) {
    return imapFailure(error, options);
  }
  return answer.movable ? "ok" : "cannot-move";
}

/**
 * Asks the ManageSieve port what it is, then signs in once over IMAP and once over ManageSieve before anything is stored: the
 * watcher and the rules need both, and a wrong password saved here would only show up as a halted watcher after a restart.
 * The answer is a fixed word: an error may quote what the server said.
 */
export async function checkAccount(
  account: NewAccount,
  probes: AccountProbes = liveProbes,
  options: AccountCheckOptions = {},
): Promise<AccountCheckResult> {
  try {
    const fit = await withDeadline(
      "reach",
      (signal) => probes.reach(account, signal),
      ACCOUNT_CHECK_REACH_MS,
      options,
    );
    if (fit !== "ok") return FIT_RESULT[fit];
  } catch (error) {
    if (options.signal?.aborted === true) return "cancelled";
    if (isCertificateRefusal(error)) return "tls-refused";
    return error instanceof NoStartTlsError ? "sieve-no-tls" : "sieve-missing";
  }
  try {
    await withDeadline(
      "imap",
      (signal) => probes.imap(account, signal),
      ACCOUNT_CHECK_IMAP_MS,
      options,
    );
  } catch (error) {
    return imapFailure(error, options);
  }
  try {
    const fit = await withDeadline(
      "sieve",
      (signal) => probes.sieve(account, signal),
      ACCOUNT_CHECK_SIEVE_MS,
      options,
    );
    if (fit !== "ok") return FIT_RESULT[fit];
  } catch (error) {
    if (options.signal?.aborted === true) return "cancelled";
    if (isCertificateRefusal(error)) return "tls-refused";
    return error instanceof AdapterError && error.code === "AUTH_REQUIRED"
      ? "login-refused"
      : "sieve-missing";
  }
  return "ok";
}
