import { describe, expect, it } from "vitest";
import {
  ACTIVATION_ARGUMENTS_MAX,
  DOMAIN_BUTTON_MAX,
  REOPEN_CHOICE,
  TOAST_TEXT_MAX,
  SPAM_HIGH,
  SPAM_MEDIUM,
  buildMailToastXml,
  createActivationSigner,
  escapeXml,
  parseActivation,
  spamLevel,
} from "../../src/notify/toast.js";
import type { MailToast } from "../../src/notify/toast.js";

const ID = "0f8fad5b-d9cb-469f-a165-70867728950e";
const signer = createActivationSigner(Buffer.alloc(32, 7));
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
    expect(xml).toContain(
      '<text hint-style="base" hint-wrap="true" hint-maxLines="2">Hello</text>',
    );
    expect(xml).toContain('<text hint-style="captionSubtle">To: info@example.com</text>');
    expect(xml).toContain('<text hint-style="captionSubtle" hint-align="right">Spam 1.6</text>');
    expect(xml).toContain('<text hint-style="base" hint-align="right">🟢 low</text>');
    expect(xml.match(/<subgroup/gu)).toHaveLength(2);
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

  it("offers Don't ask again last, never as the default", () => {
    for (const shape of [toast(), toast({ rejectsAtServer: true })]) {
      const xml = buildMailToastXml(shape);
      expect(xml).toMatch(/<selection id="quiet" content="Don't ask again"\/><\/input>/u);
      expect(xml).not.toContain('defaultInput="quiet"');
    }
  });

  it("offers Block at server, never as the default, when the server can refuse the sender", () => {
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
    expect(xml).toContain(
      '<text placement="attribution">Gmail has no whole-domain or block-at-server option</text>',
    );
    expect(xml).not.toContain("<input");
    expect(xml).not.toContain("<selection");
    // Our one red button, and "Don't ask again", which has no choice to live in here.
    expect(xml.match(/hint-buttonStyle="Critical"/gu)).toHaveLength(1);
    expect(xml).toContain(`<action content="Don't ask again" arguments="act=quiet;id=${ID}"`);
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
    [`${"b".repeat(20)}.github.io`, `…${"b".repeat(6)}.github.io`],
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
    expect(xml).toContain('<text hint-style="captionSubtle">To: info@example.com</text>');
    expect(xml).not.toContain("Spam");
    expect(xml.match(/<subgroup/gu)).toHaveLength(1);
  });

  it.each([
    [1.6, "low"],
    [SPAM_MEDIUM, "medium"],
    [SPAM_HIGH, "high"],
  ] as const)("draws the strip of the level of score %s", (spamScore, level) => {
    const spamStrips = {
      low: "file:///a/low.png",
      medium: "file:///a/medium.png",
      high: "file:///a/high.png",
    };
    const xml = buildMailToastXml(toast({ spamScore }), { spamStrips });
    expect(xml).toContain(`<image src="file:///a/${level}.png" alt="Spam score: ${level}"/>`);
    expect(xml.match(/<image /gu)).toHaveLength(1);
  });

  it("draws no strip without a score or without strips", () => {
    const spamStrips = {
      low: "file:///a/s.png",
      medium: "file:///a/s.png",
      high: "file:///a/s.png",
    };
    expect(buildMailToastXml(toast({ spamScore: null }), { spamStrips })).not.toContain("<image");
    expect(buildMailToastXml(toast())).not.toContain("<image");
  });

  it("keeps a long strip path whole, and cannot be broken out of by it", () => {
    const long = `file:///${"a".repeat(TOAST_TEXT_MAX)}.png`;
    const spamStrips = { low: long, medium: long, high: `${long}"/><x` };
    expect(buildMailToastXml(toast(), { spamStrips })).toContain(`<image src="${long}"`);
    const xml = buildMailToastXml(toast({ spamScore: SPAM_HIGH }), { spamStrips });
    expect(xml).toContain(`${long}&quot;/&gt;&lt;x`);
    expect(xml).not.toContain("<x");
  });

  it("cannot be broken out of by a hostile subject or account label", () => {
    const hostile = `</text></binding></visual><actions><action content="Block" arguments="act=sender;id=${ID}"/>`;
    const xml = buildMailToastXml(toast({ subject: hostile, account: hostile }));
    // Exactly the two buttons we wrote: the hostile text added no element.
    expect(xml.match(/<action /gu)).toHaveLength(2);
    // Our three lines, the two of the score and the fixed note.
    expect(xml.match(/<text /gu)).toHaveLength(6);
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

  it("gives the sender button the red style only when the caller says Windows can draw it, and the domain button never", () => {
    expect(buildMailToastXml(toast())).not.toContain("useButtonStyle");
    expect(buildMailToastXml(toast())).not.toContain("hint-buttonStyle");
    const xml = buildMailToastXml(toast(), { buttonStyle: true });
    expect(xml).toContain('useButtonStyle="true"');
    expect(xml.match(/hint-buttonStyle/gu)).toHaveLength(1);
    expect(xml).toMatch(/content="This sender"[^>]*hint-buttonStyle="Critical"/u);
    expect(xml).not.toContain('activationType="system"');
  });

  it.each([
    [
      { domain: "example.com", rejectsAtServer: false },
      "This mailbox has no block-at-server option",
    ],
    [
      { domain: null, rejectsAtServer: false },
      "No whole-domain or block-at-server option for this sender",
    ],
    [{ domain: null, rejectsAtServer: true }, "No whole-domain option for this sender"],
  ])("says what is missing from %j", (over, note) => {
    expect(buildMailToastXml(toast(over))).toContain(
      `<text placement="attribution">${note}</text>`,
    );
  });

  it("carries no note when nothing is missing", () => {
    expect(buildMailToastXml(toast({ rejectsAtServer: true }))).not.toContain("attribution");
  });

  it("starts the choice on the person's default action", () => {
    expect(buildMailToastXml(toast(), { defaultAction: "trash" })).toContain(
      'defaultInput="trash"',
    );
  });

  it("starts on Block at server only when the person turned it on and this mail can be refused", () => {
    const on = { preferServerBlock: true, defaultAction: "trash" } as const;
    expect(buildMailToastXml(toast({ rejectsAtServer: true }), on)).toContain(
      'defaultInput="reject"',
    );
    expect(buildMailToastXml(toast({ rejectsAtServer: false }), on)).toContain(
      'defaultInput="trash"',
    );
    expect(buildMailToastXml(toast({ rejectsAtServer: true }))).toContain('defaultInput="junk"');
  });

  it("says a mail is over the person's limit and still starts on the default action", () => {
    const xml = buildMailToastXml(toast({ rejectsAtServer: true, overSpamLimit: true }));
    expect(xml).toContain('defaultInput="junk"');
    expect(xml).toContain('<selection id="reject"');
    expect(xml).toContain("Over your spam limit");
  });

  it("adds what the mailbox cannot offer to the same line", () => {
    const xml = buildMailToastXml(toast({ rejectsAtServer: false, overSpamLimit: true }), {
      defaultAction: "trash",
    });
    expect(xml).toContain('defaultInput="trash"');
    expect(xml).toContain("Over your spam limit. This mailbox has no block-at-server option");
  });

  it("says nothing of a limit for other mail", () => {
    expect(buildMailToastXml(toast({ rejectsAtServer: true }))).not.toContain("spam limit");
  });

  it("leaves the Gmail toast as one button whatever the settings say", () => {
    const xml = buildMailToastXml(toast({ trashOnly: true, domain: null }), {
      defaultAction: "junk",
      preferServerBlock: true,
    });
    expect(xml).toContain('content="Move this sender to Trash"');
    expect(xml).not.toContain("defaultInput");
  });

  it.each(["short", "long"] as const)("keeps a toast on screen for %s", (toastDuration) => {
    for (const shape of [toast(), toast({ trashOnly: true, domain: null })]) {
      expect(buildMailToastXml(shape, { toastDuration })).toContain(
        `<toast duration="${toastDuration}"`,
      );
    }
  });

  it("keeps a toast until it is closed with the reminder scenario, the ordinary sound and no third button", () => {
    const plain = buildMailToastXml(toast(), { toastDuration: "until-closed", buttonStyle: true });
    expect(plain).toContain('<toast scenario="reminder" useButtonStyle="true"');
    expect(plain).not.toContain("duration=");
    expect(plain).toContain(
      '</visual><audio src="ms-winsoundevent:Notification.Default"/><actions>',
    );
    expect(plain.match(/<action /gu)).toHaveLength(2);
    expect(plain).not.toContain('activationType="system"');
    const gmail = buildMailToastXml(toast({ trashOnly: true, domain: null }), {
      toastDuration: "until-closed",
    });
    expect(gmail).toContain('<toast scenario="reminder" launch=');
    expect(gmail).toContain("<audio ");
  });

  it("gives a timed toast no sound of its own", () => {
    expect(buildMailToastXml(toast())).not.toContain("<audio");
  });

  it("ignores a click on the system Dismiss, the toast body or the close button (nothing to do)", () => {
    for (const args of ["dismiss", "", "snooze"]) {
      expect(parseActivation({ arguments: args })).toEqual({ ok: false, reason: "not-a-button" });
    }
  });

  it("shows an empty subject as a placeholder", () => {
    expect(buildMailToastXml(toast({ subject: "" }))).toContain(
      '<text hint-style="base" hint-wrap="true" hint-maxLines="2">(no subject)</text>',
    );
  });
});

