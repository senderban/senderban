// Writes the Google client this installer comes with into apps/desktop/dist/google-client.builtin.json (ADR 0009).
// Run by the release build after `npm run build`, with the pair in the environment. The file is never committed: dist/ is ignored.
// A desktop app is a public client (developers.google.com/identity/protocols/oauth2/native-app), so the pair only has to stay out of
// the repository's history, not out of the installer.
//
// SENDERBAN_GOOGLE_CLIENT_ID / SENDERBAN_GOOGLE_CLIENT_SECRET: the pair. Absent: no file, and the build is "bring your own client".
// SENDERBAN_REQUIRE_GOOGLE_CLIENT=true (a tag build): absent or invalid stops the build, so a release cannot ship without one.
// Nothing here prints the values, and the failure says which of the two is wrong, not what it holds.
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { GoogleClientInputSchema } from "@senderban/core";

const out = join(dirname(fileURLToPath(import.meta.url)), "../dist/google-client.builtin.json");
const required = process.env.SENDERBAN_REQUIRE_GOOGLE_CLIENT === "true";
const clientId = process.env.SENDERBAN_GOOGLE_CLIENT_ID ?? "";
const clientSecret = process.env.SENDERBAN_GOOGLE_CLIENT_SECRET ?? "";

function stop(message) {
  console.error(`write-builtin-client: ${message}`);
  process.exit(required ? 1 : 0);
}

if (clientId === "" && clientSecret === "") {
  stop("no client in the environment, so this build has none of its own");
}

const parsed = GoogleClientInputSchema.pick({ clientId: true, clientSecret: true }).safeParse({
  clientId,
  clientSecret,
});
if (!parsed.success) {
  const wrong = parsed.error.issues.map((issue) => String(issue.path[0])).join(", ");
  stop(`the client is not valid (${wrong})`);
} else {
  mkdirSync(dirname(out), { recursive: true });
  writeFileSync(out, `${JSON.stringify(parsed.data)}\n`, { mode: 0o600 });
  console.log("write-builtin-client: wrote the built-in Google client");
}
