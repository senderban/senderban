// Gmail section of the sandboxed manage page: the app-wide Google client and the Gmail accounts. The client secret
// is typed here, sent once to the main process and then forgotten; nothing here ever receives it back, and every value
// shown came from main as plain text (textContent only). Names start with `g`: this file shares one global scope with
// the other page scripts.
const gApi = window.senderban;
const gEls = {
  details: document.getElementById("gmail"),
  clientState: document.getElementById("google-client-state"),
  form: document.getElementById("google-client-form"),
  clientId: document.getElementById("google-client-id"),
  secret: document.getElementById("google-client-secret"),
  save: document.getElementById("google-client-save"),
  confirm: document.getElementById("google-client-confirm"),
  clientMessage: document.getElementById("google-client-message"),
  list: document.getElementById("google-accounts"),
  empty: document.getElementById("google-empty"),
  add: document.getElementById("google-add"),
  cancel: document.getElementById("google-cancel"),
  message: document.getElementById("google-message"),
};

const G_PERMISSIONS =
  "Access Google already gave can be removed at myaccount.google.com/permissions.";
// Replies of the main process, as sentences. The input is never echoed.
const G_SIGN_IN_REPLY = {
  "signed-in": [
    "ok",
    "Signed in. Senderban does not block on Gmail yet; that comes in a later step.",
  ],
  "no-client": ["error", "Save your Google client first."],
  "unknown-account": ["error", "That account is no longer set up."],
  cancelled: ["warn", "Cancelled on Google's page. Nothing was saved."],
  aborted: ["warn", "Cancelled. Nothing was saved."],
  timeout: ["error", "Google did not answer in time. Try again."],
  busy: ["warn", "Another Google step is running. Wait for it to finish."],
  "browser-failed": ["error", "Could not open your browser. Try again."],
  scope: [
    "error",
    `Senderban needs both permissions. On Google's page tick both boxes. Nothing was saved. ${G_PERMISSIONS}`,
  ],
  "wrong-account": [
    "error",
    `That is another Google account than this one. Nothing was saved. ${G_PERMISSIONS}`,
  ],
  "client-refused": [
    "error",
    "Google refused the client ID or secret. Check both under Credentials in Google Cloud and save them again.",
  ],
  unreachable: ["error", "Could not reach Google. Try again."],
  duplicate: ["warn", "This mailbox is already set up in Senderban. Nothing was saved."],
  full: ["error", `There is no room for another account. Nothing was saved. ${G_PERMISSIONS}`],
  invalid: ["error", "Could not do that. See the log."],
  denied: ["error", "Could not do that. See the log."],
  failed: ["error", "Could not do that. See the log."],
};
const G_CLIENT_REPLY = {
  saved: ["ok", "Saved. The secret is stored encrypted on this device."],
  "saved-left-access": [
    "warn",
    `Saved, and every Gmail account was signed out. The old client could not be read, so its access was not revoked. ${G_PERMISSIONS}`,
  ],
  "revoke-failed": [
    "error",
    "Google did not confirm signing out every account, so the client was not changed. Check your connection and try again.",
  ],
  busy: ["warn", "Another Google step is running. Wait for it to finish."],
  invalid: ["error", "Check the values and try again."],
  denied: ["error", "Could not save. See the log."],
  failed: ["error", "Could not save. See the log."],
};
const G_REMOVE_REPLY = {
  removed: ["ok", "Removed. Senderban's access to that account was revoked."],
  "removed-not-revoked": [
    "warn",
    `Removed. This account held no stored access, so nothing was revoked. ${G_PERMISSIONS}`,
  ],
  "unknown-account": ["error", "That account is no longer set up."],
  "revoke-failed": [
    "error",
    "Google did not confirm revoking the access, so the account was kept. Try again, or remove Senderban at myaccount.google.com/permissions.",
  ],
  busy: ["warn", "Another Google step is running. Wait for it to finish."],
  invalid: ["error", "Could not remove. See the log."],
  denied: ["error", "Could not remove. See the log."],
  failed: ["error", "Could not remove. See the log."],
};

let gState = null;
let gLimits = null;
let gBusy = false;
let gLoaded = false;

/** Marks a value longer than the limit as invalid (the form then refuses to send it) instead of cutting it. */
function gCheckLength(input, max) {
  input.setCustomValidity(input.value.length > max ? `At most ${String(max)} characters.` : "");
}

function gSetMessage(node, tone, text) {
  node.dataset.tone = tone;
  node.textContent = text;
}

/** One Google step at a time on the page; the buttons say so while it runs. */
function gSetBusy(busy) {
  gBusy = busy;
  gEls.add.disabled = busy || gState === null || gState.client === null;
  gEls.save.disabled = busy;
  for (const button of gEls.list.querySelectorAll("button")) button.disabled = busy;
}

function gDrawClient() {
  gEls.clientState.textContent =
    gState.client === null ? "No client saved." : `Client saved: ${gState.client.clientId}`;
  gEls.save.textContent = gState.client === null ? "Save client" : "Replace client";
  gEls.add.disabled = gBusy || gState.client === null;
}

/** What the stored token is worth today. Text and colour-free: the state is said in words (never by colour alone). */
function gStateText(account) {
  if (!account.signedIn) return "Signed out. Sign in again to use it.";
  if (account.expired) return "Access expired. Sign in again to use it.";
  if (Number.isFinite(account.accessEndsAt)) {
    return `Signed in. Google ends this access on ${new Date(account.accessEndsAt * 1000).toLocaleDateString()}.`;
  }
  return "Signed in";
}

