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
import { send } from "../lib/messages";
import { newId } from "../lib/ids";
import { capturePageContext, captureFormContext } from "../lib/page-context";
import { DwellTracker, type DwellSnapshot } from "../lib/dwell";
import type { RawEvent, Fingerprint, PageContext, FormContext, DwellMeta } from "../lib/types";

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
  function emit(
    kind: RawEvent["kind"],
    fingerprint?: Fingerprint,
    extras?: {
      pageContext?: PageContext;
      formContext?: FormContext;
      meta?: Record<string, unknown>;
    },
  ) {
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
    void send({ t: "evt", event: ev });
  }

  function emitDwell(snap: DwellSnapshot) {
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
    void send({ t: "evt", event: ev });
  }

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
  window.addEventListener(
    "click",
    (e) => {
      tracker.recordInteraction();
      const fp = fingerprintOf(e.target, location.href);
      if (!fp) return;
      emit("click", fp, {
        meta: {
          button: (e as MouseEvent).button,
          modifiers: modifiers(e as MouseEvent),
        },
      });
    },
    { capture: true, passive: true },
  );

  // ---- submit -----------------------------------------------------------
  window.addEventListener(
    "submit",
    (e) => {
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
      const el = e.target;
      if (!(el instanceof Element)) return;
      const prev = inputDebounce.get(el);
      if (prev) clearTimeout(prev);
      const handle = window.setTimeout(() => {
        inputDebounce.delete(el);
        tracker.recordInteraction();
        const fp = fingerprintOf(el, location.href);
        if (!fp) return;
        emit("input-edited", fp);
      }, INPUT_DEBOUNCE_MS);
      inputDebounce.set(el, handle);
    },
    { capture: true, passive: true },
  );

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

function modifiers(e: MouseEvent): string[] {
  const m: string[] = [];
  if (e.altKey) m.push("alt");
  if (e.ctrlKey) m.push("ctrl");
  if (e.metaKey) m.push("meta");
  if (e.shiftKey) m.push("shift");
  return m;
}
