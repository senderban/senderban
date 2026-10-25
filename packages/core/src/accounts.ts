import { z } from "zod";
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

export const AccountConfigSchema = z.strictObject({
  id: z.string().regex(ACCOUNT_ID),
  imap: z.strictObject({ host: Host, port: Port, secure: z.boolean(), user: User }),
  sieve: z.strictObject({ host: Host, port: Port, user: User }),
  passwordCipher: Ciphertext,
  /** Advanced, off by default: lets Senderban ask the MXroute server to refuse a sender at the door. */
  mxroute: MxrouteConfig.optional(),
});
export type AccountConfig = z.infer<typeof AccountConfigSchema>;

export const AccountsFileSchema = z
  .strictObject({
    version: z.literal(1),
    accounts: z.array(AccountConfigSchema).max(MAX_ACCOUNTS),
  })
  .refine((file) => new Set(file.accounts.map((a) => a.id)).size === file.accounts.length, {
    message: "duplicate account id",
  });
export type AccountsFile = z.infer<typeof AccountsFileSchema>;

/** What a person types when adding an account: the plaintext password exists only until it is encrypted. */
export const NewAccountSchema = AccountConfigSchema.omit({
  passwordCipher: true,
  mxroute: true,
}).extend({
  password: z.string().min(1).max(255),
});
