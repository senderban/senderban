import { z } from "zod";
import { ADDRESS_LIMITS, mailboxKey, parseAddress, validateDomain } from "./address.js";
import { MAIL_SERVERS, MANAGESIEVE_PORT, PRESET_SERVERS, SERVER_PRESETS } from "./mail-server.js";
import { ACCOUNT_ID, MAX_ACCOUNTS } from "./sync/engine.js";

// RFC 1035 §2.3.4: a host name is at most 253 characters of letters, digits, dots and hyphens
// (IDN hosts are given as punycode). Unit: ASCII characters.
const HOST_LENGTH = { min: 1, max: 253 } as const;
const Host = z
  .string()
  .min(HOST_LENGTH.min)
  .max(HOST_LENGTH.max)
  .regex(/^[A-Za-z0-9]([A-Za-z0-9.-]*[A-Za-z0-9])?$/u);
/** A TCP port. Unit: port number. */
const PORT = { min: 1, max: 65_535 } as const;
const Port = z.number().int().min(PORT.min).max(PORT.max);
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

/**
 * What a person types for an MXroute key. A key belongs to the MXroute login, not to a mailbox: every mailbox and domain
 * on that login shares it (ADR 0011). The plaintext key lives only until it is encrypted.
 */
export const MxrouteInputSchema = z.strictObject({
  server: Host,
  username: MxrouteUser,
  apiKey: MxrouteKey,
});
export type MxrouteInput = z.infer<typeof MxrouteInputSchema>;

/** Names one stored key: the login it belongs to. */
export const MxrouteKeyRefSchema = z.strictObject({ server: Host, username: MxrouteUser });
export type MxrouteKeyRef = z.infer<typeof MxrouteKeyRefSchema>;

/** Pause (true) or resume (false) every mail watcher, as the tray's menu does. */
export const WatchPausedSchema = z.boolean();

/** A mail domain as `mailDomain` returns it, valid by the same check (which also refuses capitals). RFC 1035 length. */
const MxrouteDomain = z
  .string()
  .min(HOST_LENGTH.min)
  .max(HOST_LENGTH.max)
  .refine((value) => validateDomain(value) === null, { message: "not a mail domain" });

/** Switching the blacklist of one domain on or off, under one key. */
export const MxrouteEnableSchema = z.strictObject({
  server: Host,
  username: MxrouteUser,
  domain: MxrouteDomain,
  enabled: z.boolean(),
});
export type MxrouteEnableInput = z.infer<typeof MxrouteEnableSchema>;

/**
 * Unit: count. One login per mailbox is the most a person has. A key keeps a domain after its last mailbox left (the
 * blacklist is still there), so the domain count is capped apart from the mailbox count.
 */
export const MXROUTE_KEY_LIMITS = {
  keys: { max: MAX_ACCOUNTS },
  domains: { max: MAX_ACCOUNTS },
} as const;

/** The stored key: ciphertext only. `domains` are the ones it was switched on for at least once, kept off after that. */
const MxrouteStoredKeySchema = z.strictObject({
  server: Host,
  username: MxrouteUser,
  apiKeyCipher: Ciphertext,
  domains: z
    .array(z.strictObject({ domain: MxrouteDomain, enabled: z.boolean() }))
    .max(MXROUTE_KEY_LIMITS.domains.max),
});
export type MxrouteStoredKey = z.infer<typeof MxrouteStoredKeySchema>;

/** `mxroute-keys.json`, next to `accounts.json`, so that removing a mailbox leaves the key alone. */
export const MxrouteKeysFileSchema = z
  .strictObject({
    version: z.literal(1),
    keys: z.array(MxrouteStoredKeySchema).max(MXROUTE_KEY_LIMITS.keys.max),
  })
  .refine(
    (file) => new Set(file.keys.map((k) => `${k.server}|${k.username}`)).size === file.keys.length,
    { message: "duplicate key" },
  )
  // A blacklist has one writer: two keys over one domain would each take the other's entries for their own.
  .refine(
    (file) => {
      const domains = file.keys.flatMap((k) => k.domains.map((d) => d.domain));
      return new Set(domains).size === domains.length;
    },
    { message: "domain on two keys" },
  );

