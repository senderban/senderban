# 0007 — Native Windows toasts instead of our own popup window

Status: accepted (2026-10-25). Replaces the popup window of ADR 0004. Not yet measured on other Windows builds or with Focus Assist
on.

## Decision

A new mail is announced with a native Windows toast (`Notification` with `toastXml`, `apps/desktop/src/toasts.ts`), not a window
of ours. Windows stacks it with other apps' toasts, honours Focus Assist and keeps it in the Action Center. The toast carries a
selection (what happens to future mail) and the buttons "This sender" and "All of <domain>" ("Whole domain" past 28 characters,
because a button label is cut at its end, the part that tells domains apart). The buttons say who, the selection says what: they do not
say "Block", which would be untrue for Junk and Trash. The click comes back as a string.

- **Untrusted both ways.** The XML is built from mail-controlled text (sender, subject): every text node is escaped and bounded
  (`escapeXml`, `TOAST_TEXT_MAX`). The click is parsed with fixed patterns and a Zod envelope (`parseActivation`) before anything
  runs; a rejected click logs a fixed reason, never the input. Both live in core without Electron (`notify/toast.ts`) and are tested.
- **What is selected is what is done.** The selection offers "Move to Junk" (default), "Move to Trash" and, only when the server can
  refuse the sender (ADR 0008), "Block at server". Buttons say who, the selection says what.
- **Spam score.** The server's own `X-Spam-Score` is shown as a colour dot plus a word (colour is never the only cue). A message with
  more than one score line shows none: a sender can forge the first one.
- **Windows draws it.** Colours, fonts and layout are Windows'. The app name and icon in the toast header come from the app identity
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

- The "popup stays N seconds" setting is removed (2026-10-26): a native toast only knows `short` or `long` (25 s used here),
  and honouring N seconds would need a timer and `close()` per toast (not measured whether `close()` also removes it from
  the Action Center). How long a toast stays is Windows' own setting (Settings > Accessibility > Visual effects > Dismiss
  notifications after; read from memory, not checked on this machine). No settings file remains; a leftover `settings.json` in the user data folder is ignored. ADRs 0004 and 0005 describe the old setting.
- A toast keeps the sender and subject in the Action Center and may show them on the lock screen. Not checked on a machine.
- The old popup's drop counter is gone; the watcher still caps announcements per drain (`DEFAULT_MAX_PER_DRAIN` = 5 per account).

## Scale (derived)

One toast per announced mail, at most 5 per drain per account, 50 accounts: at most 250 toasts per drain, shown by Windows, not by
us. The module keeps at most `MAX_TRACKED` = 50 `Notification` objects and runs no timer.
