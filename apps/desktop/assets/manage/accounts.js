/* global setNotice, leaveAddView, stateBadge, offerRestart, mxDraw, mxLoadFailed, mxSwitches */
/* exported acLoad, acLoaded */
// MXroute mailboxes of the sandboxed manage page, grouped by mail domain, and the add form. The password is typed here, sent once to the main process and then
// forgotten: nothing here ever receives it back, and every value shown came from main as plain text (textContent only).
const acApi = window.senderban;
const acEls = {
  groups: document.getElementById("account-groups"),
  form: document.getElementById("account-form"),
  address: document.getElementById("account-address"),
  password: document.getElementById("account-password"),
  host: document.getElementById("account-host"),
  save: document.getElementById("account-save"),
  providerMx: document.getElementById("provider-mx"),
  providerGmail: document.getElementById("provider-gmail"),
  panelMx: document.getElementById("panel-mx"),
  panelGmail: document.getElementById("panel-gmail"),
};

// Replies of the main process, as sentences. The input is never echoed.
const AC_REPLY = {
  saved: ["ok", "Added. Restart Senderban to start blocking on this account."],
  "saved-own-entries": [
    "warn",
    "Added. Blocks on your list for this mail domain no longer apply, because it now counts as your own. Restart Senderban to start blocking on this account.",
  ],
  exists: ["error", "This mailbox is already set up."],
  limit: ["error", "Senderban cannot hold more accounts."],
  "login-refused": ["error", "The server refused this address or password."],
  "sieve-missing": [
    "error",
    "The login worked, but Senderban could not reach ManageSieve on port 4190, which it needs to write rules. Nothing was saved.",
  ],
  unreachable: ["error", "Could not reach this server. Check its name and try again."],
  "tls-refused": [
    "error",
    "This server's certificate could not be verified, so Senderban stopped. Check its name. Nothing was saved.",
  ],
  cancelled: ["warn", "Cancelled. Nothing was saved."],
  busy: ["warn", "A check is still running."],
  invalid: [
    "error",
    "Check the address, the password and the server, which must be a public host name.",
  ],
  denied: ["error", "Could not add the account. See the log."],
  failed: ["error", "Could not add the account. See the log."],
};

// Replies to a removal, as sentences.
const AC_REMOVE_REPLY = {
  removed: ["ok", "Removed. Restart Senderban to finish."],
  "removed-blacklist-remains": [
    "warn",
    "Removed. Senders it put on the MXroute blacklist stay there: delete them in your MXroute panel. Your API key stays. Restart Senderban to finish.",
  ],
  "removed-rules-remain": [
    "warn",
    "Removed, but its rules are still on the mail server and go on moving mail from blocked senders. Delete them at your provider. Restart Senderban to finish.",
  ],
  "restart-first": [
    "warn",
    "Restart Senderban first, so it can delete this account's rules, then remove it. Nothing was changed.",
  ],
  "rules-left": [
    "error",
    "Senderban could not delete this account's rules, so the account was kept. Check your connection and password, then try again.",
  ],
  "unknown-account": ["error", "That account is no longer set up."],
  cancelled: ["warn", "Cancelled. Nothing was changed."],
  busy: ["warn", "A check is still running."],
  invalid: ["error", "Could not remove the account. See the log."],
  denied: ["error", "Could not remove the account. See the log."],
  failed: ["error", "Could not remove the account. See the log."],
};

let acBusy = false;
let acLimits = null;

/** Marks a value longer than the limit as invalid (the form then refuses to send it) instead of cutting it. */
function acCheckLength(input, max) {
  input.setCustomValidity(input.value.length > max ? `At most ${String(max)} characters.` : "");
}

/** The password's limit is in octets, as the schema counts it: a multi-byte password holds fewer characters. */
function acCheckOctets(input, max) {
  const size = new window.TextEncoder().encode(input.value).length;
  input.setCustomValidity(size > max ? `Too long: at most ${String(max)} bytes.` : "");
}

function acSetBusy(busy) {
  acBusy = busy;
  acEls.save.disabled = busy;
  for (const button of acEls.groups.querySelectorAll("button")) button.disabled = busy;
}

function acRow(account) {
  const li = document.createElement("li");
  const title = document.createElement("div");
  title.className = "value grow";
  title.textContent = account.label;
  title.title = account.label;
  const remove = document.createElement("button");
  remove.type = "button";
  remove.className = "small";
  remove.textContent = "Remove";
  remove.setAttribute("aria-label", `Remove ${account.label}`);
  remove.addEventListener("click", () => {
    if (!acBusy) void acRemove(account);
  });
  li.append(title, stateBadge(account.accountId), remove);
  return li;
}