/** The form 0.1.2 and older stored a key in, inside a mailbox. Only read: start-up moves it to `mxroute-keys.json`. */
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
  /** Who runs it. Absent on accounts from before 0.2, when the form made MXroute accounts only. */
  provider: z.enum(MAIL_SERVERS).optional(),
  imap: z.strictObject({ host: Host, port: Port, secure: z.boolean(), user: User }),
  sieve: z.strictObject({ host: Host, port: Port, user: User }),
  passwordCipher: Ciphertext,
  /** Legacy: see `MxrouteConfig`. Nothing writes it any more. */
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

/**
 * A refresh token's ciphertext. Longer than `Ciphertext`: Microsoft's tokens are opaque and may reach MICROSOFT_TOKEN_BYTES.refresh (8 KiB), and
 * base64 of what DPAPI makes of that is about 11 KiB. PROVISIONAL with that limit. Unit: characters.
 */
export const REFRESH_CIPHER_MAX_CHARS = 16_384;
const RefreshCipher = z
  .string()
  .min(1)
  .max(REFRESH_CIPHER_MAX_CHARS)
  .regex(/^[A-Za-z0-9+/]+={0,2}$/u);

/**
 * A Microsoft mailbox (ADR 0013): Outlook.com or Microsoft 365. Only the refresh token is stored, as ciphertext; `refreshCipher` is missing
 * while the account is signed out. The client ID is the app's own, not per account.
 */
export const MicrosoftAccountConfigSchema = z.strictObject({
  id: z.string().regex(ACCOUNT_ID),
  microsoft: z.strictObject({
    email: GmailAddress,
    /** Who signed in, from `/me`: what a re-sign-in is held to, since an address can be reassigned. */
    userId: z
      .string()
      .min(1)
      .max(256)
      .regex(/^[!-~]+$/u),
    refreshCipher: RefreshCipher.optional(),
  }),
});
export type MicrosoftAccountConfig = z.infer<typeof MicrosoftAccountConfigSchema>;

/** Sign in: a new account carries nothing, a re-sign-in names the account. */
export const MicrosoftSignInRequestSchema = GoogleSignInRequestSchema;

/**
 * A mailbox with no rule mechanism a program can reach (iCloud, Yahoo, AOL, GMX): Senderban moves mail itself, over IMAP, while it
 * runs (ADR 0014). `address` is what the person knows it by; `user` is the login, which on iCloud may be only the part before the @.
 */
export const CleanAccountConfigSchema = z.strictObject({
  id: z.string().regex(ACCOUNT_ID),
  clean: z.strictObject({
    address: GmailAddress,
    host: Host,
    port: Port,
    secure: z.boolean(),
    user: User,
  }),
  passwordCipher: Ciphertext,
});
export type CleanAccountConfig = z.infer<typeof CleanAccountConfigSchema>;

export const AccountConfigSchema = z.union([
  ImapAccountConfigSchema,
  GmailAccountConfigSchema,
  MicrosoftAccountConfigSchema,
  CleanAccountConfigSchema,
]);
export type AccountConfig = z.infer<typeof AccountConfigSchema>;

/** Narrows to the IMAP/Sieve kind; every reader of `imap` or `sieve` goes through this. */
export function isImapAccount(account: AccountConfig): account is ImapAccountConfig {
  return "imap" in account;
}

/** Only these mailboxes can have an MXroute key and a blacklist. */
export function isMxrouteAccount(account: ImapAccountConfig): boolean {
  return account.provider === undefined || account.provider === "mxroute";
}

/** Narrows to the Gmail kind. */
export function isGmailAccount(account: AccountConfig): account is GmailAccountConfig {
  return "gmail" in account;
}

/** Narrows to the Microsoft kind. */
export function isMicrosoftAccount(account: AccountConfig): account is MicrosoftAccountConfig {
  return "microsoft" in account;
}

/** Narrows to the kind that moves mail itself. */
export function isCleanAccount(account: AccountConfig): account is CleanAccountConfig {
  return "clean" in account;
}

