import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

// Pins the supply-chain decisions of the release workflow (security review 2026-10-27, ADR 0010) as text checks, so an edit that
// undoes one fails here and not silently in a release. No YAML parser: the file is small and its shape is fixed.
const root = new URL("../../../", import.meta.url);
const workflow = readFileSync(new URL(".github/workflows/release.yml", root), "utf8").replaceAll(
  "\r\n",
  "\n",
);
const readme = readFileSync(new URL("README.md", root), "utf8");

/** The text of one top-level job: from `  <name>:` to the next job or the end. */
function job(name: string): string {
  const start = workflow.indexOf(`\n  ${name}:\n`);
  expect(start).toBeGreaterThan(-1);
  const rest = workflow.slice(start + 1);
  const next = rest.slice(1).search(/\n {2}[a-z][a-z-]*:\n/u);
  return next === -1 ? rest : rest.slice(0, next + 1);
}

describe("release workflow", () => {
  it("grants nothing at workflow level, and the signing authority lives in the attest job only", () => {
    expect(workflow).toMatch(/^permissions: \{\}$/mu);
    // Permission lines only (a comment may mention the key).
    const grants = workflow.match(/^\s+id-token: write\b/gmu) ?? [];
    expect(grants).toHaveLength(1);
    expect(job("attest")).toMatch(/^\s+id-token: write\b/mu);
    expect(job("build")).not.toMatch(/^\s+(id-token|attestations):/mu);
  });

  it("runs no install, test or build step in the job that can sign", () => {
    const attest = job("attest");
    expect(attest).not.toMatch(/\bnpm\b|\bnpx\b|setup-node|checkout/u);
    expect(attest).toContain("sha256sum --check SHA256SUMS");
  });

  it("attests only a pushed version tag, never a manual run", () => {
    expect(job("attest")).toMatch(/if: github\.event_name == 'push' && github\.ref_type == 'tag'/u);
    expect(job("attest")).toContain("needs: build");
  });

  it("stops when the tag and the app version differ, passing the tag through env", () => {
    const build = job("build");
    expect(build).toContain("does not match app version");
    expect(build).toMatch(/TAG: \$\{\{ github\.ref_name \}\}/u);
    // never an expression inside a run: line (injection sink)
    expect(build).not.toMatch(/run:.*\$\{\{/u);
  });

  it("restores no npm cache in the release build", () => {
    expect(workflow).not.toMatch(/cache:/u);
  });

  it("pins every action to a full commit SHA", () => {
    const uses = workflow.match(/^\s*- uses: .+$/gmu) ?? [];
    expect(uses.length).toBeGreaterThanOrEqual(5);
    for (const line of uses) expect(line).toMatch(/@[0-9a-f]{40}\s+#\s+v\d/u);
  });

  it("is documented with a verification that pins the workflow, the tag and the runner", () => {
    expect(readme).toContain("--signer-workflow senderban/senderban/.github/workflows/release.yml");
    expect(readme).toContain("--source-ref refs/tags/v");
    expect(readme).toContain("--deny-self-hosted-runners");
  });
});
