import { z } from "zod";
import { ADDRESS_LIMITS, mailboxKey, parseAddress } from "./address.js";
import { ACCOUNT_ID, MAX_ACCOUNTS } from "./sync/engine.js";

// RFC 1035 §2.3.4: a host name is at most 253 characters of letters, digits, dots and hyphens
// (IDN hosts are given as punycode). Unit: ASCII characters.
const HOST_LENGTH = { min: 1, max: 253 } as const;
const Host = z
  .string()
  .min(HOST_LENGTH.min)
  .max(HOST_LENGTH.max)
  .regex(/^[A-Za-z0-9]([A-Za-z0-9.-]*[A-Za-z0-9])?$/u);
const Port = z.number().int().min(1).max(65_535);
// RFC 4616 §2: a SASL authcid is at most 255 octets; ASCII-only here keeps characters = octets.
const User = z
  .string()
  .min(1)
  .max(255)
  .regex(/^[\x21-\x7e]+$/u);
/** safeStorage ciphertext as base64. Ciphertext only: the plaintext password never reaches this schema. */
const Ciphertext = z
  .string()
  .min(1)
  .max(8192)
  .regex(/^[A-Za-z0-9+/]+={0,2}$/u);

/**
 * MXroute REST API (https://api.mxroute.com/openapi.yaml, read 2026-10-25): `X-Server` is the mail server
 * host name, `X-Username` the DirectAdmin user name (or `reseller|user`), `X-API-Key` the key made on
 * panel.mxroute.com/api-keys.php. Unit: ASCII characters.
 * PROVISIONAL bounds for `username` and `apiKey`: no real value has been measured yet; tighten them to
 * the first real ones (plan .task/mxroute-api-anahtari.md).
 */
export const MXROUTE_LIMITS = {
  server: HOST_LENGTH,
  username: { min: 1, max: 255 },
  apiKey: { min: 8, max: 512 },
} as const;
export const MxrouteUser = z
  .string()
  .min(MXROUTE_LIMITS.username.min)
  .max(MXROUTE_LIMITS.username.max)
  .regex(/^[A-Za-z0-9._|-]+$/u);
/** Printable ASCII without space; the key is a password, so nothing else (CR/LF/NUL would split a header). */
export const MxrouteKey = z
  .string()
  .min(MXROUTE_LIMITS.apiKey.min)
  .max(MXROUTE_LIMITS.apiKey.max)
  .regex(/^[!-~]+$/u);

/** What a person types for one account's MXroute key. The plaintext key lives only until it is encrypted. */
export const MxrouteInputSchema = z.strictObject({
  accountId: z.string().regex(ACCOUNT_ID),
  server: Host,
  username: MxrouteUser,
  apiKey: MxrouteKey,
});
export type MxrouteInput = z.infer<typeof MxrouteInputSchema>;

/** Switching one account's blacklist lane on or off. */
export const MxrouteEnableSchema = z.strictObject({
  accountId: z.string().regex(ACCOUNT_ID),
  enabled: z.boolean(),
});

/** What is stored: the key as safeStorage ciphertext only. */
const MxrouteConfig = z.strictObject({
  server: Host,
  username: MxrouteUser,
  apiKeyCipher: Ciphertext,
  /** Off until the person turns it on: a saved key alone changes nothing about how mail is blocked. */
  enabled: z.boolean().default(false),
});
export type MxrouteConfig = z.infer<typeof MxrouteConfig>;

/** A mailbox reached over IMAP, blocked through ManageSieve (and, optionally, the MXroute blacklist). */
export const ImapAccountConfigSchema = z.strictObject({
  id: z.string().regex(ACCOUNT_ID),
  imap: z.strictObject({ host: Host, port: Port, secure: z.boolean(), user: User }),
  sieve: z.strictObject({ host: Host, port: Port, user: User }),
  passwordCipher: Ciphertext,
  /** Advanced, off by default: lets Senderban ask the MXroute server to refuse a sender at the door. */
  mxroute: MxrouteConfig.optional(),
});
export type ImapAccountConfig = z.infer<typeof ImapAccountConfigSchema>;

/** The login address, in the form `parseAddress` returns (lowercase, punycode): the person knows the account by it. */
const GmailAddress = z
  .string()
  .max(ADDRESS_LIMITS.totalMax)
  .refine((value) => {
    const parsed = parseAddress(value);
    return parsed.ok && parsed.value.address === value;
  });

/**
 * The person's own Google OAuth client (ADR 0009, Data). Unit: ASCII characters. PROVISIONAL until more than one real
 * value is seen: the one made on 2026-10-26 has a 72-character ID and a 35-character secret. The ID shape is Google's
 * documented `<project number>-<random>.apps.googleusercontent.com`; the secret is a password, so printable ASCII
 * without space only (it goes into a form body).
 */