/** The addresses an account signs in with or receives on, lowercased: two accounts that share one are one mailbox. */
export function accountLogins(account: AccountConfig): string[] {
  if (isImapAccount(account)) {
    return [account.imap.user.toLowerCase(), account.sieve.user.toLowerCase()];
  }
  if (isGmailAccount(account)) return [account.gmail.email];
  if (isMicrosoftAccount(account)) return [account.microsoft.email];
  return [account.clean.address];
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
        if (isImapAccount(a)) for (const login of accountLogins(a)) seen.add(mailboxKey(login));
      }
      for (const a of file.accounts) {
        if (isImapAccount(a)) continue;
        for (const login of accountLogins(a)) {
          const key = mailboxKey(login);
          if (seen.has(key)) return false;
          seen.add(key);
        }
      }
      return true;
    },
    { message: "duplicate mailbox address" },
  );
export type AccountsFile = z.infer<typeof AccountsFileSchema>;

/**
 * The add-account form. The address becomes the account id, so ACCOUNT_ID caps it at 64 characters; a mail address is at least
 * `a@b`. The host is RFC 1035. The password is at most 255 octets (RFC 4616 §2); ManageSieve refuses more, and the schema
 * below counts them, because a multi-byte password has fewer characters than octets.
 */
export const ACCOUNT_ADD_LIMITS = {
  address: { min: 3, max: 64 },
  host: HOST_LENGTH,
  password: { min: 1, max: 255 },
  port: PORT,
} as const;

/** No control characters: a NUL or a line break cannot be sent in a SASL or quoted login, and no real password holds one. */
const Password = z
  .string()
  .min(ACCOUNT_ADD_LIMITS.password.min)
  // Every character is at least one octet: this stops an oversized string before it is scanned and encoded.
  .max(ACCOUNT_ADD_LIMITS.password.max, { abort: true })
  .refine(
    (value) =>
      !/\p{Cc}/u.test(value) &&
      new TextEncoder().encode(value).length <= ACCOUNT_ADD_LIMITS.password.max,
    { message: "password cannot be used" },
  );

/** Lane ids end in these (`<account id>.mxroute`, `.gmail`, `.graph`): an account id ending in one could take another lane's id. */
const LANE_ID_ENDING = /\.(?:mxroute|gmail|graph)$/u;

/** What a person types when adding an account: the plaintext password exists only until it is encrypted. */
export const NewAccountSchema = ImapAccountConfigSchema.omit({
  passwordCipher: true,
  mxroute: true,
}).extend({
  id: z
    .string()
    .regex(ACCOUNT_ID)
    .refine((value) => !LANE_ID_ENDING.test(value), { message: "not an account id" }),
  password: Password,
});
export type NewAccount = z.infer<typeof NewAccountSchema>;

/** Names that never lead to a public mail server (RFC 6762, RFC 6761, RFC 7686, RFC 8375, ICANN's .internal and the usual private ones). */
const PRIVATE_HOST_ENDING =
  /\.(?:local|localhost|localdomain|internal|intranet|lan|home|arpa|corp|svc|onion|test|example|invalid)$/iu;
/** A dot and an alphabetic top label: this also turns away an IP address and a single-label name. */
const PUBLIC_HOST_NAME = /\.(?:[a-z]{2,63}|xn--[a-z0-9-]{1,59})$/iu;

/** The address comes out in the form `parseAddress` returns; an issue never quotes the input. */
const FormAddress = z
  .string()
  .min(ACCOUNT_ADD_LIMITS.address.min)
  .max(ACCOUNT_ADD_LIMITS.address.max)
  .transform((value, ctx) => {
    const parsed = parseAddress(value);
    if (
      parsed.ok &&
      ACCOUNT_ID.test(parsed.value.address) &&
      !LANE_ID_ENDING.test(parsed.value.address)
    ) {
      return parsed.value.address;
    }
    ctx.addIssue({ code: "custom", message: "not a mail address" });
    return z.NEVER;
  });

