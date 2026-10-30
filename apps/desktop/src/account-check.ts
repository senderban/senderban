import { AdapterError, FatalWatchError, isCertificateRefusal } from "@senderban/core";
import type { NewAccount } from "@senderban/core";
import { connectManageSieve, imapflowConnector, isAuthFailure } from "@senderban/core/node";

/** Deadlines of the two logins in the form, as a whole: a click waits 45 s at most, and the socket closes with it. */
export const ACCOUNT_CHECK_IMAP_MS = 30_000;
export const ACCOUNT_CHECK_SIEVE_MS = 15_000;

export type AccountCheckResult =
  "ok" | "login-refused" | "sieve-missing" | "unreachable" | "tls-refused" | "cancelled";

/** One login each; both close again. `signal` ends at the step's deadline or when the person gives up. Only a fake in a test replaces them. */
export interface AccountProbes {
  readonly imap: (account: NewAccount, signal: AbortSignal) => Promise<void>;
  readonly sieve: (account: NewAccount, signal: AbortSignal) => Promise<void>;
}

const liveProbes: AccountProbes = {
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
    void session.close().catch(() => undefined);
  },
};

/** What a step cost, for the log: never the address, the server or an error text. */
export interface AccountCheckStage {
  readonly stage: "imap" | "sieve";
  readonly ms: number;
  readonly timedOut: boolean;
}

export interface AccountCheckOptions {
  /** The person gave up (the window closed). */
  readonly signal?: AbortSignal;
  readonly onStage?: (stage: AccountCheckStage) => void;
}

/** Runs one login under its deadline; the probe's socket closes on the same signal, so nothing goes on behind the answer. */
async function withDeadline(
  stage: AccountCheckStage["stage"],
  run: (signal: AbortSignal) => Promise<void>,
  ms: number,
  options: AccountCheckOptions,
): Promise<void> {
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
    await Promise.race([run(signal), stopped]);
  } finally {
    clearTimeout(timer);
    signal.removeEventListener("abort", onAbort);
    options.onStage?.({ stage, ms: Date.now() - started, timedOut: deadline.signal.aborted });
  }
}

/**
 * Signs in once over IMAP and once over ManageSieve before anything is stored: the watcher and the rules need both, and a
 * wrong password saved here would only show up as a halted watcher after a restart. The answer is a fixed word: an error may
 * quote what the server said.
 */
export async function checkAccount(
  account: NewAccount,
  probes: AccountProbes = liveProbes,
  options: AccountCheckOptions = {},
): Promise<AccountCheckResult> {
  try {
    await withDeadline(
      "imap",
      (signal) => probes.imap(account, signal),
      ACCOUNT_CHECK_IMAP_MS,
      options,
    );
  } catch (error) {
    if (options.signal?.aborted === true) return "cancelled";
    if (isCertificateRefusal(error)) return "tls-refused";
    return error instanceof FatalWatchError && isAuthFailure(error.cause)
      ? "login-refused"
      : "unreachable";
  }
  try {
    await withDeadline(
      "sieve",
      (signal) => probes.sieve(account, signal),
      ACCOUNT_CHECK_SIEVE_MS,
      options,
    );
  } catch (error) {
    if (options.signal?.aborted === true) return "cancelled";
    if (isCertificateRefusal(error)) return "tls-refused";
    return error instanceof AdapterError && error.code === "AUTH_REQUIRED"
      ? "login-refused"
      : "sieve-missing";
  }
  return "ok";
}