function gAccountRow(account) {
  const li = document.createElement("li");
  const title = document.createElement("div");
  title.className = "value";
  title.textContent = account.email;
  title.title = account.email;
  const meta = document.createElement("div");
  meta.className = "meta";
  meta.textContent = gStateText(account);

  const again = document.createElement("button");
  again.type = "button";
  again.textContent = "Sign in again";
  again.setAttribute("aria-label", `Sign in again as ${account.email}`);
  const remove = document.createElement("button");
  remove.type = "button";
  remove.textContent = "Remove";
  remove.setAttribute("aria-label", `Remove ${account.email}`);
  again.addEventListener("click", () => {
    if (!gBusy) void gSignIn({ accountId: account.accountId });
  });
  remove.addEventListener("click", () => {
    if (!gBusy) void gRemove(account);
  });
  const actions = document.createElement("div");
  actions.className = "row";
  actions.append(again, remove);
  li.append(title, meta, actions);
  return li;
}

function gDrawAccounts() {
  gEls.list.replaceChildren(...gState.accounts.map(gAccountRow));
  gEls.empty.hidden = gState.accounts.length > 0;
}

async function gRefresh() {
  const result = await gApi.googleState();
  if (result === null) {
    gSetMessage(gEls.message, "error", "Could not load the Gmail accounts. See the log.");
    return false;
  }
  gState = result;
  // The limits come from main: the page never invents its own numbers.
  // No maxLength: it would cut a longer paste down to a valid-looking wrong value. The field is marked instead.
  gLimits = result.limits;
  gEls.clientId.minLength = result.limits.clientId.min;
  gEls.clientId.pattern = result.idPattern;
  gEls.secret.minLength = result.limits.clientSecret.min;
  gEls.secret.pattern = result.secretPattern;
  gCheckLength(gEls.clientId, result.limits.clientId.max);
  gCheckLength(gEls.secret, result.limits.clientSecret.max);
  gDrawClient();
  gDrawAccounts();
  return true;
}

async function gSaveClient(confirmSignOut) {
  gSetBusy(true);
  try {
    gSetMessage(gEls.clientMessage, "working", "Saving…");
    const reply = await gApi.googleSaveClient({
      clientId: gEls.clientId.value,
      clientSecret: gEls.secret.value,
      confirmSignOut,
    });
    if (reply === "needs-confirm") {
      // The secret stays in the field so that the confirming click can send it; it is cleared once saved.
      const count = gState.accounts.filter((a) => a.signedIn).length;
      gSetMessage(
        gEls.clientMessage,
        "warn",
        `Another client signs out ${String(count)} Gmail account(s): their access is revoked and each must sign in again.`,
      );
      gEls.confirm.hidden = false;
      return;
    }
    gEls.confirm.hidden = true;
    const [tone, text] = G_CLIENT_REPLY[reply] ?? G_CLIENT_REPLY.failed;
    if (reply === "saved" || reply === "saved-left-access") {
      gEls.secret.value = "";
      gEls.clientId.value = "";
    }
    gSetMessage(gEls.clientMessage, tone, text);
    // Signed-out accounts show even when the replace failed half way.
    await gRefresh();
  } catch {
    gSetMessage(gEls.clientMessage, "error", "Could not save. See the log.");
  } finally {
    gSetBusy(false);
  }
}

async function gSignIn(request) {
  gSetBusy(true);
  gEls.cancel.hidden = false;
  try {
    gSetMessage(gEls.message, "working", "Waiting for Google in your browser…");
    const outcome = await gApi.googleSignIn(request);
    const [tone, text] = G_SIGN_IN_REPLY[outcome.reply] ?? G_SIGN_IN_REPLY.failed;
    const days = Number.isInteger(outcome.accessEndsInDays) ? outcome.accessEndsInDays : 0;
    gSetMessage(
      gEls.message,
      tone,
      days > 0
        ? `${text} Google ends this access in ${String(days)} day(s) while your project is in testing; sign in again then.`
        : text,
    );
    await gRefresh();
  } catch {
    gSetMessage(gEls.message, "error", "Could not sign in. See the log.");
  } finally {
    gEls.cancel.hidden = true;
    gSetBusy(false);
  }
}

async function gRemove(account) {
  gSetBusy(true);
  try {
    gSetMessage(gEls.message, "working", "Removing…");
    const reply = await gApi.googleRemove(account.accountId);
    const [tone, text] = G_REMOVE_REPLY[reply] ?? G_REMOVE_REPLY.failed;
    gSetMessage(gEls.message, tone, text);
    await gRefresh();
  } catch {
    gSetMessage(gEls.message, "error", "Could not remove. See the log.");
  } finally {
    gSetBusy(false);
  }
}

gEls.form.addEventListener("submit", (event) => {
  event.preventDefault();
  if (gBusy || !gEls.form.reportValidity()) return;
  void gSaveClient(false);
});
// Editing a field after the warning withdraws the confirmation: it was given for the values that were typed then.
for (const [input, key] of [
  [gEls.clientId, "clientId"],
  [gEls.secret, "clientSecret"],
]) {
  input.addEventListener("input", () => {
    if (gLimits !== null) gCheckLength(input, gLimits[key].max);
    if (!gEls.confirm.hidden) {
      gEls.confirm.hidden = true;
      gSetMessage(gEls.clientMessage, "working", "");
    }
  });
}
gEls.confirm.addEventListener("click", () => {
  if (!gBusy && gEls.form.reportValidity()) void gSaveClient(true);
});
gEls.add.addEventListener("click", () => {
  if (!gBusy) void gSignIn({});
});
gEls.cancel.addEventListener("click", () => {
  void gApi.googleCancel();
});

// Drawn when the section is opened, and again after every step (never while a key is being typed).
gEls.details.addEventListener("toggle", () => {
  if (gEls.details.open && !gLoaded) {
    gLoaded = true;
    void gRefresh().then((ok) => {
      gLoaded = ok;
    });
  }
});
