import { z } from "zod";
import type { BlockAction } from "./blocklist.js";

// What the person chose on the Settings page (ADR 0015). Every value is a closed list or a switch, so the bound of each field is the
// list itself. Reversible actions only: "Block at server" is not a default action, it has its own switch that is off (ADR 0008).

/** What a notification's choice starts on. */
export const DEFAULT_ACTIONS = ["junk", "trash"] as const satisfies readonly BlockAction[];
export type DefaultAction = (typeof DEFAULT_ACTIONS)[number];

/**
 * How long a new-mail notification stays on screen: Windows takes these, not seconds (toast schema, Microsoft Learn). Measured on
 * Windows 11 (2026-10-31): `short` closed after 7.9 s, `long` after 27.4 s; `until-closed` (the reminder scenario) was still there at 54 s.
 */
export const TOAST_DURATIONS = ["short", "long", "until-closed"] as const;
export type ToastDuration = (typeof TOAST_DURATIONS)[number];

export const SettingsSchema = z.strictObject({
  defaultAction: z.enum(DEFAULT_ACTIONS),
  /** Starts the choice on "Block at server" where the mailbox offers it. */
  preferServerBlock: z.boolean(),
  /** Shows the notification that says a block worked; a warning or a failure always shows. */
  confirmBlocks: z.boolean(),
  toastDuration: z.enum(TOAST_DURATIONS),
  /** Asks GitHub once a day whether a newer version is out (update.ts). Required here: a save from the page names it. */
  checkUpdates: z.boolean(),
});
export type Settings = z.infer<typeof SettingsSchema>;

/** Start at Windows sign-in, on or off. Windows keeps it, not the settings file (desktop main, `app.setLoginItemSettings`). */
export const LoginItemSchema = z.boolean();

/** Today's behaviour, except `confirmBlocks`: the person asked for it off until they turn it on. */
export const DEFAULT_SETTINGS: Settings = {
  defaultAction: "junk",
  preferServerBlock: false,
  confirmBlocks: false,
  toastDuration: "long",
  checkUpdates: true,
};

export const SettingsFileSchema = z.strictObject({
  version: z.literal(1),
  // A file written before 0.3 has no `checkUpdates`: on. Only the file gets this default, never the IPC save (SettingsSchema).
  settings: SettingsSchema.extend({ checkUpdates: z.boolean().default(true) }),
});
