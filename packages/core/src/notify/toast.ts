import { createHmac, timingSafeEqual } from "node:crypto";
import { z } from "zod";
import { ACTIONS } from "../blocklist.js";
import type { BlockAction } from "../blocklist.js";
import { parseAddress } from "../address.js";
import { isPublicSuffix } from "../freemail.js";
import { DEFAULT_SETTINGS } from "../settings.js";
import type { DefaultAction, Settings } from "../settings.js";
import { BLOCK_SCOPES } from "./block-action.js";
import type { BlockScope } from "./block-action.js";
import { isNotificationId } from "./pending.js";
import { QUIET_CHOICE } from "./quiet.js";

// Native Windows toast (ADR 0007). The toast is built as XML from text that comes from a mail (sender,
// subject) and the click comes back as a string from the OS: both are untrusted, so the XML is escaped
// here and the click is parsed here with strict patterns, in one place, without Electron.

/** Unit: UTF-16 units. A toast line is cut by Windows anyway; this keeps one hostile subject from growing the XML. */
export const TOAST_TEXT_MAX = 200;
/**
 * The longest click: `act=domain;id=<36>;acct=<64>;from=<254>;t=<10 digits>;mac=<22>` = 14 + 36 + 6 + 64 + 6 + 254 + 3 + 10 + 5 + 22 = 420
 * (ACCOUNT_ID is 64 characters, an address at most ADDRESS_LIMITS.totalMax). Anything longer is not ours. Unit: UTF-16 units.
 */
export const ACTIVATION_ARGUMENTS_MAX = 430;

/** Unit: bytes. The key of an `ActivationSigner` (HMAC-SHA-256 takes any length; 32 is the digest size, RFC 2104 section 3). */
export const ACTIVATION_KEY_BYTES = 32;
/** Unit: bytes of the tag kept (128 bits; RFC 2104 section 5 allows truncating to half the digest, no shorter than 80 bits). */
const ACTIVATION_MAC_BYTES = 16;

/**
 * Proves that a click's tail (`acct`, `from`, `t`) was written by this app: a toast outlives the process, so its button carries the
 * sender, and nothing else would tell a forged activation from ours. The key stays on this machine (the desktop keeps it with
 * `safeStorage`); it signs and checks, and the tag hides nothing.
 */
export interface ActivationSigner {
  sign(act: string, id: string, accountId: string, sender: string, issuedAt: number): string;
  verify(
    act: string,
    id: string,
    accountId: string,
    sender: string,
    issuedAt: number,
    mac: string,
  ): boolean;
}

export function createActivationSigner(key: Uint8Array): ActivationSigner {
  if (key.length !== ACTIVATION_KEY_BYTES) throw new Error("activation key must be 32 bytes");
  const tag = (...fields: readonly (string | number)[]): Buffer =>
    // A JSON array keeps the fields apart whatever a sender holds.
    createHmac("sha256", key)
      .update(JSON.stringify(fields))
      .digest()
      .subarray(0, ACTIVATION_MAC_BYTES);
  return {
    sign: (act, id, accountId, sender, issuedAt) =>
      tag(act, id, accountId, sender, issuedAt).toString("base64url"),
    verify: (act, id, accountId, sender, issuedAt, mac) => {
      const given = Buffer.from(mac, "base64url");
      return (
        given.length === ACTIVATION_MAC_BYTES &&
        timingSafeEqual(given, tag(act, id, accountId, sender, issuedAt))
      );
    },
  };
}

export interface MailToast {
  /** Pending-block id; comes back in the click. */
  readonly id: string;
  /**
   * The account's engine id and the second the toast was announced. With both, every button also carries the sender, so a click on this
   * toast after the app was closed (the process that holds `id` is gone) can still be answered. Without them the click is the id alone.
   */
  readonly accountId?: string;
  readonly issuedAt?: number;
  /** Validated lowercase address. */
  readonly sender: string;
  /** Already sanitised by the watcher (control and bidi characters removed). */
  readonly subject: string;
  /** The account the mail arrived in, as the person knows it. */
  readonly account: string;
  /** SpamAssassin points from the server's header, or null. */
  readonly spamScore: number | null;
  /** Domain offered as a second button; null when it must not be offered. */
  readonly domain: string | null;
  /**
   * True when blocking this sender also puts it on a server-side blacklist (MXroute with the key and the
   * switch on), so the mail is refused at the door. False: the only thing Senderban can do is move the
   * mail to a folder, and the toast must not say "block".
   */
  readonly rejectsAtServer: boolean;
  /**
   * True for a Gmail message: a Gmail filter can only move to Trash, so the toast is one "Move this sender to Trash" button (no Junk, no "Block at
   * server"). The click is held to Trash again in `blockPending`, because a click does not have to match what the toast showed.
   */
  readonly trashOnly?: boolean;
  /** At or over the limit the person set for this mailbox, with "ask" as what happens: the toast says so, and nothing more changes. */
  readonly overSpamLimit?: boolean;
}

