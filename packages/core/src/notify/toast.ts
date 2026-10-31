import { z } from "zod";
import { ACTIONS } from "../blocklist.js";
import type { BlockAction } from "../blocklist.js";
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
/** A click is `act=sender;id=<36-char uuid>` at most; anything longer is not ours. Unit: UTF-16 units. */
export const ACTIVATION_ARGUMENTS_MAX = 64;

export interface MailToast {
  /** Pending-block id; comes back in the click. */
  readonly id: string;
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

/** The click value of a button. Only `isNotificationId` ids are put here, so nothing needs escaping. */
function args(act: "sender" | "domain" | "quiet", id: string): string {
  return `act=${act};id=${id}`;
}

/** What a toast needs from the Settings page, and whether this Windows draws styled buttons. */
export interface ToastOptions extends Partial<
  Pick<Settings, "defaultAction" | "preferServerBlock" | "toastDuration">
> {
  readonly buttonStyle?: boolean;
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
  const open = `<toast ${stay.open}${styled ? ' useButtonStyle="true"' : ""}>`;
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
      `<actions><action content="Move this sender to Trash" arguments="${args("sender", toast.id)}" activationType="foreground"${critical}/>` +
      `<action content="Don't ask again" arguments="${args("quiet", toast.id)}" activationType="foreground"/>` +
      `</actions></toast>`
    );
  }
  const domainButton =
    toast.domain === null
      ? ""
      : `<action content="${escapeXml(domainButtonLabel(toast.domain))}" arguments="${args("domain", toast.id)}" activationType="foreground"/>`;
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
    `<action content="This sender" arguments="${args("sender", toast.id)}" activationType="foreground"${critical}/>` +
    `${domainButton}</actions></toast>`
  );
}

export interface Activation {
  readonly id: string;
  readonly scope: BlockScope;
  /** `QUIET_CHOICE` puts the sender on the "Don't ask again" list; it does nothing to mail. */
  readonly action: BlockAction | typeof QUIET_CHOICE;
}

const ARGUMENTS = /^act=(sender|domain|quiet);id=([0-9a-f-]{36})$/u;

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
): ActivationResult {
  const envelope = Details.safeParse(details);
  if (!envelope.success) return { ok: false, reason: "malformed" };
  const match = ARGUMENTS.exec(envelope.data.arguments);
  const id = match?.[2];
  // A click on the toast body or on Windows' own close button has no `act=`: nothing to do.
  if (match === null || id === undefined || !isNotificationId(id)) {
    return { ok: false, reason: "not-a-button" };
  }
  // Gmail's own button: that toast has no choice.
  if (match[1] === "quiet") {
    return { ok: true, activation: { id, scope: "address", action: QUIET_CHOICE } };
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
    },
  };
}