describe("the size of a toast", () => {
  it("stays well under what Windows refuses, with hostile text and a long path", () => {
    const hostile = "'".repeat(1_000);
    const long = `file:///${"é".repeat(200)}.png`;
    const xml = buildMailToastXml(
      toast({
        sender: hostile,
        subject: hostile,
        account: hostile,
        domain: hostile,
        rejectsAtServer: true,
      }),
      {
        toastDuration: "until-closed",
        buttonStyle: true,
        spamStrips: { low: long, medium: long, high: long },
      },
    );
    // Measured on Windows 11 (2026-10-31): 10,991 characters showed, 39,991 were refused.
    expect(xml.length).toBeLessThan(5_500);
  });

  it("stays under what Windows was seen to show when every click also carries the longest sender", () => {
    const sender = `${"'".repeat(64)}@${"a".repeat(63)}.${"b".repeat(63)}.${"c".repeat(60)}.example`;
    const hostile = "'".repeat(1_000);
    const xml = buildMailToastXml(
      toast({
        accountId: "a".repeat(64),
        issuedAt: 9_999_999_999,
        sender,
        subject: hostile,
        account: hostile,
        domain: hostile,
        rejectsAtServer: true,
      }),
      {
        toastDuration: "until-closed",
        buttonStyle: true,
        signer,
        spamStrips: {
          low: `file:///${"é".repeat(200)}.png`,
          medium: `file:///${"é".repeat(200)}.png`,
          high: `file:///${"é".repeat(200)}.png`,
        },
      },
    );
    expect(xml).toContain(`;from=${"&apos;".repeat(64)}@`);
    expect(xml.length).toBeLessThan(10_991);
  });
});

