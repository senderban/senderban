import { z } from "zod";
import { ACTIONS } from "../blocklist.js";
import type { BlockAction } from "../blocklist.js";
import { isPublicSuffix } from "../freemail.js";
import { BLOCK_SCOPES } from "./block-action.js";
import type { BlockScope } from "./block-action.js";
import { isNotificationId } from "./pending.js";

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
export function escapeXml(text: string): string {
  return text
    .slice(0, TOAST_TEXT_MAX)
    .replace(NOT_XML_CHAR, "�")
    .replace(/[&<>"']/gu, (c) => ENTITY[c] ?? c);
}

/**
 * Unit: SpamAssassin points. The line under the sender is a colour dot plus the word: at or above SPAM_HIGH the
 * server's own default threshold (SpamAssassin `required_score` 5.0) calls it spam; from SPAM_MEDIUM it is
 * worth a look. MXroute's own drop limit is set in its panel and was not read here. Colour is never the only cue.
 */
export const SPAM_MEDIUM = 2;
export const SPAM_HIGH = 5;

/** The one line a Gmail toast carries about the missing "Whole domain" button (a Gmail filter takes single addresses, ADR 0009). */
const GMAIL_NO_DOMAIN_NOTE = "Gmail has no whole-domain option";

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

/** `🟢 Spam 1.6 · low`: toasts cannot colour text, a dot is the colour that survives; the word is the other cue. */
export function spamLabel(score: number): string {
  const [dot, word] =
    score >= SPAM_HIGH ? ["🔴", "high"] : score >= SPAM_MEDIUM ? ["🟡", "medium"] : ["🟢", "low"];
  return `${dot} Spam ${String(score)} · ${word}`;
}

/** The click value of a button. Only `isNotificationId` ids are put here, so nothing needs escaping. */
function args(act: "sender" | "domain", id: string): string {
  return `act=${act};id=${id}`;
}

/**
 * `<toast>` with the choice of what happens to future mail and two buttons that say who it applies to. The
 * choice carries the effect, so what is selected is what is done: "Move to Junk" (the default) or "Move to
 * Trash" (both keep the mail, K7), and "Block at server", only offered when the server can refuse the sender. The domain button is left out when the domain must not be blocked; a whole domain is never refused at
 * the server, so it always moves to Junk (or Trash when that is chosen).
 */
export function buildMailToastXml(
  toast: MailToast,
  options: { readonly buttonStyle?: boolean } = {},
): string {
  if (!isNotificationId(toast.id)) throw new Error("invalid notification id");
  const subject = toast.subject === "" ? "(no subject)" : toast.subject;
  const score = toast.spamScore === null ? "" : `${spamLabel(toast.spamScore)} · `;
  // Three lines that read apart: the sender (with a "blocked" mark, so the toast says what the buttons do), the subject cut at two
  // lines (a long one used to run into the next line and read as one paragraph), and "To: <account>" so the account is never taken
  // for the end of the subject. The mark is ours, not mail's, so it is not escaped input.
  const lines =
    // Two lines: the domain is the end of the address, and a long bounce address cut at one line would hide it.
    `<text hint-maxLines="2">${SENDER_MARK} ${escapeXml(toast.sender)}</text>` +
    `<text hint-maxLines="2">${escapeXml(subject)}</text>` +
    `<text hint-maxLines="1">${escapeXml(`${score}To: ${toast.account}`)}</text>`;
  // One possible effect needs no choice: a Gmail toast is a single button that says what it does. The click carries no
  // `target`, and `blockPending` holds a Gmail account to Trash whatever the click says.
  if (toast.trashOnly === true) {
    // A toast button cannot be greyed out or carry a caption (App notification content schema, Microsoft Learn), and a button that
    // does nothing would still close the toast. The small attribution line says what is missing instead.
    // The red button style needs `useButtonStyle` on the toast (schema, Microsoft Learn: new in Windows 11, so the caller opts in). The second button is the system's own
    // Dismiss (`activationType="system"`): Windows draws it in the person's language and never calls us.
    const styled = options.buttonStyle === true;
    return (
      `<toast duration="long"${styled ? ' useButtonStyle="true"' : ""}><visual><binding template="ToastGeneric">${lines}` +
      `<text placement="attribution">${GMAIL_NO_DOMAIN_NOTE}</text></binding></visual>` +
      `<actions><action content="Move this sender to Trash" arguments="${args("sender", toast.id)}" activationType="foreground"${styled ? ' hint-buttonStyle="Critical"' : ""}/>` +
      `<action content="" arguments="dismiss" activationType="system"/>` +
      `</actions></toast>`
    );
  }
  const domainButton =
    toast.domain === null
      ? ""
      : `<action content="${escapeXml(domainButtonLabel(toast.domain))}" arguments="${args("domain", toast.id)}" activationType="foreground"/>`;
  // Junk is first and the default: "Block at server" is the one choice that keeps no copy of later mail, so it
  // is listed last and never pre-selected (ADR 0008).
  const choices: readonly (readonly [BlockAction, string])[] = [
    ["junk", "Move to Junk"],
    ["trash", "Move to Trash"],
    ...(toast.rejectsAtServer ? ([["reject", "Block at server"]] as const) : []),
  ];
  const selections = choices
    .map(([id, label]) => `<selection id="${id}" content="${label}"/>`)
    .join("");
  const preselected = choices[0]?.[0] ?? "junk";
  return (
    `<toast duration="long"><visual><binding template="ToastGeneric">${lines}</binding></visual>` +
    `<actions><input id="target" type="selection" defaultInput="${preselected}">${selections}</input>` +
    `<action content="This sender" arguments="${args("sender", toast.id)}" activationType="foreground"/>` +
    `${domainButton}</actions></toast>`
  );
}

export interface Activation {
  readonly id: string;
  readonly scope: BlockScope;
  readonly action: BlockAction;
}

const ARGUMENTS = /^act=(sender|domain);id=([0-9a-f-]{36})$/u;

// The envelope comes from the OS and may carry keys we do not know; the two fields we read are bounded.
const Details = z.looseObject({
  arguments: z.string().max(ACTIVATION_ARGUMENTS_MAX),
  userInputs: z.record(z.string().max(32), z.string().max(32)).optional(),
});

export type ActivationResult =
  | { readonly ok: true; readonly activation: Activation }
  | { readonly ok: false; readonly reason: string };

/** A click on a toast -> what to block, or a fixed reason string (never the input). */
export function parseActivation(details: unknown): ActivationResult {
  const envelope = Details.safeParse(details);
  if (!envelope.success) return { ok: false, reason: "malformed" };
  const match = ARGUMENTS.exec(envelope.data.arguments);
  const id = match?.[2];
  // A click on the toast body or on Windows' own close button has no `act=`: nothing to do.
  if (match === null || id === undefined || !isNotificationId(id)) {
    return { ok: false, reason: "not-a-button" };
  }
  const target = envelope.data.userInputs?.["target"];
  const action = target === undefined ? "junk" : ACTIONS.find((a) => a === target);
  if (action === undefined) return { ok: false, reason: "unknown-choice" };
  const scope: BlockScope = match[1] === "domain" ? "domain" : "address";
  if (!BLOCK_SCOPES.includes(scope)) return { ok: false, reason: "unknown-scope" };
  // "Block at server" is for one address: on the domain button it means Junk, the safe, reversible default.
  return {
    ok: true,
    activation: { id, scope, action: scope === "domain" && action === "reject" ? "junk" : action },
  };
}
