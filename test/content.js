/* Blue Ghost Cursor — content script
 *
 * Injects a single absolutely-positioned blue arrow cursor into the page and
 * animates it via smooth value-noise so the motion looks like a "wandering"
 * pointer. Purely visual — never dispatches input events.
 *
 * Also: a configurable hotkey toggles the Web Speech API; transcribed text
 * shows up in a chat-style bubble next to the ghost cursor.
 */

(() => {
  const LOG = (...args) => console.log("[BGC]", ...args);

  // If a previous instance is on the page (orphaned from a prior extension
  // version), tear it down so this fresh injection wins.
  if (window.__blueGhostCursor && typeof window.__blueGhostCursor.dispose === "function") {
    try {
      window.__blueGhostCursor.dispose();
      LOG("disposed previous instance");
    } catch (_) {}
  }

  const ROOT_ID = "blue-ghost-cursor-root";
  const STORAGE_KEY = "bgc_enabled";
  const SPEED_KEY = "bgc_speed"; // 0..1 scalar multiplier
  const HOTKEY_KEY = "bgc_hotkey";
  const DEFAULT_HOTKEY = "Shift+Q";
  const MARGIN = 16; // keep cursor away from extreme edges
  const BUBBLE_OFFSET_X = 26;
  const BUBBLE_OFFSET_Y = -18;
  const BUBBLE_LINGER_MS = 2400;

  // ---------- 1D value noise (smoothed) ----------
  // Returns a deterministic-ish smooth function f(t) in roughly [-1, 1].
  function makeNoise1D(seed) {
    const cache = new Map();
    function hashedRand(i) {
      const key = i | 0;
      const cached = cache.get(key);
      if (cached !== undefined) return cached;
      let x = (key + seed) * 374761393;
      x = Math.imul(x ^ (x >>> 13), 1274126177);
      x = x ^ (x >>> 16);
      const v = ((x >>> 0) / 4294967295) * 2 - 1;
      cache.set(key, v);
      return v;
    }
    function smoothstep(t) {
      return t * t * (3 - 2 * t);
    }
    // Sum two octaves for slightly richer motion
    return function noise(t) {
      const o1 = (() => {
        const i = Math.floor(t);
        const f = t - i;
        const a = hashedRand(i);
        const b = hashedRand(i + 1);
        return a + smoothstep(f) * (b - a);
      })();
      const t2 = t * 2.13 + 17;
      const o2 = (() => {
        const i = Math.floor(t2);
        const f = t2 - i;
        const a = hashedRand(i + 1000);
        const b = hashedRand(i + 1001);
        return a + smoothstep(f) * (b - a);
      })();
      return o1 * 0.75 + o2 * 0.25;
    };
  }

  const noiseX = makeNoise1D(1337);
  const noiseY = makeNoise1D(8675309);

  // ---------- DOM ----------
  function buildRoot() {
    const root = document.createElement("div");
    root.id = ROOT_ID;
    // Inline cursor markup — blue fill with white outline so it's visible on
    // any background. Shape approximates the classic arrow pointer.
    root.innerHTML = `
      <div class="bgc-cursor" aria-hidden="true">
        <svg viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg">
          <path d="M3 2 L3 19 L8 14.5 L11 21 L14 19.5 L11 13 L18 13 Z"
                fill="#2f8cff"
                stroke="#ffffff"
                stroke-width="1.2"
                stroke-linejoin="round" />
        </svg>
      </div>
      <div class="bgc-bubble" aria-hidden="true"></div>
      <section class="bgc-agent-panel" aria-label="Agent panel" tabindex="0">
        <div class="bgc-agent-collapsed" aria-hidden="true">
          <span class="bgc-agent-dot"></span>
        </div>
        <div class="bgc-agent-expanded" aria-hidden="true">
          <div class="bgc-agent-header">
            <span class="bgc-agent-title">Agent</span>
            <span class="bgc-agent-status">Ready</span>
          </div>
          <div class="bgc-agent-body">
            <button type="button" class="bgc-agent-action">Ask</button>
            <button type="button" class="bgc-agent-action">Summarize</button>
            <button type="button" class="bgc-agent-action">Capture</button>
          </div>
        </div>
      </section>
    `;
    return root;
  }

  let root = null;
  let cursorEl = null;
  let bubbleEl = null;
  let rafId = 0;
  let startTime = 0;
  let enabled = true;
  let speed = 1; // 0.25..2 typical
  let hotkey = DEFAULT_HOTKEY;
  let lastVisibility = !document.hidden;

  // Live cursor position (updated each tick); read by the bubble positioner.
  let curX = -1000;
  let curY = -1000;

  function mount() {
    if (root && root.isConnected) return;
    // Wait for body to be ready
    if (!document.body) {
      window.addEventListener("DOMContentLoaded", mount, { once: true });
      return;
    }
    // If a previous root was left in the DOM from a stale injection, remove it.
    const stale = document.getElementById(ROOT_ID);
    if (stale && stale.parentNode) stale.parentNode.removeChild(stale);

    root = buildRoot();
    document.body.appendChild(root);
    cursorEl = root.querySelector(".bgc-cursor");
    bubbleEl = root.querySelector(".bgc-bubble");
    startTime = performance.now();
    if (rafId) cancelAnimationFrame(rafId);
    rafId = requestAnimationFrame(tick);
    LOG("mounted");
  }

  function unmount() {
    if (rafId) cancelAnimationFrame(rafId);
    rafId = 0;
    if (root && root.parentNode) root.parentNode.removeChild(root);
    root = null;
    cursorEl = null;
    bubbleEl = null;
    stopRecognition();
    LOG("unmounted");
  }

  function dispose() {
    unmount();
    try { window.removeEventListener("keydown", onKeyDown, true); } catch (_) {}
    try { document.removeEventListener("visibilitychange", onVisibility); } catch (_) {}
    if (storageListener) {
      try { chrome.storage?.onChanged.removeListener(storageListener); } catch (_) {}
    }
    if (runtimeMessageListener) {
      try { chrome.runtime?.onMessage.removeListener(runtimeMessageListener); } catch (_) {}
    }
    delete window.__blueGhostCursor;
  }

  function tick(now) {
    rafId = requestAnimationFrame(tick);
    if (!cursorEl) return;
    if (document.hidden) return; // pause work while tab not visible

    const vw = window.innerWidth;
    const vh = window.innerHeight;

    // Time in seconds since start, scaled by speed slider. Lower coefficient
    // = slower drift. ~0.12 keeps the motion calm and "ghostly".
    const t = ((now - startTime) / 1000) * 0.12 * speed;

    // Map noise [-1, 1] to viewport with margin.
    const nx = noiseX(t);
    const ny = noiseY(t + 1000);

    const halfW = Math.max(0, vw / 2 - MARGIN);
    const halfH = Math.max(0, vh / 2 - MARGIN);
    curX = vw / 2 + nx * halfW;
    curY = vh / 2 + ny * halfH;

    // Tiny rotation wobble so it feels alive but readable.
    const wobble = Math.sin((now - startTime) / 700) * 4;

    cursorEl.style.transform =
      `translate3d(${curX.toFixed(2)}px, ${curY.toFixed(2)}px, 0) rotate(${wobble.toFixed(2)}deg)`;

    if (bubbleEl && bubbleEl.classList.contains("is-visible")) {
      positionBubble();
    }
  }

  // ---------- Bubble positioning ----------
  function positionBubble() {
    if (!bubbleEl) return;
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    let bx = curX + BUBBLE_OFFSET_X;
    let by = curY + BUBBLE_OFFSET_Y;
    const rect = bubbleEl.getBoundingClientRect();
    const bw = rect.width || 120;
    const bh = rect.height || 40;
    if (bx + bw + 4 > vw) bx = curX - bw - BUBBLE_OFFSET_X;
    if (by + bh + 4 > vh) by = vh - bh - 4;
    if (by < 4) by = 4;
    if (bx < 4) bx = 4;
    bubbleEl.style.transform = `translate3d(${bx.toFixed(2)}px, ${by.toFixed(2)}px, 0)`;
  }

  // ---------- Bubble content ----------
  let hideTimer = 0;
  function showBubble({ listening = false } = {}) {
    if (!bubbleEl) return;
    clearTimeout(hideTimer);
    bubbleEl.classList.toggle("is-listening", !!listening);
    bubbleEl.classList.add("is-visible");
    positionBubble();
  }
  function hideBubbleSoon(delay = BUBBLE_LINGER_MS) {
    if (!bubbleEl) return;
    clearTimeout(hideTimer);
    hideTimer = setTimeout(() => {
      if (bubbleEl) bubbleEl.classList.remove("is-visible", "is-listening", "is-empty");
    }, delay);
  }
  function escapeText(s) {
    return String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  }
  function setBubbleText({ finalText = "", interimText = "" } = {}) {
    if (!bubbleEl) return;
    const isEmpty = !finalText && !interimText;
    bubbleEl.classList.toggle("is-empty", isEmpty);
    if (isEmpty) {
      bubbleEl.textContent = "🎤 Listening… (press hotkey to stop)";
    } else {
      const finalHtml = escapeText(finalText);
      const interimHtml = interimText
        ? `<span class="bgc-interim">${finalText ? " " : ""}${escapeText(interimText)}</span>`
        : "";
      bubbleEl.innerHTML = `${finalHtml}${interimHtml}`;
    }
    positionBubble();
  }

  // ---------- Speech recognition (via offscreen document) ----------
  // The actual SpeechRecognition runs in the extension's offscreen document
  // so it is not blocked by the host page's Permissions-Policy, and the mic
  // permission prompt is granted once per extension instead of per site.
  let listeningLocal = false;
  let bubbleHasText = false;

  function errorMessage(code) {
    switch (code) {
      case "not-allowed":
      case "service-not-allowed":
        return "Microphone permission denied. Click the mic icon in the address bar / extension settings to allow.";
      case "no-speech": return "Didn't catch that.";
      case "audio-capture": return "No microphone available.";
      case "unsupported": return "Speech recognition not supported in this browser.";
      case "init-failed":
      case "start-failed": return "Couldn't start mic. Try again.";
      case "network": return "Network error reaching speech service.";
      default: return "Mic error.";
    }
  }

  function startRecognition() {
    if (!enabled) {
      LOG("startRecognition: ignored — extension disabled");
      return;
    }
    if (listeningLocal) {
      LOG("startRecognition: already listening, sending stop");
      stopRecognition();
      return;
    }
    // Make sure the cursor is mounted so the bubble has somewhere to live.
    mount();
    // Optimistically show the bubble immediately so the user gets feedback;
    // the offscreen doc will confirm with bgc:listening shortly.
    showBubble({ listening: true });
    setBubbleText({});
    bubbleHasText = false;
    LOG("startRecognition: sending bgc:start to background");
    try {
      chrome.runtime.sendMessage(
        { type: "bgc:start", lang: navigator.language || "en-US" },
        (resp) => {
          if (chrome.runtime.lastError) {
            LOG("bgc:start sendMessage error", chrome.runtime.lastError.message);
            setBubbleText({ finalText: "Reload this page to activate the extension." });
            hideBubbleSoon(3500);
          } else {
            LOG("bgc:start ack", resp);
          }
        }
      );
    } catch (e) {
      LOG("bgc:start threw", e);
      setBubbleText({ finalText: "Reload this page to activate the extension." });
      hideBubbleSoon(3500);
    }
  }

  function stopRecognition() {
    try {
      chrome.runtime.sendMessage({ type: "bgc:stop" });
    } catch (_) {}
  }

  // Receive events from the offscreen doc (forwarded by background) and from
  // the popup (ping / trigger).
  let runtimeMessageListener = null;
  try {
    runtimeMessageListener = (msg, _sender, sendResponse) => {
      if (!msg || typeof msg !== "object") return;
      // Popup messages
      if (window.__bgcPopupHandler) {
        const resp = window.__bgcPopupHandler(msg);
        if (resp !== undefined) {
          sendResponse(resp);
          return true;
        }
      }
      if (msg.type === "bgc:listening") {
        LOG("listening ack");
        listeningLocal = true;
        mount();
        showBubble({ listening: true });
        if (!bubbleHasText) setBubbleText({});
      } else if (msg.type === "bgc:result") {
        LOG("result", { final: msg.finalText, interim: msg.interim });
        listeningLocal = true;
        bubbleHasText = !!(msg.finalText || msg.interim);
        mount();
        showBubble({ listening: true });
        setBubbleText({ finalText: msg.finalText || "", interimText: msg.interim || "" });
      } else if (msg.type === "bgc:end") {
        LOG("end", msg);
        listeningLocal = false;
        if (bubbleEl) bubbleEl.classList.remove("is-listening");
        if (!msg.finalText && !bubbleHasText) hideBubbleSoon(900);
        else hideBubbleSoon(BUBBLE_LINGER_MS);
      } else if (msg.type === "bgc:error") {
        LOG("error", msg.error);
        listeningLocal = false;
        mount();
        showBubble();
        setBubbleText({ finalText: errorMessage(msg.error) });
        bubbleHasText = true;
        hideBubbleSoon(3500);
      }
    };
    chrome.runtime.onMessage.addListener(runtimeMessageListener);
  } catch (_) {}

  // ---------- Hotkey ----------
  function parseHotkey(spec) {
    const parts = String(spec || "").toLowerCase().split("+").map(s => s.trim()).filter(Boolean);
    if (!parts.length) return null;
    const key = parts.pop();
    return {
      key,
      alt: parts.includes("alt") || parts.includes("option"),
      shift: parts.includes("shift"),
      ctrl: parts.includes("ctrl") || parts.includes("control"),
      meta: parts.includes("meta") || parts.includes("cmd") || parts.includes("command"),
    };
  }
  function eventMatches(e, parsed) {
    if (!parsed) return false;
    if (e.altKey !== parsed.alt) return false;
    if (e.shiftKey !== parsed.shift) return false;
    if (e.ctrlKey !== parsed.ctrl) return false;
    if (e.metaKey !== parsed.meta) return false;
    const k = (e.key || "").toLowerCase();
    const code = (e.code || "").toLowerCase();
    const codeKey = code.startsWith("key") ? code.slice(3) : code;
    return k === parsed.key || codeKey === parsed.key;
  }
  function onKeyDown(e) {
    const target = e.target;
    if (target && target.isContentEditable) return;
    if (target && /^(input|textarea|select)$/i.test(target.tagName)) return;
    const parsed = parseHotkey(hotkey);
    if (eventMatches(e, parsed)) {
      e.preventDefault();
      e.stopPropagation();
      startRecognition(); // toggles
    }
  }
  window.addEventListener("keydown", onKeyDown, true);

  // ---------- Settings sync ----------
  function applyEnabled(next) {
    enabled = !!next;
    if (enabled) mount();
    else unmount();
  }

  function applySpeed(next) {
    const n = Number(next);
    if (Number.isFinite(n) && n > 0) speed = Math.min(4, Math.max(0.1, n));
  }
  function applyHotkey(next) {
    if (typeof next === "string" && next.trim()) hotkey = next.trim();
  }

  let storageListener = null;
  try {
    chrome.storage?.local.get([STORAGE_KEY, SPEED_KEY, HOTKEY_KEY], (res) => {
      if (res && Object.prototype.hasOwnProperty.call(res, SPEED_KEY)) applySpeed(res[SPEED_KEY]);
      if (res && Object.prototype.hasOwnProperty.call(res, HOTKEY_KEY)) applyHotkey(res[HOTKEY_KEY]);
      // Default to enabled when key missing.
      const initial = !res || res[STORAGE_KEY] !== false;
      LOG("initial settings", { enabled: initial, speed, hotkey });
      applyEnabled(initial);
    });

    storageListener = (changes, area) => {
      if (area !== "local") return;
      if (changes[STORAGE_KEY]) applyEnabled(changes[STORAGE_KEY].newValue !== false);
      if (changes[SPEED_KEY]) applySpeed(changes[SPEED_KEY].newValue);
      if (changes[HOTKEY_KEY]) applyHotkey(changes[HOTKEY_KEY].newValue);
    };
    chrome.storage?.onChanged.addListener(storageListener);
  } catch (_) {
    // Extension context lost / not available — just mount with defaults.
    applyEnabled(true);
  }

  // Handle messages from the popup ("ping" / "trigger") in addition to the
  // recognition events declared below.
  function popupHandler(msg) {
    if (!msg || typeof msg !== "object") return undefined;
    if (msg.type === "bgc:ping") return { ok: true, mounted: !!(root && root.isConnected) };
    if (msg.type === "bgc:trigger") {
      startRecognition();
      return { ok: true };
    }
    return undefined;
  }
  // The main runtime listener is registered later (recognition events). We
  // augment it via the same `runtimeMessageListener`.

  // Resume rAF cleanly when tab becomes visible again.
  function onVisibility() {
    const visible = !document.hidden;
    if (visible && !lastVisibility && enabled && !rafId) {
      rafId = requestAnimationFrame(tick);
    }
    lastVisibility = visible;
  }
  document.addEventListener("visibilitychange", onVisibility);

  // Publish the disposer so a future re-injection can tear us down cleanly.
  window.__blueGhostCursor = { dispose };
  LOG("loaded on", location.href);

  // Expose popupHandler to the runtime listener (closure capture).
  window.__bgcPopupHandler = popupHandler;
})();