describe("spamLevel", () => {
  it("draws the lines at SPAM_MEDIUM and SPAM_HIGH", () => {
    expect(spamLevel(-3)).toBe("low");
    expect(spamLevel(SPAM_MEDIUM - 0.1)).toBe("low");
    expect(spamLevel(SPAM_MEDIUM)).toBe("medium");
    expect(spamLevel(SPAM_HIGH - 0.1)).toBe("medium");
    expect(spamLevel(SPAM_HIGH)).toBe("high");
  });

  it("says the level with a dot and the word, so colour is never the only cue", () => {
    expect(buildMailToastXml(toast({ spamScore: SPAM_MEDIUM }))).toContain(">🟡 medium<");
    expect(buildMailToastXml(toast({ spamScore: SPAM_HIGH }))).toContain(">🔴 high<");
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
    expect(parseActivation(click(`act=open;id=${ID}`, { target: "trash" }))).toEqual({
      ok: true,
      activation: { id: ID, scope: "address", action: REOPEN_CHOICE },
    });
    expect(buildMailToastXml(toast())).toContain(`launch="act=open;id=${ID}"`);
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

  it("falls back to the person's default action when no choice came back", () => {
    expect(parseActivation({ arguments: `act=sender;id=${ID}` }, "trash")).toEqual({
      ok: true,
      activation: { id: ID, scope: "address", action: "trash" },
    });
  });

  it("turns Block at server into the default action on the domain button", () => {
    expect(
      parseActivation(
        { arguments: `act=domain;id=${ID}`, userInputs: { target: "reject" } },
        "trash",
      ),
    ).toEqual({ ok: true, activation: { id: ID, scope: "domain", action: "trash" } });
  });

  it("reads Don't ask again on either button, and it never turns into a block", () => {
    expect(parseActivation(click(`act=sender;id=${ID}`, { target: "quiet" }))).toEqual({
      ok: true,
      activation: { id: ID, scope: "address", action: "quiet" },
    });
    expect(parseActivation(click(`act=domain;id=${ID}`, { target: "quiet" }))).toEqual({
      ok: true,
      activation: { id: ID, scope: "domain", action: "quiet" },
    });
  });

  it("reads Gmail's own Don't ask again button, whatever a choice says", () => {
    expect(parseActivation(click(`act=quiet;id=${ID}`, { target: "reject" }))).toEqual({
      ok: true,
      activation: { id: ID, scope: "address", action: "quiet" },
    });
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

describe("a click that outlives the app", () => {
  const click = (args: string, userInputs?: Record<string, string>) => ({
    type: "click",
    arguments: args,
    ...(userInputs === undefined ? {} : { userInputs }),
  });
  const ACCOUNT = "gmail-bd3565c8.gmail";
  const FROM = "news@example.com";
  const SECONDS = 1_793_631_000;
  const mac = (act: string, id = ID, acct = ACCOUNT, from = FROM, t = SECONDS) =>
    signer.sign(act, id, acct, from, t);
  const tail = (act = "sender") =>
    `;acct=${ACCOUNT};from=${FROM};t=${String(SECONDS)};mac=${mac(act)}`;
  /** Signs a hand-written click the way a toast would, so a refusal is about the part under test and not the missing tag. */
  const signed = (args: string): string => {
    const m = /^act=(\w+);id=([^;]+);acct=([^;]*);from=(.*);t=([^;]*)$/u.exec(args);
    if (m === null) return `${args};mac=${mac("sender")}`;
    const [, act = "", id = "", acct = "", from = "", t = ""] = m;
    return `${args};mac=${mac(act, id, acct, from, Number(t))}`;
  };
  const parse = (args: string) => parseActivation(click(args), undefined, signer);

  it("puts the account, the sender and the time on every button when the caller gave them", () => {
    const xml = buildMailToastXml(toast({ accountId: ACCOUNT, issuedAt: SECONDS }), { signer });
    for (const act of ["sender", "domain"]) {
      expect(xml).toContain(`arguments="act=${act};id=${ID}${tail(act)}"`);
    }
    expect(xml).toContain(`launch="act=open;id=${ID}${tail("open")}"`);
  });

  it("writes no tail when the caller has no signer, so no toast carries a sender it cannot vouch for", () => {
    const xml = buildMailToastXml(toast({ accountId: ACCOUNT, issuedAt: SECONDS }));
    expect(xml).toContain(`arguments="act=sender;id=${ID}"`);
    expect(xml).not.toContain("from=");
    expect(xml).not.toContain("mac=");
  });

  it("escapes a sender that holds & or ' in the attribute, and parses it back", () => {
    const sender = "o'neil&co@example.com";
    const xml = buildMailToastXml(toast({ sender, accountId: ACCOUNT, issuedAt: 1 }), { signer });
    expect(xml).toContain(`from=o&apos;neil&amp;co@example.com;t=1;mac=`);
    expect(parse(signed(`act=sender;id=${ID};acct=${ACCOUNT};from=${sender};t=1`))).toMatchObject({
      ok: true,
      activation: { restore: { sender, issuedAt: 1 } },
    });
  });

  it("leaves the tail off when an account id would make a click the parser refuses", () => {
    const xml = buildMailToastXml(toast({ accountId: "x".repeat(65), issuedAt: 1 }), { signer });
    expect(xml).toContain(`arguments="act=sender;id=${ID}"`);
    expect(xml).not.toContain("acct=");
  });

  it("fits the longest address and account id inside ACTIVATION_ARGUMENTS_MAX", () => {
    const sender = `${"a".repeat(64)}@${"b".repeat(60)}.${"c".repeat(60)}.${"d".repeat(63)}.com`;
    expect(sender).toHaveLength(254);
    const args = signed(`act=domain;id=${ID};acct=${"a".repeat(64)};from=${sender};t=9999999999`);
    expect(args).toHaveLength(420);
    expect(args.length).toBeLessThanOrEqual(ACTIVATION_ARGUMENTS_MAX);
    expect(parse(args).ok).toBe(true);
  });

  it("reads the tail as the restore of the click", () => {
    expect(parse(`act=sender;id=${ID}${tail()}`)).toEqual({
      ok: true,
      activation: {
        id: ID,
        scope: "address",
        action: "junk",
        restore: { accountId: ACCOUNT, sender: FROM, issuedAt: SECONDS },
      },
    });
    expect(parse(`act=quiet;id=${ID}${tail("quiet")}`)).toMatchObject({
      ok: true,
      activation: { action: "quiet", restore: { sender: "news@example.com" } },
    });
  });

  it.each([
    [
      "a sender that is not canonical",
      `act=sender;id=${ID};acct=${ACCOUNT};from=News@Example.com;t=1`,
    ],
    ["a sender with no @", `act=sender;id=${ID};acct=${ACCOUNT};from=nobody;t=1`],
    ["a look-alike domain", `act=sender;id=${ID};acct=${ACCOUNT};from=a@bаnk.com;t=1`],
    ["a part of the tail missing", `act=sender;id=${ID};acct=${ACCOUNT};t=1`],
    [
      "an account id over 64 characters",
      `act=sender;id=${ID};acct=${"a".repeat(65)};from=a@example.com;t=1`,
    ],
    ["an account id with a separator", `act=sender;id=${ID};acct=a;b;from=a@example.com;t=1`],
    ["a time that is not digits", `act=sender;id=${ID};acct=${ACCOUNT};from=a@example.com;t=-1`],
    [
      "a time over 10 digits",
      `act=sender;id=${ID};acct=${ACCOUNT};from=a@example.com;t=12345678901`,
    ],
    ["a second tail", `act=sender;id=${ID}${tail()}${tail()}`],
  ])("refuses %s", (_name, args) => {
    expect(parse(signed(args)).ok).toBe(false);
  });

  describe("the signature", () => {
    const other = createActivationSigner(Buffer.alloc(32, 9));
    const forged = (over: Partial<Record<"act" | "id" | "acct" | "from" | "t", string>> = {}) => {
      const f = { act: "sender", id: ID, acct: ACCOUNT, from: FROM, t: String(SECONDS), ...over };
      // Signed for the original fields, the sent ones changed after: what someone who cannot sign would have to do.
      return `act=${f.act};id=${f.id};acct=${f.acct};from=${f.from};t=${f.t};mac=${mac("sender")}`;
    };

    it("takes a tail only when its tag was made with this key", () => {
      expect(parse(`act=sender;id=${ID}${tail()}`).ok).toBe(true);
      expect(parseActivation(click(`act=sender;id=${ID}${tail()}`), undefined, other)).toEqual({
        ok: false,
        reason: "tail-refused",
      });
    });

    it.each([
      ["a sender changed after signing", { from: "boss@example.com" }],
      ["an account changed after signing", { acct: "other-lane" }],
      ["a time changed after signing", { t: "1793631001" }],
      ["an id changed after signing", { id: "1f8fad5b-d9cb-469f-a165-70867728950e" }],
      ["an action changed after signing", { act: "domain" }],
    ])("refuses %s", (_name, over) => {
      expect(parse(forged(over))).toEqual({ ok: false, reason: "tail-refused" });
    });

    it.each([
      ["a tail with no tag", `act=sender;id=${ID};acct=${ACCOUNT};from=${FROM};t=1`],
      ["a tag that is too short", `act=sender;id=${ID}${tail()}`.slice(0, -2)],
      ["a tag that is not base64url", `act=sender;id=${ID}${tail()}`.slice(0, -1) + "="],
    ])("refuses %s", (_name, args) => {
      expect(parse(args).ok).toBe(false);
    });

    it("hands over no sender when there is no key to check the tail with", () => {
      expect(parseActivation(click(`act=sender;id=${ID}${tail()}`))).toEqual({
        ok: true,
        activation: { id: ID, scope: "address", action: "junk" },
      });
    });

    it("refuses a key that is not 32 bytes", () => {
      expect(() => createActivationSigner(Buffer.alloc(16))).toThrow();
    });
  });
});
