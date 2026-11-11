import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

// The scripts of the sandboxed pages draw mail headers (untrusted) and names from the main process. Every one of them
// writes text with textContent and builds nodes with createElement; none may gain a sink that reads a string as markup,
// style or a location. A few dozen small files, read once.
const assets = join(import.meta.dirname, "..", "assets");

function pageScripts(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) return pageScripts(full);
    return entry.name.endsWith(".js") ? [full] : [];
  });
}

const SINKS =
  /innerHTML|outerHTML|insertAdjacentHTML|document\.write|\beval\(|new Function|setAttribute\(\s*["'`](?:style|href|src|srcdoc|on[a-z]+)["'`]/u;

describe("the page scripts", () => {
  const scripts = pageScripts(assets);

  it("are found", () => {
    expect(scripts.some((file) => file.endsWith("manage.js"))).toBe(true);
    expect(scripts.some((file) => file.endsWith("quiet.js"))).toBe(true);
  });

  it.each(scripts)("%s writes text and builds nodes, never markup, style or a location", (file) => {
    expect(readFileSync(file, "utf8")).not.toMatch(SINKS);
  });
});