// Turns away addresses and common private names. A public name may still resolve anywhere: verified TLS and the main
// process's own confirmation are what protect the password.
const FormHost = Host.refine(
  (value) => PUBLIC_HOST_NAME.test(value) && !PRIVATE_HOST_ENDING.test(value),
  {
    message: "not a public host name",
    // Lower case: DNS does not care, and in a dialog a capital I then shows as an i, not as an l.
  },
).transform((value) => value.toLowerCase());

/**
 * The add form. A preset names its server here, in the main process: the page never says where a password goes for those. The port
 * is the page's on every provider, 4190 unless changed: a host running ManageSieve elsewhere is its own choice, and STARTTLS is
 * required on any port. IMAP stays 993 over TLS.
 */
export const AccountAddSchema = z.discriminatedUnion("provider", [
  z.strictObject({
    provider: z.literal("mxroute"),
    address: FormAddress,
    host: FormHost,
    port: Port.optional(),
    password: Password,
  }),
  z.strictObject({
    provider: z.literal("other"),
    address: FormAddress,
    host: FormHost,
    port: Port,
    password: Password,
  }),
  z.strictObject({
    provider: z.enum(PRESET_SERVERS),
    address: FormAddress,
    port: Port.optional(),
    password: Password,
  }),
]);
export type AccountAddInput = z.infer<typeof AccountAddSchema>;

export interface FormServer {
  readonly imapHost: string;
  readonly sieveHost: string;
  readonly sievePort: number;
  /** The provider's name for a preset, null when the person typed the server. */
  readonly presetName: string | null;
}

/** Where this form's password goes: the one answer for the check, the stored account and the confirmation. */
export function formServer(input: AccountAddInput): FormServer {
  if (input.provider === "mxroute" || input.provider === "other") {
    return {
      imapHost: input.host,
      sieveHost: input.host,
      sievePort: input.port ?? MANAGESIEVE_PORT,
      presetName: null,
    };
  }
  const preset = SERVER_PRESETS[input.provider];
  return {
    imapHost: preset.imapHost,
    sieveHost: preset.sieveHost,
    sievePort: input.port ?? MANAGESIEVE_PORT,
    presetName: preset.name,
  };
}

/** Unit: a TCP port, and ASCII characters of a login (RFC 4616 §2, the same bound as `User`). The form's own bounds come from here. */
export const CLEAN_ADD_LIMITS = { port: PORT, login: { min: 1, max: 255 } } as const;

/** A cleaning account as a person types it; the plaintext password exists only until it is encrypted. */
export const NewCleanAccountSchema = CleanAccountConfigSchema.omit({ passwordCipher: true }).extend(
  { password: Password },
);
export type NewCleanAccount = z.infer<typeof NewCleanAccountSchema>;

/** Port of IMAP with STARTTLS (RFC 9051 §2.1); any other port is implicit TLS. Plain IMAP is never spoken on either. */
export const IMAP_STARTTLS_PORT = 143;

/** The "Other (IMAP)" form: nothing is discovered, the person gives the server and port from their provider's page. */
export const CleanAddSchema = z.strictObject({
  address: FormAddress,
  host: FormHost,
  port: Port,
  /** Absent: the address. iCloud's own page names only the part before the @. */
  login: User.optional(),
  password: Password,
});
export type CleanAddInput = z.infer<typeof CleanAddSchema>;

export function cleanAccountFromForm(input: CleanAddInput): NewCleanAccount {
  return NewCleanAccountSchema.parse({
    id: input.address,
    clean: {
      address: input.address,
      host: input.host,
      port: input.port,
      secure: input.port !== IMAP_STARTTLS_PORT,
      user: input.login ?? input.address,
    },
    password: input.password,
  });
}

/** IMAP is always TLS on 993 and the login is the address; a server set up differently goes through `--add-account`. */
export function accountFromForm(input: AccountAddInput): NewAccount {
  const server = formServer(input);
  return NewAccountSchema.parse({
    id: input.address,
    provider: input.provider,
    imap: { host: server.imapHost, port: 993, secure: true, user: input.address },
    sieve: { host: server.sieveHost, port: server.sievePort, user: input.address },
    password: input.password,
  });
}
