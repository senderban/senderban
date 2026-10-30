import { AdapterError, FatalWatchError } from "@senderban/core";
import type { NewAccount } from "@senderban/core";
import { connectManageSieve, imapflowConnector, isAuthFailure } from "@senderban/core/node";

/** Deadlines of the two logins in the form, as a whole: a click waits 45 s at most. */
export const ACCOUNT_CHECK_IMAP_MS = 30_000;
export const ACCOUNT_CHECK_SIEVE_MS = 15_000;

export type AccountCheckResult = "ok" | "login-refused" | "sieve-missing" | "unreachable";

/** One login each; both close again. Only a fake in a test replaces them. */
export interface AccountProbes {
  readonly imap: (account: NewAccount) => Promise<void>;
  readonly sieve: (account: NewAccount) => Promise<void>;
}

const liveProbes: AccountProbes = {
  imap: async (account) => {
    const connect = imapflowConnector({ ...account.imap, password: account.password });
    const session = await connect(AbortSignal.timeout(ACCOUNT_CHECK_IMAP_MS));
    // The login is the answer: a slow or failed logout neither holds the form up nor fails the check.
    void session.close().catch(() => undefined);
  },
  sieve: async (account) => {
    const session = await connectManageSieve({
      host: account.sieve.host,
      port: account.sieve.port,
      username: account.sieve.user,
      password: account.password,
      signal: AbortSignal.timeout(ACCOUNT_CHECK_SIEVE_MS),
    });
    void session.close().catch(() => undefined);
  },
};

async function withDeadline(work: Promise<void>, ms: number): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      reject(new Error("account check timed out"));
    }, ms);
  });
  try {
    await Promise.race([work, deadline]);
  } finally {
    clearTimeout(timer);
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
): Promise<AccountCheckResult> {
  try {
    await withDeadline(probes.imap(account), ACCOUNT_CHECK_IMAP_MS);
  } catch (error) {
    return error instanceof FatalWatchError && isAuthFailure(error.cause)
      ? "login-refused"
      : "unreachable";
  }
  try {
    await withDeadline(probes.sieve(account), ACCOUNT_CHECK_SIEVE_MS);
  } catch (error) {
    return error instanceof AdapterError && error.code === "AUTH_REQUIRED"
      ? "login-refused"
      : "sieve-missing";
  }
  return "ok";
}
