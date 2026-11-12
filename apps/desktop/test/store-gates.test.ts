import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { guardHelpTarget, readLoginItem, storeGates, writeLoginItem } from "../src/store-gates.js";
import type { LoginItemApi } from "../src/store-gates.js";

const STORE = storeGates(true);
const INSTALLER = storeGates(undefined);

function fakeApp(willLaunch: boolean) {
  const api = {
    getLoginItemSettings: vi.fn(() => ({ executableWillLaunchAtLogin: willLaunch })),
    setLoginItemSettings: vi.fn<LoginItemApi["setLoginItemSettings"]>(),
  };
  return api;
}

describe("the Store gates", () => {
  it("leave out the update check, the sponsor link and start at sign-in in a Store install", () => {
    expect(STORE).toEqual({
      storeInstall: true,
      updateCheck: false,
      sponsorLink: false,
      loginItem: false,
    });
  });

  it.each([undefined, false, "true", 1, null])(
    "keep the installer behaviour for windowsStore = %s",
    (value) => {
      expect(storeGates(value)).toEqual({
        storeInstall: false,
        updateCheck: true,
        sponsorLink: true,
        loginItem: true,
      });
    },
  );
});

describe("the sponsor link", () => {
  it("is refused in a Store install", () => {
    expect(() => {
      guardHelpTarget(STORE, "sponsor");
    }).toThrow("not offered in a Store install");
  });

  it.each(["issues", "releases", "website", "logs"])(
    "does not stop the %s target in a Store install",
    (target) => {
      expect(() => {
        guardHelpTarget(STORE, target);
      }).not.toThrow();
    },
  );

  it("opens from the installer", () => {
    expect(() => {
      guardHelpTarget(INSTALLER, "sponsor");
    }).not.toThrow();
  });
});

describe("start at sign-in", () => {
  it("is not read from Windows in a Store install", () => {
    const app = fakeApp(true);
    expect(readLoginItem(STORE, app)).toBeNull();
    expect(app.getLoginItemSettings).not.toHaveBeenCalled();
  });

  it("is never written in a Store install", () => {
    const app = fakeApp(true);
    expect(() => writeLoginItem(STORE, app, true)).toThrow(
      "start at sign-in is not offered in a Store install",
    );
    expect(app.setLoginItemSettings).not.toHaveBeenCalled();
    expect(app.getLoginItemSettings).not.toHaveBeenCalled();
  });

  it("reads executableWillLaunchAtLogin from the installer", () => {
    expect(readLoginItem(INSTALLER, fakeApp(false))).toBe(false);
    expect(readLoginItem(INSTALLER, fakeApp(true))).toBe(true);
  });

  it("writes from the installer and answers what Windows reads back", () => {
    const app = fakeApp(false);
    expect(writeLoginItem(INSTALLER, app, true)).toBe(false);
    expect(app.setLoginItemSettings).toHaveBeenCalledExactlyOnceWith({ openAtLogin: true });
  });
});

// main.ts imports Electron and does not load under vitest, so its wiring is pinned by text. These pins break on a reformat of
// the pinned lines: then read the new lines and pin them again, do not delete the check.
const main = readFileSync(join(import.meta.dirname, "../src/main.ts"), "utf8");
const manage = readFileSync(join(import.meta.dirname, "../assets/manage/manage.js"), "utf8");
const settingsView = readFileSync(
  join(import.meta.dirname, "../assets/manage/settings.js"),
  "utf8",
);

describe("main.ts applies every Store gate", () => {
  it("reads process.windowsStore only through storeGates", () => {
    expect(main).toContain(
      "const STORE = storeGates((process as { readonly windowsStore?: unknown }).windowsStore);",
    );
    expect(main).not.toMatch(/process\.windowsStore|STORE_INSTALL/u);
  });

  it("never asks GitHub for updates in a Store install", () => {
    expect(main).toContain("enabled: () => settings.current.checkUpdates && STORE.updateCheck,");
    expect(main).toContain("if (STORE.updateCheck) void updates.start();");
  });

  it("guards the help target before anything opens", () => {
    expect(main).toMatch(
      /guardHelpTarget\(STORE, target\);\s+if \(target !== "logs"\) \{\s+await shell\.openExternal/u,
    );
  });

  it("reads and writes start at sign-in only through the gate", () => {
    expect(main).toContain("loginItem: () => readLoginItem(STORE, app),");
    expect(main).toContain("const now = writeLoginItem(STORE, app, on);");
    expect(main).not.toMatch(/app\.(get|set)LoginItemSettings\(/u);
  });

  it("tells the manage window it is a Store install, which hides the update card, the sponsor link and the startup card", () => {
    expect(main).toContain("storeManaged: STORE.storeInstall,");
    expect(manage).toContain("els.updatesCard.hidden = watch.storeManaged === true;");
    expect(manage).toContain("els.navSponsor.hidden = watch.storeManaged === true;");
    expect(settingsView).toContain('stEls.startupCard.hidden = typeof on !== "boolean";');
  });
});
