/**
 * What a Store (appx) install leaves out, decided in one place so a test can pin it (FLAG-4 of
 * .task/security-review-release-0-3-0-2026-11-12.md, outside this repo).
 * - The update check: the Store updates the app; asking GitHub would offer a second, different installer.
 * - The sponsor link: a link to a payment page stays out of the Store build until the Store's rules on it are read.
 * - Start at sign-in: a Store package starts at sign-in only through a manifest StartupTask, which it does not declare.
 */
export interface StoreGates {
  readonly storeInstall: boolean;
  readonly updateCheck: boolean;
  readonly sponsorLink: boolean;
  readonly loginItem: boolean;
}

/**
 * Electron types `process.windowsStore` as boolean, but it is undefined outside a Store install (process docs). Only
 * the value `true` counts as a Store install: anything else keeps the installer behaviour.
 */
export function storeGates(windowsStore: unknown): StoreGates {
  const storeInstall = windowsStore === true;
  return {
    storeInstall,
    updateCheck: !storeInstall,
    sponsorLink: !storeInstall,
    loginItem: !storeInstall,
  };
}

/** The part of Electron's `app` the start-at-sign-in switch uses; a test passes a fake. */
export interface LoginItemApi {
  readonly getLoginItemSettings: () => { readonly executableWillLaunchAtLogin: boolean };
  readonly setLoginItemSettings: (settings: { readonly openAtLogin: boolean }) => void;
}

/** Throws before anything opens when a Store install is asked for the sponsor link. */
export function guardHelpTarget(gates: StoreGates, target: string): void {
  if (target === "sponsor" && !gates.sponsorLink) throw new Error("not offered in a Store install");
}

/**
 * `executableWillLaunchAtLogin`, not `openAtLogin`: the latter stays true when the person turned Senderban off in Task
 * Manager > Startup (Electron 45 typings, getLoginItemSettings). null: not offered here, Windows is not asked.
 */
export function readLoginItem(gates: StoreGates, api: LoginItemApi): boolean | null {
  return gates.loginItem ? api.getLoginItemSettings().executableWillLaunchAtLogin : null;
}

/**
 * Writes the switch and reads it back: setLoginItemSettings returns nothing, so a Run key a policy blocks would read as
 * saved. Returns what Windows now says; a Store install throws before Windows is touched.
 */
export function writeLoginItem(gates: StoreGates, api: LoginItemApi, on: boolean): boolean {
  if (!gates.loginItem) throw new Error("start at sign-in is not offered in a Store install");
  api.setLoginItemSettings({ openAtLogin: on });
  return api.getLoginItemSettings().executableWillLaunchAtLogin;
}
