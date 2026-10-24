import { z } from "zod";
import { ACCOUNT_ID, MAX_ACCOUNTS } from "./sync/engine.js";

// RFC 1035 §2.3.4: a host name is at most 253 characters of letters, digits, dots and hyphens
// (IDN hosts are given as punycode). Unit: ASCII characters.
const Host = z
  .string()
  .min(1)
  .max(253)
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

export const AccountConfigSchema = z.strictObject({
  id: z.string().regex(ACCOUNT_ID),
  imap: z.strictObject({ host: Host, port: Port, secure: z.boolean(), user: User }),
  sieve: z.strictObject({ host: Host, port: Port, user: User }),
  passwordCipher: Ciphertext,
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
export const NewAccountSchema = AccountConfigSchema.omit({ passwordCipher: true }).extend({
  password: z.string().min(1).max(255),
});