/** One mail domain: what its notifications offer, its Block at server switch and its mailboxes. */
function acGroup(domain, accounts, keys) {
  const holders = keys.filter((k) => k.domains.some((d) => d.domain === domain));
  const on = holders.some((k) => k.domains.some((d) => d.domain === domain && d.enabled));
  const section = document.createElement("section");
  section.className = "card";
  section.setAttribute("aria-label", domain);

  const head = document.createElement("div");
  head.className = "card-head";
  const what = document.createElement("div");
  what.className = "grow";
  const title = document.createElement("h2");
  title.textContent = domain;
  const hint = document.createElement("p");
  hint.className = "meta";
  if (holders.length === 0) {
    hint.dataset.tone = "warn";
    hint.textContent = "Block at server needs an API key. Add one below.";
  } else {
    hint.textContent = on
      ? "Notifications offer Block at server here."
      : "Notifications offer Junk and Trash here.";
  }
  what.append(title, hint);
  head.append(what, ...mxSwitches(domain, holders));
  section.append(head);

  if (accounts.length > 0) {
    const rows = document.createElement("ul");
    rows.className = "rows";
    rows.setAttribute("aria-label", `Mailboxes on ${domain}`);
    rows.append(...accounts.map(acRow));
    section.append(rows);
  }
  return section;
}

function acDraw(result) {
  const domains = new Map();
  for (const account of result.accounts) {
    const domain = account.label.slice(account.label.lastIndexOf("@") + 1);
    domains.set(domain, [...(domains.get(domain) ?? []), account]);
  }
  // A domain whose mailboxes are gone keeps its group while the switch is on: it must stay possible to switch it off.
  for (const key of result.keys) {
    for (const entry of key.domains) {
      if (entry.enabled && !domains.has(entry.domain)) domains.set(entry.domain, []);
    }
  }
  acEls.groups.replaceChildren(
    ...[...domains].map(([domain, accounts]) => acGroup(domain, accounts, result.keys)),
  );
}

// One list request at a time, so that an older answer cannot draw over a newer one.
let acLoading = false;
let acLoadAgain = false;

async function acLoad(options) {
  if (acLoading) {
    acLoadAgain = true;
    return;
  }
  acLoading = true;
  try {
    do {
      acLoadAgain = false;
      await acLoadOnce(options);
    } while (acLoadAgain);
  } finally {
    acLoading = false;
  }
}

async function acLoadOnce({ quiet = false } = {}) {
  const result = await acApi.mxrouteList();
  if (result === null) {
    if (!quiet) setNotice("error", "Could not load the accounts. Open Accounts again to retry.");
    mxLoadFailed();
    acLoaded = false;
    return;
  }
  acLimits = result.addLimits;
  acEls.address.minLength = acLimits.address.min;
  acEls.password.minLength = acLimits.password.min;
  acEls.host.minLength = acLimits.host.min;
  acEls.host.pattern = "[A-Za-z0-9]([A-Za-z0-9.\\-]*[A-Za-z0-9])?";
  mxDraw(result);
  acDraw(result);
}

async function acAdd() {
  acSetBusy(true);
  const input = {
    address: acEls.address.value,
    host: acEls.host.value,
    password: acEls.password.value,
  };
  // The password leaves the page as soon as it is sent, whatever the answer.
  acEls.password.value = "";
  let saved = false;
  try {
    setNotice("working", "Checking the login. This can take up to 45 seconds…");
    const reply = await acApi.accountAdd(input);
    const [tone, text] = AC_REPLY[reply] ?? AC_REPLY.failed;
    setNotice(tone, text);
    saved = reply === "saved" || reply === "saved-own-entries";
  } catch {
    setNotice("error", "Could not add the account. See the log.");
  }
  // Outside the try: a list that cannot be redrawn must not turn "Added" into "Could not add".
  if (saved) {
    acEls.address.value = "";
    acEls.host.value = "";
    await acLoad({ quiet: true }).catch(() => undefined);
    leaveAddView();
    offerRestart();
  }
  acSetBusy(false);
}

async function acRemove(account) {
  acSetBusy(true);
  try {
    setNotice("working", "Removing…");
    const reply = await acApi.accountRemove(account.accountId);
    const [tone, text] = AC_REMOVE_REPLY[reply] ?? AC_REMOVE_REPLY.failed;
    setNotice(tone, text);
  } catch {
    setNotice("error", "Could not remove the account. See the log.");
  }
  await acLoad({ quiet: true }).catch(() => undefined);
  offerRestart();
  acSetBusy(false);
}

for (const [key, input] of [
  ["address", acEls.address],
  ["password", acEls.password],
  ["host", acEls.host],
]) {
  input.addEventListener("input", () => {
    if (acLimits === null) return;
    (key === "password" ? acCheckOctets : acCheckLength)(input, acLimits[key].max);
  });
}

acEls.form.addEventListener("submit", (event) => {
  event.preventDefault();
  if (acBusy || !acEls.form.reportValidity()) return;
  void acAdd();
});

function acShowProvider(provider) {
  acEls.providerMx.setAttribute("aria-pressed", String(provider === "mx"));
  acEls.providerGmail.setAttribute("aria-pressed", String(provider === "gmail"));
  acEls.panelMx.hidden = provider !== "mx";
  acEls.panelGmail.hidden = provider !== "gmail";
}

acEls.providerMx.addEventListener("click", () => {
  acShowProvider("mx");
});
acEls.providerGmail.addEventListener("click", () => {
  acShowProvider("gmail");
});
acShowProvider("mx");

let acLoaded = false;
document.addEventListener("senderban-view", (event) => {
  if (event.detail !== "blocked" && !acLoaded) {
    acLoaded = true;
    void acLoad();
  }
});
