import { GOOGLE_AUTH_URL } from "@senderban/core";

/**
 * The one URL the app opens in a browser: Google's consent page, https, no credentials, no port, the fixed path.
 * The sign-in builds it itself; this is the second check at the door of `shell.openExternal`, so a bug upstream
 * (or a value that ever came from a page) cannot open anything else.
 */
export function isGoogleAuthUrl(value: string): boolean {
  return normalizedGoogleAuthUrl(value) !== null;
}

/** The URL as the parser reads it (it drops tabs and line breaks, trims spaces), or null when it is not Google's page. */
function normalizedGoogleAuthUrl(value: string): string | null {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return null;
  }
  const fixed = new URL(GOOGLE_AUTH_URL);
  const ok =
    url.protocol === "https:" &&
    url.hostname === fixed.hostname &&
    url.port === "" &&
    url.username === "" &&
    url.password === "" &&
    url.pathname === fixed.pathname &&
    url.hash === "";
  return ok ? url.href : null;
}

/**
 * `open` is Electron's `shell.openExternal`; a refused URL never reaches it. What reaches it is the checked, parsed
 * form, not the raw string: the parser forgives characters (a tab inside the URL) that the opener might not.
 */
export function openGoogleAuthUrl(open: (url: string) => Promise<void>) {
  return async (url: string): Promise<void> => {
    const checked = normalizedGoogleAuthUrl(url);
    if (checked === null) throw new Error("not Google's consent page");
    await open(checked);
  };
}
