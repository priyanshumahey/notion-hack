/* Offscreen document: hosts the Web Speech API on the extension's origin so
 * it isn't blocked by the host page's Permissions-Policy and so the mic
 * prompt is granted once per extension instead of per site. */

const LOG = (...args) => console.log("[BGC offscreen]", ...args);
LOG("loaded");

const Ctor = self.SpeechRecognition || self.webkitSpeechRecognition;
LOG("SR constructor:", Ctor ? "available" : "missing");

let recognition = null;
let lastFinal = "";

function send(payload) {
  try {
    chrome.runtime.sendMessage({ target: "background", ...payload });
  } catch (_) {
    /* background not listening yet — ignore */
  }
}

async function ensureMicPermission() {
  // Triggers the per-extension mic permission prompt the first time. After
  // the user accepts, future SpeechRecognition starts won't prompt again.
  try {
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    // We don't actually need the stream; close it immediately so SR can use mic.
    stream.getTracks().forEach((t) => t.stop());
    return true;
  } catch (e) {
    send({ type: "bgc:error", error: e && e.name === "NotAllowedError" ? "not-allowed" : "audio-capture" });
    return false;
  }
}

async function start(lang) {
  LOG("start requested, lang =", lang);
  if (!Ctor) {
    send({ type: "bgc:error", error: "unsupported" });
    return;
  }
  if (recognition) {
    LOG("already running, ignoring");
    return;
  }

  const ok = await ensureMicPermission();
  LOG("mic permission ok?", ok);
  if (!ok) return;

  try {
    recognition = new Ctor();
  } catch (_) {
    send({ type: "bgc:error", error: "init-failed" });
    return;
  }
  recognition.continuous = true;
  recognition.interimResults = true;
  recognition.lang = lang || navigator.language || "en-US";
  lastFinal = "";

  recognition.onstart = () => { LOG("recognition.onstart"); send({ type: "bgc:listening" }); };
  recognition.onresult = (event) => {
    let finalText = lastFinal;
    let interim = "";
    for (let i = event.resultIndex; i < event.results.length; i++) {
      const res = event.results[i];
      const transcript = (res[0] && res[0].transcript) || "";
      if (res.isFinal) finalText += transcript;
      else interim += transcript;
    }
    lastFinal = finalText;
    send({
      type: "bgc:result",
      finalText: finalText.trim(),
      interim: interim.trim(),
    });
  };
  recognition.onerror = (event) => {
    const code = (event && event.error) || "error";
    LOG("recognition.onerror", code, event?.message || "");
    send({ type: "bgc:error", error: code });
  };
  recognition.onend = () => {
    LOG("recognition.onend, final =", lastFinal);
    send({ type: "bgc:end", finalText: (lastFinal || "").trim() });
    recognition = null;
  };

  try {
    recognition.start();
    LOG("recognition.start() called");
  } catch (e) {
    LOG("recognition.start() threw", e?.message);
    send({ type: "bgc:error", error: "start-failed" });
    recognition = null;
  }
}

function stop() {
  if (!recognition) return;
  try { recognition.stop(); } catch (_) {}
}

chrome.runtime.onMessage.addListener((msg) => {
  if (!msg || msg.target !== "offscreen") return;
  if (msg.type === "bgc:start") start(msg.lang);
  else if (msg.type === "bgc:stop") stop();
});
