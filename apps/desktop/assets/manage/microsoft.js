/* global setNotice, leaveAddView, offerRestart, pill */
// Microsoft part of the sandboxed manage page: Outlook.com and Microsoft 365 accounts. Nothing here ever receives a token, and every value shown came from
// main as plain text (textContent only). Names start with `ms`: this file shares one global scope with the other page scripts.
const msApi = window.senderban;
const msEls = {
  section: document.getElementById("microsoft"),
  list: document.getElementById("microsoft-accounts"),
  add: document.getElementById("microsoft-add"),
  unavailable: document.getElementById("microsoft-unavailable"),
  cancel: document.getElementById("google-cancel"),
  approval: document.getElementById("microsoft-approval"),
  approvalLink: document.getElementById("microsoft-approval-link"),
};

const MS_ACCESS =
  "Access Microsoft already gave can be removed at account.live.com/consent/Manage, or at myapps.microsoft.com for a work account.";
// Replies of the main process, as sentences. Nothing from a person or a provider is echoed.
// Microsoft's "needs approval" page often leads back as a cancel, or nowhere at all: these are the replies a person in that spot sees.
const MS_MAY_NEED_APPROVAL = new Set(["needs-approval", "cancelled", "timeout"]);
const MS_SIGN_IN_REPLY = {
  "signed-in": [
    "ok",
    "Signed in. Senderban restarts in a moment to start blocking on this account.",
  ],
  "no-client": ["error", "Microsoft sign-in is not set up in this version of Senderban."],
  "unknown-account": ["error", "That account is no longer set up."],
  cancelled: [
    "warn",
    "Cancelled on Microsoft's page. Nothing was saved. If it said your organization must approve Senderban, send your administrator the link below.",
  ],
  aborted: ["warn", "Cancelled. Nothing was saved."],
  timeout: [
    "error",
    "Microsoft did not answer in time. If its page said your organization must approve Senderban, send your administrator the link below; otherwise try again.",
  ],
  busy: ["warn", "Another sign-in is running. Wait for it to finish."],
  "browser-failed": ["error", "Could not open your browser. Try again."],
  "needs-approval": [
    "error",
    "Your organization must approve Senderban before it can use your mailbox. Send your administrator the link below, then sign in again. Nothing was saved.",
  ],
  scope: [
    "error",
    `Microsoft gave less access than Senderban needs. Nothing was saved. ${MS_ACCESS}`,
  ],
  "wrong-account": [
    "error",
    `That is another Microsoft account than this one. Nothing was saved. ${MS_ACCESS}`,
  ],
  "client-refused": [
    "error",
    "Microsoft refused the sign-in. Try again; if it keeps refusing, see the log.",
  ],
  unreachable: ["error", "Could not reach Microsoft. Try again."],
  duplicate: ["warn", "This mailbox is already set up in Senderban. Nothing was saved."],
  full: ["error", `There is no room for another account. Nothing was saved. ${MS_ACCESS}`],
  invalid: ["error", "Could not do that. See the log."],
  denied: ["error", "Could not do that. See the log."],
  failed: ["error", "Could not do that. See the log."],
};
const MS_REMOVE_REPLY = {
  removed: ["ok", `Removed, with Senderban's rules. ${MS_ACCESS}`],
  "removed-rules-remain": [
    "warn",
    `Removed, but some of Senderban's rules stay: it could not reach the mailbox, or they were changed in Outlook, and it does not touch those. Delete the rules named Senderban under Outlook settings, Mail, Rules (they move mail from listed senders). ${MS_ACCESS}`,
  ],
  "restart-first": [
    "warn",
    "Restart Senderban first, so it can delete this account's rules, then remove the account. Nothing was changed.",
  ],
  "rules-left": [
    "error",
    "Senderban could not delete its rules (Microsoft did not answer), so the account was kept and the rules still work. Check your connection and try again.",
  ],
  "unknown-account": ["error", "That account is no longer set up."],
  busy: ["warn", "Another step is running. Wait for it to finish."],
  invalid: ["error", "Could not remove. See the log."],
  denied: ["error", "Could not remove. See the log."],
  failed: ["error", "Could not remove. See the log."],
};

