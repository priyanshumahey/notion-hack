const enabledEl = document.getElementById("enabled");
const speedEl = document.getElementById("speed");
const speedVal = document.getElementById("speedVal");
const hotkeyBtn = document.getElementById("hotkey");
const hotkeyReset = document.getElementById("hotkeyReset");
const testMicBtn = document.getElementById("testMic");
const statusEl = document.getElementById("status");

const DEFAULT_HOTKEY = "Shift+Q";

function fmt(n) {
  return Number(n).toFixed(2).replace(/0$/, "").replace(/\.$/, ".0");
}

function prettyHotkey(spec) {
  if (!spec) return DEFAULT_HOTKEY;
  return String(spec)
    .split("+")
    .map(s => s.trim())
    .filter(Boolean)
    .map(s => {
      const low = s.toLowerCase();
      if (low === "ctrl" || low === "control") return "Ctrl";
      if (low === "alt" || low === "option") return "Alt";
      if (low === "shift") return "Shift";
      if (low === "meta" || low === "cmd" || low === "command") return "Cmd";
      if (s.length === 1) return s.toUpperCase();
      return s.charAt(0).toUpperCase() + s.slice(1);
    })
    .join("+");
}

async function load() {
  const {
    bgc_enabled = true,
    bgc_speed = 1,
    bgc_hotkey = DEFAULT_HOTKEY,
  } = await chrome.storage.local.get(["bgc_enabled", "bgc_speed", "bgc_hotkey"]);
  enabledEl.checked = bgc_enabled !== false;
  speedEl.value = String(bgc_speed);
  speedVal.textContent = fmt(bgc_speed);
  hotkeyBtn.textContent = prettyHotkey(bgc_hotkey);
}

enabledEl.addEventListener("change", () => {
  chrome.storage.local.set({ bgc_enabled: enabledEl.checked });
});

speedEl.addEventListener("input", () => {
  const v = Number(speedEl.value);
  speedVal.textContent = fmt(v);
  chrome.storage.local.set({ bgc_speed: v });
});

// --- Hotkey capture ---
let capturing = false;
function startCapture() {
  capturing = true;
  hotkeyBtn.classList.add("is-capturing");
  hotkeyBtn.textContent = "Press a key…";
}
function endCapture() {
  capturing = false;
  hotkeyBtn.classList.remove("is-capturing");
}

hotkeyBtn.addEventListener("click", () => {
  if (capturing) {
    endCapture();
    load();
  } else {
    startCapture();
  }
});

hotkeyReset.addEventListener("click", async () => {
  await chrome.storage.local.set({ bgc_hotkey: DEFAULT_HOTKEY });
  hotkeyBtn.textContent = prettyHotkey(DEFAULT_HOTKEY);
  endCapture();
});

window.addEventListener("keydown", (e) => {
  if (!capturing) return;
  if (e.key === "Escape") {
    e.preventDefault();
    endCapture();
    load();
    return;
  }
  const k = (e.key || "").toLowerCase();
  if (k === "shift" || k === "control" || k === "alt" || k === "meta") return;

  e.preventDefault();
  e.stopPropagation();

  const parts = [];
  if (e.ctrlKey) parts.push("Ctrl");
  if (e.altKey) parts.push("Alt");
  if (e.shiftKey) parts.push("Shift");
  if (e.metaKey) parts.push("Cmd");

  // Prefer e.code (e.g. KeyG) — on macOS Alt+letter mutates e.key to a symbol.
  const code = (e.code || "").toLowerCase();
  let keyLabel;
  if (code.startsWith("key") && code.length === 4) {
    keyLabel = code.slice(3).toUpperCase();
  } else if (code.startsWith("digit") && code.length === 6) {
    keyLabel = code.slice(5);
  } else if (k.length === 1) {
    keyLabel = k.toUpperCase();
  } else {
    keyLabel = k.charAt(0).toUpperCase() + k.slice(1);
  }
  parts.push(keyLabel);

  const spec = parts.join("+");
  chrome.storage.local.set({ bgc_hotkey: spec });
  hotkeyBtn.textContent = spec;
  endCapture();
}, true);

// --- Test microphone ---
function setStatus(text, kind = "") {
  statusEl.textContent = text || "";
  statusEl.className = "status" + (kind ? " " + kind : "");
}

async function getActiveTab() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  return tab || null;
}

testMicBtn.addEventListener("click", async () => {
  setStatus("Pinging page…");
  const tab = await getActiveTab();
  if (!tab || !tab.id) {
    setStatus("No active tab.", "warn");
    return;
  }
  if (!/^https?:|^file:/.test(tab.url || "")) {
    setStatus("Open a regular web page first (chrome:// pages can't run this).", "warn");
    return;
  }

  let resp;
  try {
    resp = await chrome.tabs.sendMessage(tab.id, { type: "bgc:ping" });
  } catch (e) {
    setStatus("Content script not loaded on this tab — reload the page (⌘R), then try again.", "warn");
    return;
  }
  if (!resp || !resp.ok) {
    setStatus("Page did not respond. Try reloading the page.", "warn");
    return;
  }
  setStatus(resp.mounted ? "Cursor active. Triggering mic…" : "Cursor not mounted yet…", "ok");
  try {
    await chrome.tabs.sendMessage(tab.id, { type: "bgc:trigger" });
    setStatus("Triggered. Look at the page for the bubble. Speak now.", "ok");
  } catch (e) {
    setStatus("Trigger failed: " + (e?.message || "unknown error"), "warn");
  }
});

load();
