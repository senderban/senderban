import { z } from "zod";

/**
 * How long a popup stays before it closes by itself. Unit: seconds. Under 3 s a person cannot read
 * a sender and reach a button; over 60 s a popup that nobody wants becomes a permanent overlay.
 */
export const POPUP_SECONDS = { min: 3, max: 60, default: 10 } as const;

export const SettingsSchema = z.strictObject({
  version: z.literal(1),
  popupSeconds: z.number().int().min(POPUP_SECONDS.min).max(POPUP_SECONDS.max),
});
export type Settings = z.infer<typeof SettingsSchema>;

export const DEFAULT_SETTINGS: Settings = { version: 1, popupSeconds: POPUP_SECONDS.default };