export const GOOGLE_CLIENT_LIMITS = {
  clientId: { min: 1, max: 128 },
  clientSecret: { min: 1, max: 256 },
} as const;
export const GOOGLE_CLIENT_ID_PATTERN = /^[0-9]+-[A-Za-z0-9_]+\.apps\.googleusercontent\.com$/u;
const GoogleClientId = z
  .string()
  .min(GOOGLE_CLIENT_LIMITS.clientId.min)
  .max(GOOGLE_CLIENT_LIMITS.clientId.max)
  .regex(GOOGLE_CLIENT_ID_PATTERN);
/** Printable ASCII without space: the secret is a password and goes into a form body. Shared with the page. */
export const GOOGLE_CLIENT_SECRET_PATTERN = /^[!-~]+$/u;
const GoogleClientSecret = z
  .string()
  .min(GOOGLE_CLIENT_LIMITS.clientSecret.min)
  .max(GOOGLE_CLIENT_LIMITS.clientSecret.max)
  .regex(GOOGLE_CLIENT_SECRET_PATTERN);

/** What a person types for the app-wide Google client. `confirmSignOut`: they were told every Gmail account signs out. */
export const GoogleClientInputSchema = z.strictObject({
  clientId: GoogleClientId,
  clientSecret: GoogleClientSecret,
  confirmSignOut: z.boolean(),
});
export type GoogleClientInput = z.infer<typeof GoogleClientInputSchema>;

/** `google-client.json`, next to `accounts.json`: the ID and the secret as ciphertext only. */
export const GoogleClientFileSchema = z.strictObject({
  version: z.literal(1),
  clientId: GoogleClientId,
  secretCipher: Ciphertext,
});
export type GoogleClientFile = z.infer<typeof GoogleClientFileSchema>;

/** Sign in: a new account carries nothing, a re-sign-in names the account. No URL, no scope, no address from the page. */
export const GoogleSignInRequestSchema = z.strictObject({
  accountId: z.string().regex(ACCOUNT_ID).optional(),
});

/** Seconds since 1970. Unit: seconds. Bounds 2001-09-09 to 2100-01-01: any real expiry date lies inside, a stray number does not. */
const EPOCH_SECONDS = { min: 1_000_000_000, max: 4_102_444_800 } as const;
const EpochSeconds = z.number().int().min(EPOCH_SECONDS.min).max(EPOCH_SECONDS.max);

/**
 * A Gmail mailbox (ADR 0009). Only the refresh token is stored, as ciphertext; the OAuth client ID is app-wide, not
 * per account. `refreshCipher` is missing while the account is signed out (the app-wide client changed, so the old
 * token is revoked and useless): the account and its address stay, the person signs in again.
 */
export const GmailAccountConfigSchema = z.strictObject({
  id: z.string().regex(ACCOUNT_ID),
  gmail: z.strictObject({
    email: GmailAddress,
    refreshCipher: Ciphertext.optional(),
    /** When Google ends a time-limited refresh token ("Testing": 7 days after sign-in); absent when it did not say. */
    accessEndsAt: EpochSeconds.optional(),
  }),
});
export type GmailAccountConfig = z.infer<typeof GmailAccountConfigSchema>;

export const AccountConfigSchema = z.union([ImapAccountConfigSchema, GmailAccountConfigSchema]);
export type AccountConfig = z.infer<typeof AccountConfigSchema>;

/** Narrows to the IMAP/Sieve kind; every reader of `imap` or `sieve` goes through this. */
export function isImapAccount(account: AccountConfig): account is ImapAccountConfig {
  return "imap" in account;
}

/** Narrows to the Gmail kind. */
export function isGmailAccount(account: AccountConfig): account is GmailAccountConfig {
  return "gmail" in account;
}

export const AccountsFileSchema = z
  .strictObject({
    version: z.literal(1),
    accounts: z.array(AccountConfigSchema).max(MAX_ACCOUNTS),
  })
  .refine((file) => new Set(file.accounts.map((a) => a.id)).size === file.accounts.length, {
    message: "duplicate account id",
  })
  // One mailbox, one lane: two lanes over the same Gmail filter set would each see the other's filters as foreign.
  .refine(
    (file) => {
      // Compared by mailbox, not by text: Gmail reads `m.e@gmail.com` and `me@googlemail.com` as `me@gmail.com`.
      const seen = new Set<string>();
      for (const a of file.accounts) {
        if (isImapAccount(a)) {
          for (const login of [a.imap.user, a.sieve.user])
            seen.add(mailboxKey(login.toLowerCase()));
        }
      }
      for (const a of file.accounts) {
        if (isImapAccount(a)) continue;
        const key = mailboxKey(a.gmail.email);
        if (seen.has(key)) return false;
        seen.add(key);
      }
      return true;
    },
    { message: "duplicate mailbox address" },
  );
export type AccountsFile = z.infer<typeof AccountsFileSchema>;

/** What a person types when adding an account: the plaintext password exists only until it is encrypted. */
export const NewAccountSchema = ImapAccountConfigSchema.omit({
  passwordCipher: true,
  mxroute: true,
}).extend({
  password: z.string().min(1).max(255),
});
