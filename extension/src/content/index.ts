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
const AGENT_PANEL_ROOT_ID = "notion-hack-agent-panel-root";
const AGENT_PANEL_STYLE_ID = "notion-hack-agent-panel-style";
const IS_TOP_FRAME = (() => {
  try {
    return window.self === window.top;
  } catch {
    return false;
  }
})();

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

  if (IS_TOP_FRAME) {
    try {
      mountAgentPanel();
    } catch (e) {
      log.error("agent panel mount failed", e);
    }
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
  let lastPointerTarget: EventTarget | null = null;
  let lastPointerAt = 0;

  function captureInteraction(e: MouseEvent | PointerEvent, source: "click" | "pointerdown") {
    if (isAgentPanelEvent(e)) return;
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
      if (isAgentPanelEvent(e)) return;
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
      if (isAgentPanelEvent(e)) return;
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

function mountAgentPanel() {
  const mountTarget = document.body || document.documentElement;
  if (!mountTarget) {
    window.setTimeout(mountAgentPanel, 50);
    return;
  }

  document.getElementById(AGENT_PANEL_ROOT_ID)?.remove();
  if (!document.getElementById(AGENT_PANEL_STYLE_ID)) {
    const style = document.createElement("style");
    style.id = AGENT_PANEL_STYLE_ID;
    style.textContent = AGENT_PANEL_CSS;
    document.documentElement.appendChild(style);
  }

  const root = document.createElement("section");
  root.id = AGENT_PANEL_ROOT_ID;
  root.setAttribute("aria-label", "Agent orchestrator");
  root.tabIndex = 0;
  root.innerHTML = `
    <div class="nh-agent-collapsed" aria-hidden="true">
      <span class="nh-agent-dot"></span>
    </div>
    <div class="nh-agent-expanded" aria-hidden="true">
      <div class="nh-agent-header">
        <div class="nh-agent-title-row">
          <span class="nh-agent-status-dot"></span>
          <span class="nh-agent-title">Orchestrator</span>
        </div>
        <span class="nh-agent-status">3 running</span>
      </div>
      <div class="nh-agent-list">
        <div class="nh-agent-row">
          <div class="nh-agent-row-top">
            <span class="nh-agent-name"><span class="nh-agent-row-dot is-green"></span>Auth Agent</span>
            <span class="nh-agent-file">jwt-service.ts</span>
          </div>
          <div class="nh-agent-task">Signing with RS256...</div>
        </div>
        <div class="nh-agent-row">
          <div class="nh-agent-row-top">
            <span class="nh-agent-name"><span class="nh-agent-row-dot is-blue"></span>API Agent</span>
            <span class="nh-agent-file">routes/auth.ts</span>
          </div>
          <div class="nh-agent-task">Validating headers...</div>
        </div>
        <div class="nh-agent-row">
          <div class="nh-agent-row-top">
            <span class="nh-agent-name"><span class="nh-agent-row-dot is-purple"></span>Test Agent</span>
            <span class="nh-agent-file">auth.test.ts</span>
          </div>
          <div class="nh-agent-task">Mocking responses...</div>
        </div>
      </div>
    </div>
  `;
  mountTarget.appendChild(root);
}

function isAgentPanelEvent(e: Event): boolean {
  const target = e.target;
  return target instanceof Element && !!target.closest(`#${AGENT_PANEL_ROOT_ID}`);
}

const AGENT_PANEL_CSS = `
#${AGENT_PANEL_ROOT_ID} {
  position: fixed;
  right: 18px;
  bottom: 18px;
  width: 46px;
  height: 46px;
  z-index: 2147483647;
  box-sizing: border-box;
  border: 1px solid rgba(47, 140, 255, 0.18);
  border-radius: 14px;
  background: #101318;
  box-shadow: 0 16px 42px rgba(0, 0, 0, 0.28), 0 0 0 1px rgba(255, 255, 255, 0.03);
  color: #eef3f8;
  font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
  overflow: hidden;
  pointer-events: auto;
  user-select: none;
  transition: width 180ms ease, height 180ms ease, border-radius 180ms ease, box-shadow 180ms ease;
}

#${AGENT_PANEL_ROOT_ID},
#${AGENT_PANEL_ROOT_ID} * {
  box-sizing: border-box;
}

#${AGENT_PANEL_ROOT_ID}:hover,
#${AGENT_PANEL_ROOT_ID}:focus,
#${AGENT_PANEL_ROOT_ID}:focus-within {
  width: 292px;
  height: 178px;
  border-radius: 16px;
  box-shadow: 0 22px 58px rgba(0, 0, 0, 0.36), 0 0 0 1px rgba(255, 255, 255, 0.04);
  outline: none;
}

#${AGENT_PANEL_ROOT_ID} .nh-agent-collapsed {
  position: absolute;
  inset: 0;
  display: grid;
  place-items: center;
  transition: opacity 120ms ease;
}

#${AGENT_PANEL_ROOT_ID}:hover .nh-agent-collapsed,
#${AGENT_PANEL_ROOT_ID}:focus .nh-agent-collapsed,
#${AGENT_PANEL_ROOT_ID}:focus-within .nh-agent-collapsed {
  opacity: 0;
}

#${AGENT_PANEL_ROOT_ID} .nh-agent-dot {
  width: 16px;
  height: 16px;
  border-radius: 6px;
  background: #2f8cff;
  box-shadow: 0 0 0 6px rgba(47, 140, 255, 0.12);
}

#${AGENT_PANEL_ROOT_ID} .nh-agent-expanded {
  opacity: 0;
  transform: translateY(6px);
  transition: opacity 140ms ease 55ms, transform 140ms ease 55ms;
}

#${AGENT_PANEL_ROOT_ID}:hover .nh-agent-expanded,
#${AGENT_PANEL_ROOT_ID}:focus .nh-agent-expanded,
#${AGENT_PANEL_ROOT_ID}:focus-within .nh-agent-expanded {
  opacity: 1;
  transform: translateY(0);
}

#${AGENT_PANEL_ROOT_ID} .nh-agent-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 10px;
  padding: 13px 14px 10px;
  border-bottom: 1px solid rgba(255, 255, 255, 0.07);
}

#${AGENT_PANEL_ROOT_ID} .nh-agent-title-row {
  display: flex;
  align-items: center;
  min-width: 0;
  gap: 8px;
}

#${AGENT_PANEL_ROOT_ID} .nh-agent-status-dot {
  flex: 0 0 auto;
  width: 8px;
  height: 8px;
  border-radius: 50%;
  background: #20c76f;
  box-shadow: 0 0 0 3px rgba(32, 199, 111, 0.12);
}

#${AGENT_PANEL_ROOT_ID} .nh-agent-title {
  overflow: hidden;
  color: #f4f4f4;
  font-size: 13px;
  line-height: 1;
  font-weight: 650;
  letter-spacing: 0;
  text-overflow: ellipsis;
  white-space: nowrap;
}

#${AGENT_PANEL_ROOT_ID} .nh-agent-status {
  display: inline-flex;
  align-items: center;
  max-width: 96px;
  height: 22px;
  padding: 0 8px;
  border-radius: 6px;
  background: rgba(47, 140, 255, 0.13);
  color: #87bfff;
  font-size: 10px;
  line-height: 1;
  font-weight: 650;
  letter-spacing: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

#${AGENT_PANEL_ROOT_ID} .nh-agent-list {
  display: grid;
  gap: 0;
  padding: 4px 8px 8px;
}

#${AGENT_PANEL_ROOT_ID} .nh-agent-row {
  min-width: 0;
  padding: 8px 6px;
  border-radius: 9px;
}

#${AGENT_PANEL_ROOT_ID} .nh-agent-row + .nh-agent-row {
  border-top: 1px solid rgba(255, 255, 255, 0.055);
}

#${AGENT_PANEL_ROOT_ID} .nh-agent-row-top {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  margin-bottom: 5px;
}

#${AGENT_PANEL_ROOT_ID} .nh-agent-name {
  display: inline-flex;
  align-items: center;
  min-width: 0;
  gap: 7px;
  overflow: hidden;
  color: #eeeeee;
  font-size: 12px;
  line-height: 1;
  font-weight: 650;
  letter-spacing: 0;
  text-overflow: ellipsis;
  white-space: nowrap;
}

#${AGENT_PANEL_ROOT_ID} .nh-agent-row-dot {
  flex: 0 0 auto;
  width: 7px;
  height: 7px;
  border-radius: 50%;
}

#${AGENT_PANEL_ROOT_ID} .nh-agent-row-dot.is-green {
  background: #229653;
}

#${AGENT_PANEL_ROOT_ID} .nh-agent-row-dot.is-blue {
  background: #2f7de1;
}

#${AGENT_PANEL_ROOT_ID} .nh-agent-row-dot.is-purple {
  background: #8e47d6;
}

#${AGENT_PANEL_ROOT_ID} .nh-agent-file {
  flex: 0 0 auto;
  overflow: hidden;
  max-width: 96px;
  color: #788492;
  font-size: 10px;
  line-height: 1;
  font-weight: 500;
  letter-spacing: 0;
  text-overflow: ellipsis;
  white-space: nowrap;
}

#${AGENT_PANEL_ROOT_ID} .nh-agent-task {
  overflow: hidden;
  padding-left: 14px;
  color: #8f99a6;
  font-size: 11px;
  line-height: 1;
  font-weight: 400;
  letter-spacing: 0;
  text-overflow: ellipsis;
  white-space: nowrap;
}
`;

function modifiers(e: MouseEvent): string[] {
  const m: string[] = [];
  if (e.altKey) m.push("alt");
  if (e.ctrlKey) m.push("ctrl");
  if (e.metaKey) m.push("meta");
  if (e.shiftKey) m.push("shift");
  return m;
}
