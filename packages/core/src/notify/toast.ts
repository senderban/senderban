import { createHmac, timingSafeEqual } from "node:crypto";
import { z } from "zod";
import { ACTIONS } from "../blocklist.js";
import type { BlockAction } from "../blocklist.js";
import { parseAddress } from "../address.js";
import { isFreemail, isPublicSuffix } from "../freemail.js";
import { DEFAULT_SETTINGS } from "../settings.js";
import type { DefaultAction, Settings } from "../settings.js";
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
/** Unit: characters of base64 ciphertext. A hex key of 64 characters encrypts to about 100 on Windows (DPAPI); anything past this is not ours. */
export const ACTIVATION_KEY_CIPHERTEXT_MAX = 2048;

const ActivationKeyFile = z.strictObject({
  version: z.literal(1),
  key: z.string().min(1).max(ACTIVATION_KEY_CIPHERTEXT_MAX),
});

/** The base64 ciphertext of a well-formed key file, or null. The file sits in a folder other software can write to. */
export function parseActivationKeyFile(json: unknown): string | null {
  const parsed = ActivationKeyFile.safeParse(json);
  return parsed.success ? parsed.data.key : null;
}
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
  /** Domain offered in the choice of who the buttons apply to ("Whole domain ..."); null when it must not be offered. */
  readonly domain: string | null;
  /**
   * True when blocking this sender also puts it on a server-side blacklist (MXroute with the key and the
   * switch on), so the mail is refused at the door. False: the only thing Senderban can do is move the
   * mail to a folder, and the toast has no "Block" button.
   */
  readonly rejectsAtServer: boolean;
  /**
   * True for a Gmail message: a Gmail filter can only move to Trash, so the toast has "Trash" and "Mute" and nothing else (no Junk, no
   * "Block", no whole domain). The click is held to Trash again in `blockPending`, because a click does not have to match what the toast showed.
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
 * Unit: characters of a button's label. Measured on Windows 11 at 100% (2026-11-10): four buttons share the width equally, and a label of
 * up to 7 characters ("Silence") stays on one line, while 8 ("Not spam") and 9 ("Don't ask") wrap and make every button of the row two
 * lines tall. So a button carries a fixed word of ours, never text from a mail, and the row is always one line high.
 */
export const BUTTON_LABEL_MAX = 7;

/** The buttons say what happens; "Mute" puts the sender on the "Don't ask again" list (ADR 0016), a name that does not fit a button. */
export const BUTTON_LABELS = {
  junk: "Junk",
  trash: "Trash",
  reject: "Block",
  [QUIET_CHOICE]: "Mute",
} as const;
type ButtonAct = keyof typeof BUTTON_LABELS;

/** The choice that says who a button applies to, and its two values. Without the choice (or without an answer) it is the sender. */
const SCOPE_INPUT = "scope";
const SCOPE_SENDER = "sender";
const SCOPE_DOMAIN = "domain";

/**
 * Unit: characters of a domain. Measured on Windows 11 at 100% (2026-11-10) with a ruler domain: the bold line does not break inside a
 * domain, it shows 32 characters beside the score column and cuts the END, which is the part that matters; the closed choice box shows
 * 27 after "Whole domain " and cuts with no ellipsis. Three quarters of each leaves room for wide letters. Past these the domain keeps
 * its end behind a mark.
 */
export const DOMAIN_LINE_MAX = 24;
export const DOMAIN_CHOICE_MAX = 20;

/** A long domain keeps its end, with a mark of its own: the end is what tells `paypal.com.attacker.test` from PayPal. */
function domainTail(domain: string, max: number): string {
  if (domain.length <= max) return domain;
  const tail = domain.slice(-max);
  // From a label's start where two labels stay, so the line never reads a bare `…test` or a suffix like `…co.uk`.
  const whole = tail.slice(tail.indexOf(".") + 1);
  return `…${whole.includes(".") && !isPublicSuffix(whole) ? whole : tail}`;
}

export const SPAM_LEVELS = ["low", "medium", "high"] as const;
export type SpamLevel = (typeof SPAM_LEVELS)[number];

export function spamLevel(score: number): SpamLevel {
  return score >= SPAM_HIGH ? "high" : score >= SPAM_MEDIUM ? "medium" : "low";
}

/** Toasts cannot colour text, a dot is the colour that survives; the word is the other cue. */
const SPAM_DOT: Readonly<Record<SpamLevel, string>> = { low: "🟢", medium: "🟡", high: "🔴" };

