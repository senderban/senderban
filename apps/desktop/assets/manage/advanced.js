/* global setNotice, acLoad, acLoaded */
/* exported mxDraw, mxLoadFailed, mxSwitches, offerRestart */
// MXroute API keys of the sandboxed manage page, and the per-domain Block at server switches. A key belongs to the MXroute login, not to a
// mailbox, so it has its own block and its own Remove. A key is typed here, sent once to the main process and then
// forgotten: nothing here ever receives it back, and every value shown came from main as plain text (textContent only).
const mxApi = window.senderban;
const mxEls = {
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
let mxSwitchCount = 0;

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

// Main remembers that a restart is due; this shows the button without waiting for the next open.
function offerRestart() {
  document.dispatchEvent(new window.Event("senderban-restart-due"));
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

// Whether blocked single addresses also go onto this domain's MXroute blacklist. Off until switched on. A domain two keys can
// hold has a switch per key: which key may hold it is only known by trying it, and the person has to be able to choose.
function mxSwitches(domain, holders) {
  return holders.map((key) => {
    const row = document.createElement("div");
    row.className = "switch-row";
    mxSwitchCount += 1;
    const id = `mx-enable-${String(mxSwitchCount)}`;
    const box = document.createElement("input");
    box.type = "checkbox";
    box.setAttribute("role", "switch");
    box.id = id;
    box.checked = key.domains.some((d) => d.domain === domain && d.enabled);
    const label = document.createElement("label");
    label.htmlFor = id;
    label.textContent =
      holders.length > 1 ? `Block at server (${key.username})` : "Block at server";
    box.setAttribute("aria-label", `${label.textContent} on ${domain}`);
    row.append(label, box);
    box.addEventListener("change", () => {
      if (mxBusy) {
        box.checked = !box.checked;
        return;
      }
      void switchBlacklist(key, domain, box);
    });
    return row;
  });
}

async function switchBlacklist(key, domain, box) {
  mxBusy = true;
  const wanted = box.checked;
  try {
    setNotice("working", "Checking…");
    const reply = await mxApi.mxrouteEnable({
      server: key.server,
      username: key.username,
      domain,
      enabled: wanted,
    });
    if (reply === "saved") {
      await acLoad({ quiet: true });
      offerRestart();
      setNotice(
        "ok",
        wanted
          ? "On. It starts the next time Senderban starts."
          : "Off. It stops the next time Senderban starts.",
      );
    } else {
      box.checked = !wanted;
      const [tone, text] = MX_REPLY[reply] ?? MX_REPLY.failed;
      setNotice(tone, text);
    }
  } catch {
    box.checked = !wanted;
    setNotice("error", "Could not save. See the log.");
  } finally {
    mxBusy = false;
  }
}

function keyBlock(key) {
  const li = document.createElement("li");
  const title = document.createElement("div");
  title.className = "value grow";
  title.textContent = `${key.username} on ${key.server}`;
  title.title = title.textContent;

  const message = document.createElement("p");
  message.className = "status";
  message.setAttribute("role", "status");

  const remove = document.createElement("button");
  remove.type = "button";
  remove.className = "small";
  remove.textContent = "Remove key";
  remove.setAttribute("aria-label", `Remove key for ${key.username} on ${key.server}`);
  remove.addEventListener("click", () => {
    if (!mxBusy) void removeKey(key, message);
  });

  li.append(title, remove);
  if (key.domains.length === 0) {
    const none = document.createElement("div");
    none.className = "meta";
    none.textContent = "Add a mailbox to use this key.";
    li.append(none);
  }
  li.append(message);
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
    if (reply === "saved") {
      await acLoad({ quiet: true });
      offerRestart();
    }
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
      await acLoad({ quiet: true });
      offerRestart();
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

/** The key part of the Accounts view. The list holds no typed text, so a redraw loses nothing. */
function mxDraw(result) {
  mxLimits = result.limits;
  mxEls.empty.textContent = result.keysUnreadable
    ? "Could not read the saved keys. Quit Senderban, delete mxroute-keys.json from %APPDATA%\\Senderban and start it again, then save your key here."
    : "No key saved yet.";
  mxEls.list.replaceChildren(...result.keys.map(keyBlock));
  mxEls.empty.hidden = result.keys.length > 0;
  if (mxEls.form.childElementCount === 0) {
    mxEls.form.append(keyForm());
    if (result.keys.length === 0) mxEls.form.closest("details").open = true;
  }
}

function mxLoadFailed() {
  mxEls.empty.textContent = "Could not load the keys. Open Accounts again to retry.";
  mxEls.empty.hidden = false;
}

// A mailbox added or removed elsewhere in the window changes which domains are on offer.
mxApi.onChanged(() => {
  if (acLoaded && !mxBusy) void acLoad({ quiet: true });
});