let msState = null;
let msBusy = false;
let msLoaded = false;

function msSetBusy(busy) {
  msBusy = busy;
  msEls.add.disabled = busy || msState === null || !msState.available;
  for (const button of msEls.list.querySelectorAll("button")) button.disabled = busy;
}

function msStateText(account) {
  if (!account.signedIn) return "Signed out. Sign in again to use it.";
  const base = "Signed in. Your block list applies here, and new mail is announced.";
  return account.editedRules > 0
    ? `${base} ${String(account.editedRules)} Senderban rule(s) were changed in Outlook or are in error there: Senderban leaves those alone, so check them there.`
    : base;
}

function msAccountRow(account) {
  const li = document.createElement("li");
  const what = document.createElement("div");
  what.className = "what";
  const title = document.createElement("div");
  title.className = "value";
  title.textContent = account.email;
  title.title = account.email;
  const meta = document.createElement("div");
  meta.className = "meta";
  meta.textContent = msStateText(account);
  what.append(title, meta);

  const again = document.createElement("button");
  again.type = "button";
  again.className = "small";
  again.textContent = "Sign in again";
  again.setAttribute("aria-label", `Sign in again as ${account.email}`);
  again.disabled = msState === null || !msState.available;
  const remove = document.createElement("button");
  remove.type = "button";
  remove.className = "small";
  remove.textContent = "Remove";
  remove.setAttribute("aria-label", `Remove ${account.email}`);
  again.addEventListener("click", () => {
    if (!msBusy) void msSignIn({ accountId: account.accountId });
  });
  remove.addEventListener("click", () => {
    if (!msBusy) void msRemove(account);
  });
  li.append(what);
  if (account.signedIn) li.append(pill("", "Rules"));
  li.append(again, remove);
  return li;
}

function msDraw() {
  msEls.list.replaceChildren(...msState.accounts.map(msAccountRow));
  msEls.section.hidden = msState.accounts.length === 0;
  msEls.add.disabled = msBusy || !msState.available;
  msEls.unavailable.hidden = msState.available;
}

async function msRefresh() {
  const result = await msApi.microsoftState();
  if (result === null) {
    setNotice("error", "Could not load the Microsoft accounts. See the log.");
    return false;
  }
  msState = result;
  msDraw();
  return true;
}

/** The link for the administrator stays until the next sign-in. */
function msShowApproval(show) {
  const link = msState?.adminConsentUrl ?? null;
  msEls.approval.hidden = !show || link === null;
  msEls.approvalLink.value = link ?? "";
}

async function msSignIn(request) {
  msSetBusy(true);
  msEls.cancel.hidden = false;
  msShowApproval(false);
  try {
    setNotice("working", "Waiting for Microsoft in your browser…");
    const reply = await msApi.microsoftSignIn(request);
    const [tone, text] = MS_SIGN_IN_REPLY[reply] ?? MS_SIGN_IN_REPLY.failed;
    setNotice(tone, text);
    await msRefresh();
    msShowApproval(MS_MAY_NEED_APPROVAL.has(reply));
    if (reply === "signed-in") {
      leaveAddView();
      offerRestart();
    }
  } catch {
    setNotice("error", "Could not sign in. See the log.");
  } finally {
    msEls.cancel.hidden = true;
    msSetBusy(false);
  }
}

async function msRemove(account) {
  msSetBusy(true);
  try {
    setNotice("working", "Removing…");
    const reply = await msApi.microsoftRemove(account.accountId);
    const [tone, text] = MS_REMOVE_REPLY[reply] ?? MS_REMOVE_REPLY.failed;
    setNotice(tone, text);
    await msRefresh();
    offerRestart();
  } catch {
    setNotice("error", "Could not remove. See the log.");
  } finally {
    msSetBusy(false);
  }
}

msEls.add.addEventListener("click", () => {
  if (!msBusy) void msSignIn({});
});
msEls.approvalLink.addEventListener("focus", () => {
  msEls.approvalLink.select();
});
document.addEventListener("senderban-view", (event) => {
  if (event.detail !== "blocked" && !msLoaded) {
    msLoaded = true;
    void msRefresh().then((ok) => {
      msLoaded = ok;
    });
  }
});
