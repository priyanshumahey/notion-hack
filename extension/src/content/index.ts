// Content script. Runs in the page context of every URL.
//
// Responsibilities (this step):
//   1. Capture user interactions: click, submit, input-edited.
//   2. Capture SPA navigations (history.pushState/replaceState + popstate).
//   3. Build a fingerprint for the target element.
//   4. Post each event to the background SW via the typed message channel.
//
// We deliberately do NOT touch input values. Only the fact that an input was
// edited, and a fingerprint of which input it was.

import { makeLog } from "../lib/log";
import { canonicalizeUrl } from "../lib/canonicalize";
import { fingerprintOf } from "../lib/fingerprint";
import { send } from "../lib/messages";
import { newId } from "../lib/ids";
import type { RawEvent, Fingerprint } from "../lib/types";

const log = makeLog("content");

// Guard against double-injection (HMR / re-injection after install).
if ((window as unknown as { __nhInstalled?: boolean }).__nhInstalled) {
  log.warn("content script already installed on this page, skipping");
} else {
  (window as unknown as { __nhInstalled?: boolean }).__nhInstalled = true;
  install();
}

function install() {
  log("loaded on", location.href);

  // ---- helpers ----------------------------------------------------------
  function emit(kind: RawEvent["kind"], fingerprint?: Fingerprint, meta?: Record<string, unknown>) {
    const url = location.href;
    const ev: RawEvent = {
      id: newId(),
      ts: Date.now(),
      url,
      pageKey: canonicalizeUrl(url),
      kind,
      fingerprint,
      meta,
    };
    log(kind, ev);
    void send({ t: "evt", event: ev });
  }

  // ---- click ------------------------------------------------------------
  // Use capture-phase + passive listener so we always observe, even if the
  // page calls stopPropagation on its own handlers.
  window.addEventListener(
    "click",
    (e) => {
      const fp = fingerprintOf(e.target, location.href);
      // Skip clicks on raw text / non-interactive nodes that produce no fp.
      if (!fp) return;
      emit("click", fp, {
        button: (e as MouseEvent).button,
        modifiers: modifiers(e as MouseEvent),
      });
    },
    { capture: true, passive: true },
  );

  // ---- submit -----------------------------------------------------------
  window.addEventListener(
    "submit",
    (e) => {
      const fp = fingerprintOf(e.target, location.href);
      emit("submit", fp);
    },
    { capture: true, passive: true },
  );

  // ---- input-edited (debounced) -----------------------------------------
  // We don't capture keystrokes; we just want one event per logical "I
  // edited this field". Debounce per element identity.
  const inputDebounce = new WeakMap<Element, number>();
  const INPUT_DEBOUNCE_MS = 800;
  window.addEventListener(
    "input",
    (e) => {
      const el = e.target;
      if (!(el instanceof Element)) return;
      const prev = inputDebounce.get(el);
      if (prev) clearTimeout(prev);
      const handle = window.setTimeout(() => {
        inputDebounce.delete(el);
        const fp = fingerprintOf(el, location.href);
        if (!fp) return;
        emit("input-edited", fp);
      }, INPUT_DEBOUNCE_MS);
      inputDebounce.set(el, handle);
    },
    { capture: true, passive: true },
  );

  // ---- SPA navigations --------------------------------------------------
  // chrome.webNavigation in the bg sees pushState commits, but ALSO firing a
  // nav event from the content side gives us a same-frame ordering guarantee
  // relative to clicks. The bg de-dupes by id+url+kind in a future step.
  let lastUrl = location.href;
  function checkUrlChange(source: string) {
    if (location.href !== lastUrl) {
      lastUrl = location.href;
      emit("nav", undefined, { source });
    }
  }
  const wrap = (name: "pushState" | "replaceState") => {
    const original = history[name];
    history[name] = function (this: History, ...args: Parameters<History["pushState"]>) {
      const ret = original.apply(this, args);
      // Defer one microtask so location.href reflects the new URL.
      queueMicrotask(() => checkUrlChange(name));
      return ret;
    } as History[typeof name];
  };
  wrap("pushState");
  wrap("replaceState");
  window.addEventListener("popstate", () => checkUrlChange("popstate"));
  window.addEventListener("hashchange", () => checkUrlChange("hashchange"));

  // Emit one nav event for the initial page load too, so the recent log
  // always has a "you started here" anchor per tab.
  emit("nav", undefined, { source: "initial" });
}

function modifiers(e: MouseEvent): string[] {
  const m: string[] = [];
  if (e.altKey) m.push("alt");
  if (e.ctrlKey) m.push("ctrl");
  if (e.metaKey) m.push("meta");
  if (e.shiftKey) m.push("shift");
  return m;
}
