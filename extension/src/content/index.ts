// Content script. Runs in the page context of every URL.
//
// Responsibilities:
//   1. Capture user interactions: click, submit, input-edited.
//   2. Capture SPA navigations (history.pushState/replaceState + popstate).
//   3. Build a fingerprint for the target element.
//   4. Capture a structured page-context snapshot on nav + submit, and a
//      form-context snapshot on submit. See lib/page-context.ts.
//   5. Track engagement (foreground time, scroll, interactions) and emit
//      a `page-dwell` event on visibility-hide / SPA nav / page-hide.
//      See lib/dwell.ts.
//   6. Post each event to the background SW via the typed message channel.
//
// We do NOT touch input values per keystroke — only at submit time, and
// only via the form-context path (which excludes passwords).

import { makeLog } from "../lib/log";
import { canonicalizeUrl } from "../lib/canonicalize";
import { fingerprintOf } from "../lib/fingerprint";
import { send, isDeadContext, type Msg } from "../lib/messages";
import { newId } from "../lib/ids";
import { capturePageContext, captureFormContext } from "../lib/page-context";
import { DwellTracker, type DwellSnapshot } from "../lib/dwell";
import { createAgentStack, STACK_ROOT_ID } from "./agent-stack";
import type { RawEvent, Fingerprint, PageContext, FormContext, DwellMeta } from "../lib/types";

const log = makeLog("content");
const IS_TOP_FRAME = (() => {
  try {
    return window.self === window.top;
  } catch {
    return false;
  }
})();

// Lazily created on first completionPrompt the top frame receives.
let agentStack: ReturnType<typeof createAgentStack> | null = null;

