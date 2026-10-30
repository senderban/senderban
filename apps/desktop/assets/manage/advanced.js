// Advanced section of the sandboxed manage page: the MXroute API keys. A key belongs to the MXroute login, not to a
// mailbox, so it has its own block and its own Remove. A key is typed here, sent once to the main process and then
// forgotten: nothing here ever receives it back, and every value shown came from main as plain text (textContent only).
const mxApi = window.senderban;
const mxEls = {
  details: document.getElementById("advanced"),
  list: document.getElementById("mxroute-keys"),
  empty: document.getElementById("mxroute-empty"),
  // Outlives a redraw of the list, unlike the message inside a key's block.
  notice: document.getElementById("mxroute-notice"),
  form: document.getElementById("mxroute-new"),
};

// Replies of the main process, as sentences. The input is never echoed.
const MX_REPLY = {
  saved: ["ok", "Saved. Stored encrypted on this device. Restart Senderban to use it."],
  "key-refused": ["error", "MXroute refused this key. Check the server, user name and key."],
  unreachable: ["error", "Could not reach MXroute. Try again."],
  "unknown-key": ["error", "That key is no longer saved."],
  "unknown-domain": ["error", "No mailbox on that domain is set up, or another key holds it."],
  full: ["error", "That is the most Senderban can hold. Remove a key you no longer use."],
  invalid: ["error", "Check the values and try again."],
  denied: ["error", "Could not save. See the log."],
  failed: ["error", "Could not save. See the log."],
};

let mxLimits = null;
let mxBusy = false;

function field(id, labelText, input) {
  const wrap = document.createElement("div");
  wrap.className = "field";
  const label = document.createElement("label");
  label.htmlFor = id;
  label.textContent = labelText;
  input.id = id;
  wrap.append(label, input);
  return wrap;
}

function textInput(limit) {
  const input = document.createElement("input");
  input.type = "text";
  input.required = true;
  input.minLength = limit.min;
  input.maxLength = limit.max;
  input.autocomplete = "off";
  input.spellcheck = false;
  return input;
}

function setMessage(node, tone, text) {
  node.dataset.tone = tone;
  node.textContent = text;
}

// Whether blocked single addresses also go onto this domain's MXroute blacklist. Off until switched on.
function domainRow(key, entry, id, message) {
  const row = document.createElement("div");
  row.className = "row";
  const box = document.createElement("input");
  box.type = "checkbox";
  box.id = id;
  box.checked = entry.enabled;
  const label = document.createElement("label");
  label.htmlFor = id;
  label.textContent = `Offer “Block at server” on ${entry.domain}`;
  row.append(box, label);
  box.addEventListener("change", () => {
    if (mxBusy) {
      box.checked = !box.checked;
      return;
    }
    void switchBlacklist(key, entry.domain, box, message);
  });
  return row;
}

async function switchBlacklist(key, domain, box, message) {
  mxBusy = true;
  const wanted = box.checked;
  try {
    setMessage(message, "working", "Checking…");
    const reply = await mxApi.mxrouteEnable({
      server: key.server,
      username: key.username,
      domain,
      enabled: wanted,
    });
    if (reply === "saved") {
      setMessage(
        message,
        "ok",
        wanted
          ? "On. It starts the next time Senderban starts."
          : "Off. It stops the next time Senderban starts.",
      );
    } else {
      box.checked = !wanted;
      const [tone, text] = MX_REPLY[reply] ?? MX_REPLY.failed;
      setMessage(message, tone, text);
    }
  } catch {
    box.checked = !wanted;
    setMessage(message, "error", "Could not save. See the log.");
  } finally {
    mxBusy = false;
  }
}

function keyBlock(key, index) {
  const li = document.createElement("li");
  const title = document.createElement("div");
  title.className = "value";
  title.textContent = `${key.username} on ${key.server}`;
  title.title = title.textContent;

  const message = document.createElement("p");
  message.className = "status";
  message.setAttribute("role", "status");

  const remove = document.createElement("button");
  remove.type = "button";
  remove.textContent = "Remove key";
  remove.setAttribute("aria-label", `Remove key for ${key.username} on ${key.server}`);
  remove.addEventListener("click", () => {
    if (!mxBusy) void removeKey(key, message);
  });
  const actions = document.createElement("div");
  actions.className = "row";
  actions.append(remove);

  li.append(title);
  if (key.domains.length === 0) {
    const none = document.createElement("div");
    none.className = "meta";
    none.textContent = "Add a mailbox to use this key.";
    li.append(none);
  } else {
    const wrap = document.createElement("div");
    wrap.className = "enable";
    wrap.append(
      ...key.domains.map((entry, at) =>
        domainRow(key, entry, `mx-enable-${String(index)}-${String(at)}`, message),
      ),
    );
    const help = document.createElement("p");
    help.className = "muted";
    help.textContent =
      "New-mail notifications then offer “Block at server” for one sender: the server refuses their mail at the door, so the sender gets an error and the mail does not reach Junk or Trash. Junk and Trash stay available and never touch MXroute. The MXroute blacklist covers the whole mail domain, so a refused address is refused for every mailbox on it. An address already on your blacklist is treated as Senderban's own and taken off again when you unblock it. A whole domain is never refused at the server. Whether MXroute drops a sender also depends on the spam-score limit in your MXroute panel, so try one block and check. Takes effect when Senderban starts; switching it off takes back what Senderban added.";
    wrap.append(help);
    li.append(wrap);
  }
  li.append(actions, message);
  return li;
}

