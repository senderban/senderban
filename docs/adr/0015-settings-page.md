# 0015 — Settings page

Status: accepted (2026-10-31). The page and its file are covered by tests. Durations and the toast layout were measured on a
development build, see below; an installed build, a dark Windows theme and Do Not Disturb were not.

## Decision

The manage window gets a **Settings** view with four choices, kept in `settings.json` beside `accounts.json`
(`SettingsSchema`, `apps/desktop/src/settings-file.ts`):

| Choice                                | Values                          | Default | What it changes                                              |
| ------------------------------------- | ------------------------------- | ------- | ------------------------------------------------------------ |
| Default action                        | Junk, Trash                     | Junk    | What a toast starts on, and what a click with no choice does |
| Block at server when the mailbox can  | on, off                         | off     | Starts the toast on "Block at server" where it is offered    |
| Confirm each block                    | on, off                         | off     | The toast that says a block worked                           |
| Keep new-mail notifications on screen | Short, Long, Until I close them | Long    | `duration`, or `scenario="reminder"`, on the toast           |

- **0.3: a fifth choice, Start Senderban when you sign in to Windows, is not in `settings.json`.** Windows keeps it (HKCU Run, Electron
  `app.setLoginItemSettings`); the page reads it from Windows each time (`executableWillLaunchAtLogin`, which also honours Task Manager >
  Startup) and writes it on its own channel (`manage:login-item-save`, `z.boolean()`, sender checked), read back after the write. Off
  unless the person turns it on. Not offered in a Store install (a package starts at sign-in only through a manifest StartupTask).
- **Every field is a closed list or a switch**, so the list is the bound. The page sends the whole object, and main checks it with
  the same strict schema (`manage:settings-save`, sender checked as on every channel).
- **"Confirm each block" off hides success only.** A warning or a failure always shows: `ok` is the one tone that may stay quiet.
  This changes today's behaviour on purpose (owner's request, 2026-10-31); the Blocked senders list still shows the block.
- **Gmail is unaffected** by the default action and the server switch: its toast is one Trash button (ADR 0009).
- **A file that cannot be used falls back to the defaults** with a fixed log reason. A setting is not worth refusing to start for,
  and all the defaults are the reversible choices.

## What Windows allows

Windows draws the toast (ADR 0007): the card, its font and its top row are Windows'. Inside the card there is more room than the first
version used. Measured on Windows 11 build 26200, 1920×1080 at 125%, light theme, Electron 45.1.0, development build (2026-10-31):

- The small note (`placement="attribution"`) sits under the first line and above the group. It cannot go below the buttons.
- The colours of the card follow the person's Windows theme.
- A third button narrows the others: `All of deals.example` read `All of deals.exampl`, so a toast with the domain button carried
  two buttons at most. Amended 2026-11-10 (ADR 0007): no domain goes on a button any more; the toast has up to four fixed one-word
  buttons, and the note is a group of its own under the subject, because an attribution text would stand between the mailbox line and
  the sender. Two rows of the table changed meaning with that: **Default action** is where a whole domain goes when "Block" is pressed
  (and what a click on an older toast does), and **Block at server when the mailbox can** puts the "Block" button on the toast.
- Text takes a style only inside a `<group>` (schema, Microsoft Learn), and that draws: the subject bold, the account subtle, the score
  in a right-hand column. A subtle style fades an emoji too, so the coloured dot sits in the `base` line.
- An image is the one way to put colour on the card. A full-width line (`<image>`, 728×12) reads as a coloured strip. A `hero` image
  fills the top edge to edge, but Windows fixes its height: a 40 and a 364 pixel source both drew about 225 pixels high, on every mail.
  So the toast carries the strip, not the hero.
- If the image file cannot be read, the toast still shows, without the strip.

**The strip is the level of the spam score**: green, yellow or red, `assets/toast/spam-<level>.png`, drawn by `make-icons.mjs`. The word
beside the score says the same, so colour is never the only cue. A server that adds no score of its own lets a sender forge a low one,
which draws green: the strip moves no mail and writes no rule, and any second `X-Spam-Score` line, readable or not, drops the score. The path is ours, never a value from a mail, and no image is fetched
from a remote address. Windows reads the file itself and cannot look inside `app.asar`, hence `asarUnpack` and `spamStripUrls`.

**Until I close them** is `scenario="reminder"`. The reminder's own sound is replaced by the ordinary one (`Notification.Default`,
not heard in a test), because a mail is not an appointment, and no third button is added: the toast has its own close button.
Microsoft's two pages disagree on the condition (the XML schema asks for a background-activated button, the content page of July 2026 for
one button). Measured: our layout with foreground buttons only had no close event in 54 s, and three at once stayed the 52 s of the
frames, while in the same conditions Short closed after 7.9 s and Long after 27.4 s. An earlier run the same day read that none stayed
42 s; the difference is not explained. A run of six showed three at a time, and all were off the screen by 30 s with one close event; a
person was at the desk, so that run proves nothing either way. Three cards fill the right side of a 1080p screen at 125%, which is why
this is a choice and not the default.

**Short and Long** are the schema's two words, with no seconds. The times above are one run each, with `MessageDuration` at 5, the Windows
default. The default stays Long, the value every earlier version sent.

## Scale

Unit = click. One read at start, one small atomic write per change (a page sends one write in flight plus one with the last
choice), no provider call. A toast reads the copy in memory. No timer, no table, no growth. A strip adds one fixed path to the XML
(about 1.3 KB in all) and a file read by Windows, once per toast. Microsoft gives 5 KB for a toast; measured here, 10,991 characters showed and
39,991 were refused, and a test holds the worst case with hostile text under 5,000 characters. A refused toast leaves `toast-refused` in the log. At most 5 toasts per drain per account stays as it was;
Until I close them does not change that count, only how long they stay. A toast can outlive its pending id (24 hours, 200 announcements):
its button then says the message expired. Whether a reminder shows through Do Not Disturb was not measured.