function install() {
  log("loaded on", location.href);

  // ---- dwell tracker (one per URL) --------------------------------------
  let tracker = new DwellTracker(location.href, canonicalizeUrl(location.href));

  function flushDwell(reason: DwellMeta["reason"]) {
    const snap = tracker.flush(reason);
    if (snap) emitDwell(snap);
  }

  function rotateTracker(newUrl: string) {
    // Emit the previous page's dwell BEFORE we move on.
    flushDwell("spa-nav");
    tracker = new DwellTracker(newUrl, canonicalizeUrl(newUrl));
  }

  // ---- helpers ----------------------------------------------------------
  let deadWarned = false;
  function warnDeadOnce() {
    if (deadWarned) return;
    deadWarned = true;
    log.error(
      "extension context invalidated — content script can no longer reach background. " +
        "Reload this page to re-inject. Until then events on this tab are lost.",
    );
  }

  function emit(
    kind: RawEvent["kind"],
    fingerprint?: Fingerprint,
    extras?: {
      pageContext?: PageContext;
      formContext?: FormContext;
      meta?: Record<string, unknown>;
    },
  ) {
    if (isDeadContext()) {
      warnDeadOnce();
      return;
    }
    const url = location.href;
    const ev: RawEvent = {
      id: newId(),
      ts: Date.now(),
      url,
      pageKey: canonicalizeUrl(url),
      kind,
      fingerprint,
      pageContext: extras?.pageContext,
      formContext: extras?.formContext,
      meta: extras?.meta,
    };
    log(kind, ev);
    void send({ t: "evt", event: ev }).then((resp) => {
      if (resp.t === "error") {
        if (isDeadContext()) warnDeadOnce();
        else log.warn("send failed", kind, resp.message);
      }
    });
  }

  function emitDwell(snap: DwellSnapshot) {
    if (isDeadContext()) {
      warnDeadOnce();
      return;
    }
    const ev: RawEvent = {
      id: newId(),
      ts: Date.now(),
      url: snap.url,
      pageKey: snap.pageKey,
      kind: "page-dwell",
      pageContext: snap.pageContext,
      meta: snap.meta as unknown as Record<string, unknown>,
    };
    log("page-dwell", ev);
    void send({ t: "evt", event: ev }).then((resp) => {
      if (resp.t === "error") {
        if (isDeadContext()) warnDeadOnce();
        else log.warn("send dwell failed", resp.message);
      }
    });
  }

  if (IS_TOP_FRAME) installCompletionPromptListener();

  /** Best-effort page-context capture. Never throws; returns undefined on hard failure. */
  function safeCapturePage(): PageContext | undefined {
    try {
      return capturePageContext();
    } catch (e) {
      log.error("page-context capture failed", e);
      return undefined;
    }
  }

  // ---- click ------------------------------------------------------------
  let lastPointerTarget: EventTarget | null = null;
  let lastPointerAt = 0;

  function captureInteraction(e: MouseEvent | PointerEvent, source: "click" | "pointerdown") {
    if (isExtensionUiEvent(e)) return;
    if (source === "pointerdown") {
      const pe = e as PointerEvent;
      if (pe.button !== 0 || !pe.isPrimary) return;
      lastPointerTarget = e.target;
      lastPointerAt = Date.now();
    } else if (lastPointerTarget === e.target && Date.now() - lastPointerAt < 700) {
      return;
    }

    tracker.recordInteraction();
    let fp: Fingerprint | undefined;
    try {
      fp = fingerprintOf(e.target, location.href);
    } catch (err) {
      log.error("fingerprint failed", err);
    }
    if (!fp) return;
    emit("click", fp, {
      meta: {
        source,
        button: e.button,
        modifiers: modifiers(e),
        frame: IS_TOP_FRAME ? "top" : "child",
      },
    });
  }

  window.addEventListener(
    "pointerdown",
    (e) => captureInteraction(e, "pointerdown"),
    { capture: true, passive: true },
  );

  window.addEventListener(
    "click",
    (e) => captureInteraction(e, "click"),
    { capture: true, passive: true },
  );

  // ---- submit -----------------------------------------------------------
  window.addEventListener(
    "submit",
    (e) => {
      if (isExtensionUiEvent(e)) return;
      tracker.recordInteraction();
      const target = e.target;
      const fp = fingerprintOf(target, location.href);
      let formContext: FormContext | undefined;
      if (target instanceof HTMLFormElement) {
        try {
          formContext = captureFormContext(target);
        } catch (err) {
          log.error("form-context capture failed", err);
        }
      }
      emit("submit", fp, {
        pageContext: safeCapturePage(),
        formContext,
      });
    },
    { capture: true, passive: true },
  );

  // ---- input-edited (debounced) -----------------------------------------
  const inputDebounce = new WeakMap<Element, number>();
  const INPUT_DEBOUNCE_MS = 800;
  window.addEventListener(
    "input",
    (e) => {
      if (isExtensionUiEvent(e)) return;
      const el = e.target;
      if (!(el instanceof Element)) return;
      const prev = inputDebounce.get(el);
      if (prev) clearTimeout(prev);
      const handle = window.setTimeout(() => {
        inputDebounce.delete(el);
        tracker.recordInteraction();
        let fp: Fingerprint | undefined;
        try {
          fp = fingerprintOf(el, location.href);
        } catch (err) {
          log.error("input fingerprint failed", err);
        }
        if (!fp) return;
        emit("input-edited", fp, {
          meta: {
            frame: IS_TOP_FRAME ? "top" : "child",
          },
        });
      }, INPUT_DEBOUNCE_MS);
      inputDebounce.set(el, handle);
    },
    { capture: true, passive: true },
  );

  if (!IS_TOP_FRAME) return;

  // ---- scroll (throttled by rAF) ----------------------------------------
  let scrollPending = false;
  window.addEventListener(
    "scroll",
    () => {
      if (scrollPending) return;
      scrollPending = true;
      requestAnimationFrame(() => {
        scrollPending = false;
        tracker.recordScroll();
      });
    },
    { capture: true, passive: true },
  );

  // ---- visibility / page lifecycle --------------------------------------
  document.addEventListener("visibilitychange", () => {
    tracker.onVisibilityChange();
    if (document.hidden) {
      // Tab going to background or being closed — best chance to emit.
      flushDwell("visibility-hidden");
    }
  });
  // pagehide is more reliable than unload on modern browsers, fires on
  // bfcache eviction too. Last call to flush.
  window.addEventListener("pagehide", () => {
    flushDwell("page-hide");
  });

  // ---- SPA navigations --------------------------------------------------
  let lastUrl = location.href;
  let pendingSettleTimer: number | null = null;
  let pendingSettleUrl: string | null = null;
  const SETTLE_MS = 700;

  function onUrlMaybeChanged(source: string) {
    if (location.href === lastUrl) return;
    const oldUrl = lastUrl;
    lastUrl = location.href;
    // 1) Flush dwell for the page we just left, start a fresh tracker for
    //    the new URL.
    rotateTracker(location.href);
    log("spa nav", oldUrl, "→", location.href);
    // 2) Emit immediate "early" nav (no context yet).
    emit("nav", undefined, { meta: { source: source + "-early" } });
    // 3) Schedule settled snapshot.
    if (pendingSettleTimer != null) clearTimeout(pendingSettleTimer);
    pendingSettleUrl = location.href;
    pendingSettleTimer = window.setTimeout(() => {
      pendingSettleTimer = null;
      if (location.href !== pendingSettleUrl) return;
      emit("nav", undefined, {
        pageContext: safeCapturePage(),
        meta: { source: source + "-settled" },
      });
    }, SETTLE_MS);
  }

  const wrap = (name: "pushState" | "replaceState") => {
    const original = history[name];
    history[name] = function (this: History, ...args: Parameters<History["pushState"]>) {
      const ret = original.apply(this, args);
      queueMicrotask(() => onUrlMaybeChanged(name));
      return ret;
    } as History[typeof name];
  };
  wrap("pushState");
  wrap("replaceState");
  window.addEventListener("popstate", () => onUrlMaybeChanged("popstate"));
  window.addEventListener("hashchange", () => onUrlMaybeChanged("hashchange"));

  // ---- Initial load -----------------------------------------------------
  function emitInitialNav() {
    emit("nav", undefined, {
      pageContext: safeCapturePage(),
      meta: { source: "initial" },
    });
  }
  if (document.readyState === "complete") {
    emitInitialNav();
  } else {
    let emitted = false;
    const fire = () => {
      if (emitted) return;
      emitted = true;
      emitInitialNav();
    };
    window.addEventListener("load", fire, { once: true });
    window.setTimeout(fire, 3000);
  }
}

function isAgentStackEvent(e: Event): boolean {
  const target = e.target;
  return target instanceof Element && !!target.closest(`#${STACK_ROOT_ID}`);
}

function isExtensionUiEvent(e: Event): boolean {
  return isAgentStackEvent(e);
}

function installCompletionPromptListener() {
  chrome.runtime.onMessage.addListener((msg: Msg) => {
    if (msg.t !== "completionPrompt") return;
    if (!agentStack) agentStack = createAgentStack();
    agentStack.push(msg);
  });
}

function modifiers(e: MouseEvent): string[] {
  const m: string[] = [];
  if (e.altKey) m.push("alt");
  if (e.ctrlKey) m.push("ctrl");
  if (e.metaKey) m.push("meta");
  if (e.shiftKey) m.push("shift");
  return m;
}

// Guard against double-injection (HMR / re-injection after install).
if ((window as unknown as { __nhInstalled?: boolean }).__nhInstalled) {
  log.warn("content script already installed on this page, skipping");
} else {
  (window as unknown as { __nhInstalled?: boolean }).__nhInstalled = true;
  install();
}