// One form, under the keys: saving for a login that already has a key replaces it.
function keyForm() {
  const form = document.createElement("form");
  form.autocomplete = "off";
  const server = textInput(mxLimits.server);
  server.placeholder = "e.g. eagle.mxlogin.com";
  server.pattern = "[A-Za-z0-9]([A-Za-z0-9.\\-]*[A-Za-z0-9])?";
  const username = textInput(mxLimits.username);
  // The pattern attribute is compiled with the `v` flag: `|` and `-` inside a class must be escaped.
  username.pattern = "[A-Za-z0-9._\\|\\-]+";
  const key = textInput(mxLimits.apiKey);
  key.type = "password";
  key.pattern = "[!-~]+";
  key.placeholder = "Paste the key";

  const save = document.createElement("button");
  save.type = "submit";
  save.textContent = "Save key";
  const actions = document.createElement("div");
  actions.className = "row";
  actions.append(save);
  const hint = document.createElement("p");
  hint.className = "muted";
  hint.textContent =
    "Saving for the same server and user name replaces that key. This does not revoke the old one: delete that at panel.mxroute.com/api-keys.php.";
  const message = document.createElement("p");
  message.className = "status";
  message.setAttribute("role", "status");

  form.append(
    field("mx-server", "Server", server),
    field("mx-user", "User name", username),
    field("mx-key", "API key", key),
    hint,
    actions,
    message,
  );
  form.addEventListener("submit", (event) => {
    event.preventDefault();
    if (mxBusy) return;
    if (!form.reportValidity()) return;
    void saveKey({ server, username, key }, message);
  });
  return form;
}

async function saveKey(inputs, message) {
  mxBusy = true;
  try {
    setMessage(mxEls.notice, "", "");
    setMessage(message, "working", "Saving…");
    const reply = await mxApi.mxrouteSave({
      server: inputs.server.value,
      username: inputs.username.value,
      apiKey: inputs.key.value,
    });
    // The key leaves the page as soon as it was sent, whatever the answer.
    inputs.key.value = "";
    const [tone, text] = MX_REPLY[reply] ?? MX_REPLY.failed;
    setMessage(message, tone, text);
    if (reply === "saved") await loadKeys();
  } catch {
    inputs.key.value = "";
    setMessage(message, "error", "Could not save. See the log.");
  } finally {
    mxBusy = false;
  }
}

async function removeKey(key, message) {
  mxBusy = true;
  try {
    setMessage(message, "working", "Removing…");
    const reply = await mxApi.mxrouteRemove({ server: key.server, username: key.username });
    if (reply === "saved") {
      await loadKeys();
      setMessage(mxEls.form.querySelector(".status"), "", "");
      setMessage(
        mxEls.notice,
        "ok",
        "Removed from this device. Your mailboxes stay. Restart Senderban to finish. To revoke the key, delete it at panel.mxroute.com/api-keys.php.",
      );
    } else if (reply === "cancelled") {
      setMessage(message, "warn", "Cancelled. Nothing was changed.");
    } else {
      setMessage(message, "error", "Could not remove. See the log.");
    }
  } catch {
    setMessage(message, "error", "Could not remove. See the log.");
  } finally {
    mxBusy = false;
  }
}

// Drawn when the section is opened and after a change. The list holds no typed text, so a redraw loses nothing.
async function loadKeys() {
  const result = await mxApi.mxrouteList();
  if (result === null) {
    mxEls.empty.textContent = "Could not load the keys. Close and open this section to retry.";
    mxEls.empty.hidden = false;
    mxLoaded = false;
    return;
  }
  mxLimits = result.limits;
  mxEls.empty.textContent = result.keysUnreadable
    ? "Could not read the saved keys. Quit Senderban, delete mxroute-keys.json from %APPDATA%\\Senderban and start it again, then save your key here."
    : "No key saved yet.";
  mxEls.list.replaceChildren(...result.keys.map(keyBlock));
  mxEls.empty.hidden = result.keys.length > 0;
  if (mxEls.form.childElementCount === 0) mxEls.form.append(keyForm());
}

let mxLoaded = false;
mxEls.details.addEventListener("toggle", () => {
  if (mxEls.details.open && !mxLoaded) {
    mxLoaded = true;
    void loadKeys();
  }
});

// A mailbox added or removed elsewhere in the window changes which domains are on offer.
mxApi.onChanged(() => {
  if (mxLoaded && !mxBusy) void loadKeys();
});
