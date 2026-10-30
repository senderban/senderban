import { describe, expect, it } from "vitest";
import {
  ACTIVATION_ARGUMENTS_MAX,
  DOMAIN_BUTTON_MAX,
  TOAST_TEXT_MAX,
  SPAM_HIGH,
  SPAM_MEDIUM,
  buildMailToastXml,
  escapeXml,
  parseActivation,
  spamLabel,
} from "../../src/notify/toast.js";
import type { MailToast } from "../../src/notify/toast.js";

const ID = "0f8fad5b-d9cb-469f-a165-70867728950e";
const toast = (over: Partial<MailToast> = {}): MailToast => ({
  id: ID,
  sender: "news@example.com",
  subject: "Hello",
  account: "info@example.com",
  spamScore: 1.6,
  domain: "example.com",
  rejectsAtServer: false,
  ...over,
});

describe("escapeXml", () => {
  it("escapes the five XML entities", () => {
    expect(escapeXml(`<a href="x">Tom & 'Jerry'</a>`)).toBe(
      "&lt;a href=&quot;x&quot;&gt;Tom &amp; &apos;Jerry&apos;&lt;/a&gt;",
    );
  });

  it("replaces characters that make an XML 1.0 document invalid", () => {
    expect(escapeXml("a\u0000b\u0008c￾d")).toBe("a�b�c�d");
    expect(escapeXml("lone \uD800 surrogate")).toBe("lone � surrogate");
  });

  it("keeps ordinary text, tabs, newlines and astral characters", () => {
    expect(escapeXml("bücher\t😀\n")).toBe("bücher\t😀\n");
  });

  it("is bounded", () => {
    expect(escapeXml("x".repeat(10_000))).toHaveLength(TOAST_TEXT_MAX);
  });
});

