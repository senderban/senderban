// Runs every `run:` step of .github/workflows/ci.yml against the committed HEAD in a throwaway
// git worktree, without stopping at the first failure, and prints one list of all failures.
// Uncommitted work is not part of the result on purpose. Steps are read from the workflow file,
// never copied here, so this script cannot drift from CI.
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const repo = execFileSync("git", ["rev-parse", "--show-toplevel"], { encoding: "utf8" }).trim();
const sha = execFileSync("git", ["-C", repo, "rev-parse", "--short", "HEAD"], {
  encoding: "utf8",
}).trim();

const workflow = readFileSync(join(repo, ".github/workflows/ci.yml"), "utf8");
const steps = [];
for (const line of workflow.split("\n")) {
  const m = /^\s*-\s*run:\s*(.+?)\s*$/.exec(line);
  if (m) {
    if (m[1] === "|" || m[1] === ">") throw new Error("multi-line run steps are not supported");
    steps.push(m[1]);
  }
}
if (steps.length === 0) throw new Error("no run steps found in ci.yml");

const work = mkdtempSync(join(tmpdir(), "senderban-ci-"));
const outDir = join(repo, ".ci-local", `${new Date().toISOString().slice(0, 10)}-${sha}`);
mkdirSync(outDir, { recursive: true });

execFileSync("git", ["-C", repo, "worktree", "add", "--detach", work, "HEAD"], { stdio: "ignore" });
const results = [];
try {
  for (const step of steps) {
    const started = Date.now();
    const r = spawnSync(step, {
      cwd: work,
      shell: true,
      encoding: "utf8",
      maxBuffer: 64 * 1024 * 1024,
    });
    const ok = r.status === 0;
    results.push({ step, ok, seconds: Math.round((Date.now() - started) / 1000) });
    if (!ok) writeFileSync(join(outDir, `${results.length}-fail.log`), `${r.stdout}\n${r.stderr}`);
  }
} finally {
  // Windows can hold node_modules files briefly; retry, then drop the stale worktree record.
  rmSync(work, { recursive: true, force: true, maxRetries: 10, retryDelay: 500 });
  execFileSync("git", ["-C", repo, "worktree", "prune"], { stdio: "ignore" });
}

const lines = results.map((r) => `${r.ok ? "PASS" : "FAIL"}  ${r.step}  (${r.seconds}s)`);
writeFileSync(join(outDir, "summary.md"), `# ci-local @ ${sha}\n\n${lines.join("\n")}\n`);
console.log(lines.join("\n"));
console.log(`\nlogs: ${outDir}`);
process.exitCode = results.every((r) => r.ok) ? 0 : 1;
