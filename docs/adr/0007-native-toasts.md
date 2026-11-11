# 0007 — Native Windows toasts instead of our own popup window

Status: accepted (2026-10-25). Replaces the popup window of ADR 0004. Not yet measured on other Windows builds or with Focus Assist
on.

## Decision

A new mail is announced with a native Windows toast (`Notification` with `toastXml`, `apps/desktop/src/toasts.ts`), not a window
of ours. Windows stacks it with other apps' toasts, honours Focus Assist and keeps it in the Action Center. The toast carries
one button per thing that can happen to the sender's future mail ("Junk", "Trash", "Block" where the server can refuse the sender and the
person switched it on, ADR 0008, and "Mute", ADR 0016) and above them a selection of who it applies to ("Only this sender",
"Whole domain <domain>"), which starts on the sender. Amended 2026-11-10; until then the selection said what and two buttons said who
("This sender", "All of <domain>"), and the domain on a button wrapped to a second line and made both buttons two lines tall. Measured on
Windows 11 build 26200 at 100%, light theme, development build (2026-11-10): the buttons share the width equally; with four, a label of up
to 7 characters stays on one line and 8 ("Not spam") or 9 ("Don't ask") wrap, so every label is a fixed word of at most 7 characters
(`BUTTON_LABEL_MAX`) and no mail text goes on a button. The title line is drawn regular whatever it holds, and without one Windows writes
"New notification"; text is bold only inside a group. So the title is the mailbox ("To: ..."), and the first line of the group is the
sender's domain in bold with the whole address small under it (on a free-mail domain the address is the bold line). The bold line does not
break inside a domain: it showed 32 characters beside the score column and cut the end; the closed selection showed 27 after
"Whole domain " and cut with no ellipsis. Past 24 and 20 characters (`DOMAIN_LINE_MAX`, `DOMAIN_CHOICE_MAX`) the domain keeps its end
behind a mark: `…example.attacker.test`. Not measured: 125% and 150% scaling, dark theme, the installed build, an open selection list.
The domain is offered only when it is nobody's shared space: not a mail provider,
not on the Public Suffix List (ICANN or private section, `tldts`: 19 ms at start-up, about 1.5 µs a check, one check per announced
IMAP mail or domain click, measured 2026-10-31). A button says what it does, so "Block" is only the
button that refuses mail at the server. A click on a toast of an earlier version (`act=sender`, `act=domain` and a `target` input) is
still read, because a toast stays in the notification list. The click comes back as a string.

- **Untrusted both ways.** The XML is built from mail-controlled text (sender, subject): every text node is escaped and bounded
  (`escapeXml`, `TOAST_TEXT_MAX`). The click is parsed with fixed patterns and a Zod envelope (`parseActivation`) before anything
  runs; a rejected click logs a fixed reason, never the input. Both live in core without Electron (`notify/toast.ts`) and are tested.
- **What is selected is what is done**, with one exception: "Block at server" on the domain button is the default action, because a whole
  domain is never refused at the server. The selection offers "Move to Junk", "Move to Trash" (the Settings page picks which one starts selected, ADR 0015) and, only when the server can
  refuse the sender (ADR 0008), "Block at server". Buttons say who, the selection says what.
- **Spam score.** The server's own `X-Spam-Score` is shown as a colour dot plus a word, with a coloured strip for the level (ADR 0015;
  colour is never the only cue). A message with more than one score line shows none: a sender can forge the first one.
- **Windows draws it.** The card, its colours, font and top row are Windows'; what goes inside is ours (ADR 0015). The app name and icon in the toast header come from the app identity
  (`com.senderban.desktop`): an installer must create a Start-menu shortcut that carries it. In development the header reads
  "Electron" until such a shortcut exists.
- **Do not register the identity by hand in development.** Measured 2026-10-26: after a registry key
  `HKCU\Software\Classes\AppUserModelId\com.senderban.desktop` (DisplayName, IconUri) was added, the header read "Senderban" but a
  click on the toast never reached the app (no `toast-activation` log line, no block); after the key was deleted the same click was
  delivered and blocked. A hand-made Start-menu shortcut with the identity had already been deleted
  when the click still failed, so the key is the cause; a shortcut without the key was not tested. Test the identity with the
  installer, not with hand-made keys.
- **Log.** `toast-activation` is written for every click Windows delivers, before the click is parsed; `choice` follows when it ran.
  A toast click with neither line means Windows did not deliver it.

## Cost of the move

- The "popup stays N seconds" setting is removed (2026-10-26): a native toast only knows `short` or `long`, or stays with the reminder
  scenario (ADR 0015, which also times them). Honouring N seconds would need a timer and `close()` per toast, and `close()` removes it
  from the Action Center too (Electron Notification documentation). ADRs 0004 and 0005 describe the old setting.
- A toast keeps the sender and subject in the Action Center and may show them on the lock screen. Not checked on a machine.
- The Action Center keeps at most 20 notifications per app, first in, first out (Microsoft Learn, App notification headers), so
  blocking a missed mail from there works for the last 20.
- The old popup's drop counter is gone; the watcher still caps announcements per drain (`DEFAULT_MAX_PER_DRAIN` = 5 per account).

## Scale (derived)

One toast per announced mail, at most 5 per drain per account, 50 accounts: at most 250 toasts per drain, shown by Windows, not by
us. The module keeps at most `MAX_TRACKED` = 50 `Notification` objects and runs no timer.
