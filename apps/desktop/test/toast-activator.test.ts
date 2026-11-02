import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { STORE_TOAST_ACTIVATOR_CLSID } from "../src/toast-activator.js";

const manifest = readFileSync(join(import.meta.dirname, "../build/appx-extensions.xml"), "utf8");
// The manifest writes the id without braces; the app passes it to Electron with them.
const bare = STORE_TOAST_ACTIVATOR_CLSID.replace(/[{}]/gu, "");

describe("the Store toast activator", () => {
  it("is the same class in the code, the toast activation and the COM server of the manifest", () => {
    expect(STORE_TOAST_ACTIVATOR_CLSID).toMatch(/^\{[0-9A-F]{8}(-[0-9A-F]{4}){3}-[0-9A-F]{12}\}$/u);
    expect(manifest).toContain(`ToastActivatorCLSID="${bare}"`);
    expect(manifest).toContain(`<com:Class Id="${bare}"`);
  });

  it("starts the app with the argument the log reads as a cold start", () => {
    expect(manifest).toContain('Arguments="-ToastActivated"');
  });
});
