// Background service worker:
//  - Seeds default settings on first install.
//  - Owns the offscreen document that hosts Web Speech API.
//  - Routes start/stop from content scripts to offscreen, and results back to
//    the originating tab.
//  - Re-injects the content script into open tabs after install/update so the
//    cursor appears without the user having to reload every tab manually.

const LOG = (...args) => console.log("[BGC bg]", ...args);
const OFFSCREEN_PATH = "offscreen.html";

chrome.runtime.onInstalled.addListener(async (details) => {
  LOG("onInstalled", details);

  const cur = await chrome.storage.local.get(["bgc_enabled", "bgc_speed", "bgc_hotkey"]);
  const patch = {};
  if (cur.bgc_enabled === undefined) patch.bgc_enabled = true;
  if (cur.bgc_speed === undefined) patch.bgc_speed = 1;
  if (cur.bgc_hotkey === undefined) patch.bgc_hotkey = "Shift+Q";
  if (Object.keys(patch).length) await chrome.storage.local.set(patch);

  // Re-inject the content script into any already-open http(s) tabs so the
  // cursor appears without forcing the user to reload every tab.
  try {
    const tabs = await chrome.tabs.query({});
    for (const tab of tabs) {
      if (!tab.id || !tab.url) continue;
      if (!/^https?:|^file:/.test(tab.url)) continue;
      chrome.scripting
        .insertCSS({ target: { tabId: tab.id }, files: ["content.css"] })
        .catch(() => {});
      chrome.scripting
        .executeScript({ target: { tabId: tab.id }, files: ["content.js"] })
        .then(() => LOG("reinjected into", tab.id, tab.url))
        .catch((e) => LOG("inject failed for", tab.id, e?.message));
    }
  } catch (e) {
    LOG("re-injection sweep failed", e?.message);
  }
});

let activeTabId = null;
let listening = false;
let creatingOffscreen = null;

async function ensureOffscreen() {
  const url = chrome.runtime.getURL(OFFSCREEN_PATH);
  // Prefer the modern check when available.
  if (chrome.offscreen?.hasDocument) {
    if (await chrome.offscreen.hasDocument()) return;
  } else if (chrome.runtime.getContexts) {
    const contexts = await chrome.runtime.getContexts({
      contextTypes: ["OFFSCREEN_DOCUMENT"],
      documentUrls: [url],
    });
    if (contexts && contexts.length) return;
  }

  if (creatingOffscreen) {
    await creatingOffscreen;
    return;
  }
  creatingOffscreen = chrome.offscreen.createDocument({
    url: OFFSCREEN_PATH,
    reasons: ["USER_MEDIA"],
    justification: "Run Web Speech API for ghost-cursor voice transcription.",
  });
  try {
    await creatingOffscreen;
  } finally {
    creatingOffscreen = null;
  }
}

async function sendToOffscreen(msg) {
  await ensureOffscreen();
  try {
    await chrome.runtime.sendMessage({ target: "offscreen", ...msg });
  } catch (_) {
    /* offscreen not ready yet */
  }
}

function sendToTab(tabId, msg) {
  if (tabId == null) return;
  chrome.tabs.sendMessage(tabId, msg).catch(() => {});
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (!msg || typeof msg !== "object") return;

  // From content script
  if (msg.type === "bgc:start") {
    (async () => {
      const tabId = sender.tab && sender.tab.id;
      LOG("bgc:start from tab", tabId);
      if (listening && activeTabId != null && activeTabId !== tabId) {
        // Tear down any session running for a different tab so the new tab gets clean state.
        sendToTab(activeTabId, { type: "bgc:end", finalText: "" });
        await sendToOffscreen({ type: "bgc:stop" });
      }
      activeTabId = tabId ?? activeTabId;
      await sendToOffscreen({ type: "bgc:start", lang: msg.lang });
      sendResponse({ ok: true });
    })();
    return true; // async
  }

  if (msg.type === "bgc:stop") {
    (async () => {
      LOG("bgc:stop from tab", sender.tab?.id);
      await sendToOffscreen({ type: "bgc:stop" });
      sendResponse({ ok: true });
    })();
    return true;
  }

  // From offscreen
  if (msg.target === "background") {
    LOG("offscreen ->", msg.type, msg.error || "");
    if (msg.type === "bgc:listening") listening = true;
    else if (msg.type === "bgc:end" || msg.type === "bgc:error") listening = false;
    sendToTab(activeTabId, msg);
  }
});