/**
 * Who the mail is from, as the first line of the toast. A toast closed in the notification centre shows only the line outside the group
 * (measured 2026-11-12: a card whose first line was "To: <mailbox>" said nothing of the sender), so the sender is that line. It is the
 * domain, the part of a sender that a long local part cannot dress up, with its end kept where Windows would cut it; on a free-mail domain
 * the address is the identity, so it is the address. That line is drawn regular whatever it holds (measured 2026-11-10). The mark is ours,
 * not mail's.
 */
function senderTitle(sender: string): string {
  const domain = sender.slice(sender.lastIndexOf("@") + 1);
  const identity = isFreemail(domain) ? sender : domainTail(domain, DOMAIN_LINE_MAX);
  return `<text hint-maxLines="2">${SENDER_MARK} ${escapeXml(identity)}</text>`;
}

/**
 * The lines of a toast. The first line stays outside the group: a toast needs one (without it Windows writes "New notification",
 * measured 2026-11-10), and it says who the mail is from. Under it a column: the whole address (not on a free-mail domain, where the
 * first line is the address), the subject and the mailbox the mail came to; the score, when there is one, a second column on the right.
 */
function textLines(toast: MailToast): string {
  const subject = toast.subject === "" ? "(no subject)" : toast.subject;
  const domain = toast.sender.slice(toast.sender.lastIndexOf("@") + 1);
  const address = isFreemail(domain)
    ? ""
    : `<text hint-style="captionSubtle" hint-wrap="true" hint-maxLines="2">${escapeXml(toast.sender)}</text>`;
  const left =
    address +
    `<text hint-style="body" hint-wrap="true" hint-maxLines="2">${escapeXml(subject)}</text>` +
    `<text hint-style="captionSubtle" hint-maxLines="1">${escapeXml(`To: ${toast.account}`)}</text>`;
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
  return `${senderTitle(toast.sender)}<group>${columns}</group>`;
}

/**
 * What this toast does not offer, in the small line (a toast button cannot be greyed out). The domain is left out because of the
 * sender (a free-mail domain, the person's own), so that half is not said of the mailbox. Where both the domain and "Block" are
 * offered, the line says what the two do together: a whole domain is never refused at the server.
 */
function missingNote(
  toast: MailToast,
  offersBlock: boolean,
  defaultAction: DefaultAction,
): string | null {
  if (toast.domain === null) {
    return toast.rejectsAtServer
      ? "No whole-domain option for this sender"
      : "No whole-domain or block-at-server option for this sender";
  }
  if (!toast.rejectsAtServer) return "This mailbox has no block-at-server option";
  // The mailbox could refuse the sender and the person left "Block" off in Settings: nothing is missing from the mailbox.
  if (!offersBlock) return null;
  return `Block is for one sender. A domain moves to ${defaultAction === "trash" ? "Trash" : "Junk"}`;
}

/** A person's own limit, so it is said first. */
function noteText(
  toast: MailToast,
  offersBlock: boolean,
  defaultAction: DefaultAction,
): string | null {
  const missing = missingNote(toast, offersBlock, defaultAction);
  if (toast.overSpamLimit !== true) return missing;
  return missing === null ? "Over your spam limit" : `Over your spam limit. ${missing}`;
}

/**
 * The small line, as a group of its own under the sender and the subject. Measured on Windows 11 (2026-11-10): an attribution text is
 * drawn straight under the first line, so with the mailbox as the first line it would stand between the mailbox and the sender.
 */
function noteLine(note: string | null): string {
  return note === null
    ? ""
    : `<group><subgroup><text hint-style="captionSubtle" hint-wrap="true">${note}</text></subgroup></group>`;
}

/**
 * The click value of a button, as an XML attribute value. The id is a checked UUID; the sender (a validated address, which may hold `&` or `'`)
 * and the account are escaped with the rest. Both only go on when the caller gave the account and the time: the toast then outlives the app.
 */