// XML 1.0 `Char`: everything else (controls, lone surrogates, U+FFFE/U+FFFF) makes the document invalid.
const NOT_XML_CHAR = /[^\t\n\r\u{20}-\u{D7FF}\u{E000}-\u{FFFD}\u{10000}-\u{10FFFF}]/gu;
const ENTITY: Readonly<Record<string, string>> = {
  "&": "&amp;",
  "<": "&lt;",
  ">": "&gt;",
  '"': "&quot;",
  "'": "&apos;",
};

/** Text for an XML text node or attribute value: invalid characters replaced, the five entities escaped. */
function escapeMarkup(text: string): string {
  return text.replace(NOT_XML_CHAR, "�").replace(/[&<>"']/gu, (c) => ENTITY[c] ?? c);
}

/** `escapeMarkup` for text that comes from a mail: bounded. */
export function escapeXml(text: string): string {
  return escapeMarkup(text.slice(0, TOAST_TEXT_MAX));
}

/**
 * Unit: SpamAssassin points. The line under the sender is a colour dot plus the word: at or above SPAM_HIGH the
 * server's own default threshold (SpamAssassin `required_score` 5.0) calls it spam; from SPAM_MEDIUM it is
 * worth a look. MXroute's own drop limit is set in its panel and was not read here. Colour is never the only cue.
 */
export const SPAM_MEDIUM = 2;
export const SPAM_HIGH = 5;

/** The one line a Gmail toast carries about what is missing (a Gmail filter takes single addresses and Trash only, ADR 0009). */
const GMAIL_MISSING_NOTE = "Gmail has no whole-domain or block-at-server option";

/** Marks the sender line: this is the address the buttons act on. A fixed emoji, so it adds no mail text to the XML. */
const SENDER_MARK = "🚫";

/**
 * Characters of a domain on its button. Measured on Windows 11 at 125% (2026-10-30): a toast button shows "All of" and one more line
 * of about 21 characters, and cuts the rest with no ellipsis, so `All of bank.example.attacker.test` read `All of bank.example.attacker`.
 * 16 leaves room for wide letters.
 */
export const DOMAIN_BUTTON_MAX = 16;

/** A long domain keeps its end, with a mark of its own: the end is what tells `paypal.com.attacker.test` from PayPal. */
function domainButtonLabel(domain: string): string {
  if (domain.length <= DOMAIN_BUTTON_MAX) return `All of ${domain}`;
  const tail = domain.slice(-DOMAIN_BUTTON_MAX);
  // From a label's start where two labels stay, so the button never reads a bare `…test` or a suffix like `…co.uk`.
  const whole = tail.slice(tail.indexOf(".") + 1);
  return `All of …${whole.includes(".") && !isPublicSuffix(whole) ? whole : tail}`;
}

export const SPAM_LEVELS = ["low", "medium", "high"] as const;
export type SpamLevel = (typeof SPAM_LEVELS)[number];

export function spamLevel(score: number): SpamLevel {
  return score >= SPAM_HIGH ? "high" : score >= SPAM_MEDIUM ? "medium" : "low";
}

/** Toasts cannot colour text, a dot is the colour that survives; the word is the other cue. */
const SPAM_DOT: Readonly<Record<SpamLevel, string>> = { low: "🟢", medium: "🟡", high: "🔴" };

/**
 * The lines of a toast. Text only takes a style inside a group, so the subject and the account are a column, and the score, when
 * there is one, a second column on the right. The first line stays outside the group: a toast needs one, and Windows draws it as the title.
 */
function textLines(toast: MailToast): string {
  const subject = toast.subject === "" ? "(no subject)" : toast.subject;
  const left =
    `<text hint-style="base" hint-wrap="true" hint-maxLines="2">${escapeXml(subject)}</text>` +
    `<text hint-style="captionSubtle">${escapeXml(`To: ${toast.account}`)}</text>`;
  const score = toast.spamScore;
  const columns =
    score === null
      ? `<subgroup>${left}</subgroup>`
      : `<subgroup hint-weight="3">${left}</subgroup>` +
        `<subgroup hint-weight="1">` +
        `<text hint-style="captionSubtle" hint-align="right">Spam ${String(score)}</text>` +
        // Not a subtle style: Windows would fade the colour of the dot too (measured 2026-10-31).
        `<text hint-style="base" hint-align="right">${SPAM_DOT[spamLevel(score)]} ${spamLevel(score)}</text>` +
        `</subgroup>`;
  // Two lines: the domain is the end of the address, and a long bounce address cut at one line would hide it. The mark is ours, not mail's.
  return `<text hint-maxLines="2">${SENDER_MARK} ${escapeXml(toast.sender)}</text><group>${columns}</group>`;
}

/**
 * What this toast does not offer, in the small line (a toast button cannot be greyed out). The domain is left out because of the
 * sender (a free-mail domain, the person's own), so that half is not said of the mailbox.
 */
function missingNote(toast: MailToast): string | null {
  if (toast.domain === null) {
    return toast.rejectsAtServer
      ? "No whole-domain option for this sender"
      : "No whole-domain or block-at-server option for this sender";
  }
  return toast.rejectsAtServer ? null : "This mailbox has no block-at-server option";
}

/** A person's own limit, so it is said first. */
function noteText(toast: MailToast): string | null {
  const missing = missingNote(toast);
  if (toast.overSpamLimit !== true) return missing;
  return missing === null ? "Over your spam limit" : `Over your spam limit. ${missing}`;
}

/** The small line. Measured on Windows 11 (2026-10-31): Windows draws it under the text, above the choice and the buttons. */
function noteLine(note: string | null): string {
  return note === null ? "" : `<text placement="attribution">${note}</text>`;
}

/**
 * The click value of a button, as an XML attribute value. The id is a checked UUID; the sender (a validated address, which may hold `&` or `'`)
 * and the account are escaped with the rest. Both only go on when the caller gave the account and the time: the toast then outlives the app.
 */
function args(
  act: "sender" | "domain" | "quiet" | "open",
  toast: MailToast,
  signer: ActivationSigner | undefined,
): string {
  const base = `act=${act};id=${toast.id}`;
  const { accountId, issuedAt } = toast;
  // No signer (no key on this machine) means no tail: an earlier run's toast then answers "expired", as it always did.
  if (accountId === undefined || issuedAt === undefined || signer === undefined) return base;
  // A value the click parser would refuse is left off, so a long id never makes a toast whose buttons do nothing.
  if (!ACCOUNT_ARG.test(accountId) || !Number.isSafeInteger(issuedAt) || issuedAt < 0) return base;
  const mac = signer.sign(act, toast.id, accountId, toast.sender, issuedAt);
  const tail = `;acct=${accountId};from=${toast.sender};t=${String(issuedAt)};mac=${mac}`;
  if (`${base}${tail}`.length > ACTIVATION_ARGUMENTS_MAX) return base;
  return escapeMarkup(`${base}${tail}`);
}

/** What a toast needs from the Settings page, and whether this Windows draws styled buttons. */
export interface ToastOptions extends Partial<
  Pick<Settings, "defaultAction" | "preferServerBlock" | "toastDuration">
> {
  readonly buttonStyle?: boolean;
  /** Signs the tail of each click (see `ActivationSigner`); none means a toast whose buttons carry no sender. */
  readonly signer?: ActivationSigner;
  /** `file:` URLs of the coloured strips, one per level; none means a toast with no strip. Never a URL that came from a mail. */
  readonly spamStrips?: Readonly<Record<SpamLevel, string>>;
}

/** The attributes that keep a toast on screen, and the reminder's own sound swapped for the ordinary one: a mail is not an appointment. */
function staying(duration: Settings["toastDuration"]): { open: string; sound: string } {
  return duration === "until-closed"
    ? {
        open: 'scenario="reminder"',
        sound: '<audio src="ms-winsoundevent:Notification.Default"/>',
      }
    : { open: `duration="${duration}"`, sound: "" };
}

/** The coloured line under the text: the level of the score, which the word beside the score says too. */
function stripLine(toast: MailToast, strips: ToastOptions["spamStrips"]): string {
  if (toast.spamScore === null || strips === undefined) return "";
  return `<image src="${escapeMarkup(strips[spamLevel(toast.spamScore)])}" alt="Spam score: ${spamLevel(toast.spamScore)}"/>`;
}

/**
 * `<toast>` with the choice of what happens to future mail and two buttons that say who it applies to. The
 * choice carries the effect, so what is selected is what is done: "Move to Junk" or "Move to
 * Trash" (both keep the mail, K7; the person's default action is selected), and "Block at server", only offered when the server can refuse the sender, and selected only if the person turned that on. The domain button is left out when the domain must not be blocked; a whole domain is never refused at
 * the server, so it always moves to Junk or Trash.
 */
export function buildMailToastXml(toast: MailToast, options: ToastOptions = {}): string {
  if (!isNotificationId(toast.id)) throw new Error("invalid notification id");
  const { defaultAction, preferServerBlock, toastDuration } = { ...DEFAULT_SETTINGS, ...options };
  const styled = options.buttonStyle === true;
  const stay = staying(toastDuration);
  // The red button style needs `useButtonStyle` on the toast (schema, Microsoft Learn: new in Windows 11, so the caller opts in).
  // `launch` is what a click on the toast's body sends: a toast found later in the notification list can still be answered.
  const open = `<toast ${stay.open}${styled ? ' useButtonStyle="true"' : ""} launch="${args("open", toast, options.signer)}">`;
  const critical = styled ? ' hint-buttonStyle="Critical"' : "";
  const lines = textLines(toast);
  const strip = stripLine(toast, options.spamStrips);
  const visual = (note: string | null): string =>
    `<visual><binding template="ToastGeneric">${lines}${noteLine(note)}${strip}</binding></visual>${stay.sound}`;
  // One possible effect needs no choice: a Gmail toast is a single button that says what it does. The click carries no
  // `target`, and `blockPending` holds a Gmail account to Trash whatever the click says.
  if (toast.trashOnly === true) {
    // The toast has no choice to hold "Don't ask again", so it is the second button; the toast's own close button dismisses it.
    return (
      `${open}${visual(GMAIL_MISSING_NOTE)}` +
      `<actions><action content="Move this sender to Trash" arguments="${args("sender", toast, options.signer)}" activationType="foreground"${critical}/>` +
      `<action content="Don't ask again" arguments="${args("quiet", toast, options.signer)}" activationType="foreground"/>` +
      `</actions></toast>`
    );
  }
  const domainButton =
    toast.domain === null
      ? ""
      : `<action content="${escapeXml(domainButtonLabel(toast.domain))}" arguments="${args("domain", toast, options.signer)}" activationType="foreground"/>`;
  // "Block at server" is the one choice that keeps no copy of later mail, so it is listed last and selected only when the person
  // turned that on (ADR 0008).
  const choices: readonly (readonly [string, string])[] = [
    ["junk", "Move to Junk"],
    ["trash", "Move to Trash"],
    ...(toast.rejectsAtServer ? ([["reject", "Block at server"]] as const) : []),
    [QUIET_CHOICE, "Don't ask again"],
  ];
  const selections = choices
    .map(([id, label]) => `<selection id="${id}" content="${label}"/>`)
    .join("");
  const preselected = toast.rejectsAtServer && preferServerBlock ? "reject" : defaultAction;
  return (
    `${open}${visual(noteText(toast))}` +
    `<actions><input id="target" type="selection" defaultInput="${preselected}">${selections}</input>` +
    `<action content="This sender" arguments="${args("sender", toast, options.signer)}" activationType="foreground"${critical}/>` +
    `${domainButton}</actions></toast>`
  );
}

/** What a button carried beyond the id: see `Activation.restore`. */
export interface ActivationRestore {
  readonly accountId: string;
  readonly sender: string;
  readonly issuedAt: number;
}

/** A click on the toast's body: it asks for the buttons, so it blocks nothing. */
export const REOPEN_CHOICE = "reopen";

export interface Activation {
  readonly id: string;
  readonly scope: BlockScope;
  /**
   * `QUIET_CHOICE` puts the sender on the "Don't ask again" list; `REOPEN_CHOICE` shows the toast again. Neither does anything to mail.
   */
  readonly action: BlockAction | typeof QUIET_CHOICE | typeof REOPEN_CHOICE;
  /**
   * What the button itself carried, for a toast that an earlier run announced (see `PendingBlocks.restore`). `sender` is canonical
   * (`parseAddress`), `issuedAt` is epoch seconds. Absent on a button without the tail (an older toast, or a caller that gave no account).
   */
  readonly restore?: ActivationRestore;
}

/** The engine's account id (`ACCOUNT_ID` in sync/engine.ts, kept here so the toast module does not import the engine). */
const ACCOUNT_ARG = /^[A-Za-z0-9._@-]{1,64}$/u;
const ARGUMENTS =
  /^act=(sender|domain|quiet|open);id=([0-9a-f-]{36})(?:;acct=([A-Za-z0-9._@-]{1,64});from=([^;]{1,254});t=([0-9]{1,10});mac=([A-Za-z0-9_-]{22}))?$/u;

/**
 * The tail of a click, or null when there is none (or no key to check it with); `"bad"` when it is there and wrong. A tail is only taken
 * back when its tag was made with this machine's key, so an activation that something else made up never names a sender.
 */
function restoreOf(
  match: RegExpExecArray,
  act: string,
  id: string,
  signer: ActivationSigner | undefined,
): ActivationRestore | null | "bad" {
  const [, , , accountId, from, t, mac] = match;
  if (accountId === undefined || from === undefined || t === undefined || mac === undefined) {
    return null;
  }
  if (signer === undefined) return null;
  const parsed = parseAddress(from);
  // Only the exact form a toast writes: a sender that needed any rewriting did not come from us.
  if (!parsed.ok || parsed.value.address !== from) return "bad";
  const issuedAt = Number(t);
  if (!signer.verify(act, id, accountId, from, issuedAt, mac)) return "bad";
  return { accountId, sender: from, issuedAt };
}

// The envelope comes from the OS and may carry keys we do not know; the two fields we read are bounded.
const Details = z.looseObject({
  arguments: z.string().max(ACTIVATION_ARGUMENTS_MAX),
  userInputs: z.record(z.string().max(32), z.string().max(32)).optional(),
});

export type ActivationResult =
  | { readonly ok: true; readonly activation: Activation }
  | { readonly ok: false; readonly reason: string };

/**
 * A click on a toast -> what to block, or a fixed reason string (never the input). `defaultAction` stands in where no choice can be
 * used: it is reversible, so a click that carries no choice never refuses mail at the server.
 */
export function parseActivation(
  details: unknown,
  defaultAction: DefaultAction = DEFAULT_SETTINGS.defaultAction,
  signer?: ActivationSigner,
): ActivationResult {
  const envelope = Details.safeParse(details);
  if (!envelope.success) return { ok: false, reason: "malformed" };
  const match = ARGUMENTS.exec(envelope.data.arguments);
  const id = match?.[2];
  // A click on Windows' own close button, or on the body of a toast from before `launch`, has no `act=`: nothing to do.
  if (match === null || id === undefined || !isNotificationId(id)) {
    return { ok: false, reason: "not-a-button" };
  }
  const restore = restoreOf(match, match[1] ?? "", id, signer);
  // A real click on a toast whose tail this machine's key does not vouch for (a key made again, an edited tail): the caller says so.
  if (restore === "bad") return { ok: false, reason: "tail-refused" };
  const tail = restore === null ? {} : { restore };
  if (match[1] === "open") {
    return { ok: true, activation: { id, scope: "address", action: REOPEN_CHOICE, ...tail } };
  }
  // Gmail's own button: that toast has no choice.
  if (match[1] === "quiet") {
    return { ok: true, activation: { id, scope: "address", action: QUIET_CHOICE, ...tail } };
  }
  const target = envelope.data.userInputs?.["target"];
  const action =
    target === undefined
      ? defaultAction
      : target === QUIET_CHOICE
        ? QUIET_CHOICE
        : ACTIONS.find((a) => a === target);
  if (action === undefined) return { ok: false, reason: "unknown-choice" };
  const scope: BlockScope = match[1] === "domain" ? "domain" : "address";
  if (!BLOCK_SCOPES.includes(scope)) return { ok: false, reason: "unknown-scope" };
  // "Block at server" is for one address: on the domain button it means the default action, which is reversible.
  return {
    ok: true,
    activation: {
      id,
      scope,
      action: scope === "domain" && action === "reject" ? defaultAction : action,
      ...tail,
    },
  };
}