describe("buildMailToastXml", () => {
  it("builds both buttons, the choice and the spam score", () => {
    const xml = buildMailToastXml(toast());
    expect(xml).toContain('<text hint-maxLines="2">🚫 news@example.com</text>');
    expect(xml).toContain('<text hint-maxLines="2">Hello</text>');
    expect(xml).toContain(
      '<text hint-maxLines="1">🟢 Spam 1.6 · low · To: info@example.com</text>',
    );
    expect(xml).toContain(`arguments="act=sender;id=${ID}"`);
    expect(xml).toContain(`arguments="act=domain;id=${ID}"`);
    expect(xml).toContain('defaultInput="junk"');
  });

  it("offers only Junk and Trash, with Junk selected, when nothing can refuse the mail at the server", () => {
    const xml = buildMailToastXml(toast({ rejectsAtServer: false }));
    expect(xml).toContain('<selection id="junk" content="Move to Junk"/>');
    expect(xml).toContain('<selection id="trash" content="Move to Trash"/>');
    expect(xml).toContain('defaultInput="junk"');
    expect(xml).not.toContain('id="reject"');
    expect(xml).not.toContain("Block");
  });

  it("offers Block at server last, never as the default, when the server can refuse the sender", () => {
    const xml = buildMailToastXml(toast({ rejectsAtServer: true }));
    expect(xml).toContain('<selection id="reject" content="Block at server"/>');
    expect(xml.indexOf('id="reject"')).toBeGreaterThan(xml.indexOf('id="trash"'));
    expect(xml).toContain('defaultInput="junk"');
    expect(xml).not.toContain('defaultInput="reject"');
    // Junk and Trash stay: a Junk choice must remain a plain Junk choice.
    expect(xml).toContain('<selection id="junk" content="Move to Junk"/>');
    expect(xml).toContain('<selection id="trash" content="Move to Trash"/>');
  });

  it("shows a Gmail message as one button that says what it does, with no choice (a Gmail filter has no other action)", () => {
    const xml = buildMailToastXml(
      toast({ trashOnly: true, domain: null, rejectsAtServer: false }),
      {
        buttonStyle: true,
      },
    );
    expect(xml).toContain(
      `<action content="Move this sender to Trash" arguments="act=sender;id=${ID}"`,
    );
    expect(xml).toContain('<text placement="attribution">Gmail has no whole-domain option</text>');
    expect(xml).not.toContain("<input");
    expect(xml).not.toContain("<selection");
    // Our one button (red) and the system's own Dismiss, which Windows draws and never reports to us.
    expect(xml).toContain('hint-buttonStyle="Critical"');
    expect(xml).toContain('<action content="" arguments="dismiss" activationType="system"/>');
    expect(xml.match(/<action /gu)).toHaveLength(2);
    // Even if a caller asks for the server or domain button, a trash-only toast does not show them.
    const asked = buildMailToastXml(
      toast({ trashOnly: true, rejectsAtServer: true, domain: "example.com" }),
    );
    expect(asked).not.toContain('id="reject"');
    expect(asked).not.toContain("act=domain");
  });

  it("reads a click on the Gmail button as this sender with no choice (blockPending holds it to Trash)", () => {
    expect(parseActivation({ arguments: `act=sender;id=${ID}` })).toEqual({
      ok: true,
      activation: { id: ID, scope: "address", action: "junk" },
    });
  });

  it("names the buttons by who they apply to, not by what they do", () => {
    const xml = buildMailToastXml(toast());
    expect(xml).toContain('content="This sender"');
    expect(xml).toContain('content="All of example.com"');
    expect(xml).not.toMatch(/<action content="Block/u);
  });

  it("names a short domain in full", () => {
    const fits = `${"a".repeat(DOMAIN_BUTTON_MAX - 8)}.example`;
    expect(fits).toHaveLength(DOMAIN_BUTTON_MAX);
    expect(buildMailToastXml(toast({ domain: fits }))).toContain(`content="All of ${fits}"`);
  });

  it.each([
    ["bank.example.attacker.test", "…attacker.test"],
    ["paypal.com.attacker.test", "…attacker.test"],
    [`${"a".repeat(30)}.test`, `…${"a".repeat(11)}.test`],
    [`mail.${"b".repeat(30)}`, `…${"b".repeat(16)}`],
  ])("keeps the end of the long domain %s, which Windows would cut", (domain, shown) => {
    const xml = buildMailToastXml(toast({ domain }));
    expect(xml).toContain(`content="All of ${shown}"`);
    expect(shown.length).toBeLessThanOrEqual(DOMAIN_BUTTON_MAX + 1);
  });

  it("cannot be broken out of by a domain on the button", () => {
    const xml = buildMailToastXml(toast({ domain: 'a"/><x' }));
    expect(xml).toContain('content="All of a&quot;/&gt;&lt;x"');
    expect(xml).not.toContain("<x");
  });

  it("leaves the domain button out when the domain must not be blocked", () => {
    expect(buildMailToastXml(toast({ domain: null }))).not.toContain("act=domain");
  });

  it("omits the score when the server sent none", () => {
    const xml = buildMailToastXml(toast({ spamScore: null }));
    expect(xml).toContain('<text hint-maxLines="1">To: info@example.com</text>');
    expect(xml).not.toContain("Spam score");
  });

  it("cannot be broken out of by a hostile subject or account label", () => {
    const hostile = `</text></binding></visual><actions><action content="Block" arguments="act=sender;id=${ID}"/>`;
    const xml = buildMailToastXml(toast({ subject: hostile, account: hostile }));
    // Exactly the two buttons we wrote: the hostile text added no element.
    expect(xml.match(/<action /gu)).toHaveLength(2);
    expect(xml.match(/<text /gu)).toHaveLength(3);
    expect(xml).not.toContain(hostile);
  });

  it("refuses an id that is not a notification id", () => {
    expect(() => buildMailToastXml(toast({ id: `${ID}" x="` }))).toThrow();
  });

  it("gives the Gmail toast the red button style only when the caller says Windows can draw it", () => {
    const gmail = toast({ trashOnly: true, domain: null });
    expect(buildMailToastXml(gmail)).not.toContain("useButtonStyle");
    expect(buildMailToastXml(gmail)).not.toContain("hint-buttonStyle");
    expect(buildMailToastXml(gmail, { buttonStyle: true })).toContain('useButtonStyle="true"');
  });

  it("leaves the Gmail extras (attribution, Dismiss, button style) off the other toasts", () => {
    const xml = buildMailToastXml(toast(), { buttonStyle: true });
    expect(xml).not.toContain("attribution");
    expect(xml).not.toContain('activationType="system"');
    expect(xml).not.toContain("useButtonStyle");
  });

  it("ignores a click on the system Dismiss, the toast body or the close button (nothing to do)", () => {
    for (const args of ["dismiss", "", "snooze"]) {
      expect(parseActivation({ arguments: args })).toEqual({ ok: false, reason: "not-a-button" });
    }
  });

  it("shows an empty subject as a placeholder", () => {
    expect(buildMailToastXml(toast({ subject: "" }))).toContain(
      '<text hint-maxLines="2">(no subject)</text>',
    );
  });
});

describe("spamLabel", () => {
  it("says low, medium or high with a dot and the word, so colour is never the only cue", () => {
    expect(spamLabel(-3)).toBe("🟢 Spam -3 · low");
    expect(spamLabel(SPAM_MEDIUM - 0.1)).toContain("· low");
    expect(spamLabel(SPAM_MEDIUM)).toBe("🟡 Spam 2 · medium");
    expect(spamLabel(SPAM_HIGH - 0.1)).toContain("· medium");
    expect(spamLabel(SPAM_HIGH)).toBe("🔴 Spam 5 · high");
  });
});

describe("parseActivation", () => {
  const click = (args: string, userInputs?: Record<string, string>) => ({
    type: "click",
    arguments: args,
    ...(userInputs === undefined ? {} : { userInputs }),
  });

  it("reads the sender button, Junk when no choice came back", () => {
    expect(parseActivation(click(`act=sender;id=${ID}`))).toEqual({
      ok: true,
      activation: { id: ID, scope: "address", action: "junk" },
    });
  });

  it("reads the domain button with the Trash choice", () => {
    expect(parseActivation(click(`act=domain;id=${ID}`, { target: "trash" }))).toEqual({
      ok: true,
      activation: { id: ID, scope: "domain", action: "trash" },
    });
  });

  it("reads Block at server on the sender button", () => {
    expect(parseActivation(click(`act=sender;id=${ID}`, { target: "reject" }))).toEqual({
      ok: true,
      activation: { id: ID, scope: "address", action: "reject" },
    });
  });

  it("turns Block at server into Junk on the domain button: a whole domain is never refused at the server", () => {
    expect(parseActivation(click(`act=domain;id=${ID}`, { target: "reject" }))).toEqual({
      ok: true,
      activation: { id: ID, scope: "domain", action: "junk" },
    });
  });

  it.each([
    ["an empty click (toast body or Windows' own button)", click("")],
    ["an unknown act", click(`act=discard;id=${ID}`)],
    ["a non-uuid id", click("act=sender;id=../../x")],
    ["an uppercase id", click(`act=sender;id=${ID.toUpperCase()}`)],
    ["extra fields in the arguments", click(`act=sender;id=${ID};x=1`)],
    ["an oversize argument", click(`act=sender;id=${ID}${"a".repeat(ACTIVATION_ARGUMENTS_MAX)}`)],
    ["no arguments key", { type: "click" }],
    ["a string instead of an object", "act=sender"],
    ["null", null],
  ])("ignores %s", (_name, details) => {
    expect(parseActivation(details).ok).toBe(false);
  });

  it("refuses a choice that is not Junk or Trash instead of guessing", () => {
    expect(parseActivation(click(`act=sender;id=${ID}`, { target: "discard" }))).toEqual({
      ok: false,
      reason: "unknown-choice",
    });
  });

  it("never puts the input into the reason", () => {
    const result = parseActivation(click("act=sender;id=SECRET-subject-text"));
    expect(result.ok).toBe(false);
    expect(JSON.stringify(result)).not.toContain("SECRET");
  });
});