function args(
  act: ButtonAct | "open",
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
 * `<toast>` with one button per thing that can happen to this sender's future mail, and above them the choice of who it applies to.
 * A button says what it does and does it in one click: "Junk" and "Trash" keep the mail (K7) and "Mute" touches no mail (ADR 0016).
 * "Block" keeps no copy, so it takes two things to be on the toast: a server that can refuse the sender, and the person's own switch
 * on the Settings page (ADR 0008: off by default, so nobody refuses mail by a slip on a button they never asked for). It is the one
 * red button. The choice starts on the sender and is left out when the domain must not be blocked; a whole domain is never refused at
 * the server, so "Block" with the domain chosen moves it to the person's default folder, and the small line says so.
 */
export function buildMailToastXml(toast: MailToast, options: ToastOptions = {}): string {
  if (!isNotificationId(toast.id)) throw new Error("invalid notification id");
  const { defaultAction, preferServerBlock, toastDuration } = { ...DEFAULT_SETTINGS, ...options };
  const offersBlock = toast.rejectsAtServer && preferServerBlock;
  const styled = options.buttonStyle === true;
  const stay = staying(toastDuration);
  // The red button style needs `useButtonStyle` on the toast (schema, Microsoft Learn: new in Windows 11, so the caller opts in).
  // `launch` is what a click on the toast's body sends: a toast found later in the notification list can still be answered.
  const open = `<toast ${stay.open}${styled ? ' useButtonStyle="true"' : ""} launch="${args("open", toast, options.signer)}">`;
  const lines = textLines(toast);
  const strip = stripLine(toast, options.spamStrips);
  const visual = (note: string | null): string =>
    `<visual><binding template="ToastGeneric">${lines}${noteLine(note)}${strip}</binding></visual>${stay.sound}`;
  const button = (act: ButtonAct, style = ""): string =>
    `<action content="${BUTTON_LABELS[act]}" arguments="${args(act, toast, options.signer)}" activationType="foreground"${style}/>`;
  // A Gmail filter has one effect, so its toast has no "Junk" and no "Block", and no choice: a Gmail filter takes single addresses.
  // `blockPending` holds a Gmail account to Trash whatever the click says.
  if (toast.trashOnly === true) {
    return `${open}${visual(GMAIL_MISSING_NOTE)}<actions>${button("trash")}${button(QUIET_CHOICE)}</actions></toast>`;
  }
  const scope =
    toast.domain === null
      ? ""
      : `<input id="${SCOPE_INPUT}" type="selection" defaultInput="${SCOPE_SENDER}">` +
        `<selection id="${SCOPE_SENDER}" content="Only this sender"/>` +
        `<selection id="${SCOPE_DOMAIN}" content="${escapeXml(`Whole domain ${domainTail(toast.domain, DOMAIN_CHOICE_MAX)}`)}"/>` +
        `</input>`;
  // "Block" is the one button that keeps no copy of later mail (ADR 0008): the only red one.
  const block = offersBlock ? button("reject", styled ? ' hint-buttonStyle="Critical"' : "") : "";
  return (
    `${open}${visual(noteText(toast, offersBlock, defaultAction))}` +
    `<actions>${scope}${button("junk")}${button("trash")}${block}${button(QUIET_CHOICE)}</actions></toast>`
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
  /^act=(junk|trash|reject|quiet|open|sender|domain);id=([0-9a-f-]{36})(?:;acct=([A-Za-z0-9._@-]{1,64});from=([^;]{1,254});t=([0-9]{1,10});mac=([A-Za-z0-9_-]{22}))?$/u;

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

/** A click on a toast whose tail this machine's key does not vouch for; the desktop app tells the person nothing was blocked. */
export const TAIL_REFUSED = "tail-refused";

/** Why a click was not acted on: fixed words, never the input. */
export type IgnoredReason =
  "malformed" | "not-a-button" | typeof TAIL_REFUSED | "unknown-choice" | "unknown-scope";

export type ActivationResult =
  | { readonly ok: true; readonly activation: Activation }
  | { readonly ok: false; readonly reason: IgnoredReason };

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
  if (restore === "bad") return { ok: false, reason: TAIL_REFUSED };
  const tail = restore === null ? {} : { restore };
  if (match[1] === "open") {
    return { ok: true, activation: { id, scope: "address", action: REOPEN_CHOICE, ...tail } };
  }
  const inputs = envelope.data.userInputs;
  // A toast of a version before 0.3 (it stays in the notification list): its two buttons said who, and its choice said what.
  if (match[1] === "sender" || match[1] === "domain") {
    const target = inputs?.["target"];
    const action =
      target === undefined
        ? defaultAction
        : target === QUIET_CHOICE
          ? QUIET_CHOICE
          : ACTIONS.find((a) => a === target);
    if (action === undefined) return { ok: false, reason: "unknown-choice" };
    const scope: BlockScope = match[1] === "domain" ? "domain" : "address";
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
  // The button says what; the choice above it says who. No choice (a Gmail toast, a sender whose domain is not offered) is the sender.
  const who = inputs?.[SCOPE_INPUT];
  if (who !== undefined && who !== SCOPE_SENDER && who !== SCOPE_DOMAIN) {
    return { ok: false, reason: "unknown-scope" };
  }
  const scope: BlockScope = who === SCOPE_DOMAIN ? "domain" : "address";
  if (match[1] === QUIET_CHOICE) {
    return { ok: true, activation: { id, scope, action: QUIET_CHOICE, ...tail } };
  }
  const action = ACTIONS.find((a) => a === match[1]);
  if (action === undefined) return { ok: false, reason: "unknown-choice" };
  // "Block" is for one address: with the whole domain chosen it means the default action, which is reversible.
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
