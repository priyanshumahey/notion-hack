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
  root.setAttribute("aria-label", "Agent panel");
  root.tabIndex = 0;
  root.innerHTML = `
    <div class="nh-agent-collapsed" aria-hidden="true">
      <span class="nh-agent-dot"></span>
    </div>
    <div class="nh-agent-expanded" aria-hidden="true">
      <header class="nh-panel-header">
        <div class="nh-panel-title">
          <span class="nh-panel-dot"></span>
          <span class="nh-panel-name">Coordinator</span>
        </div>
        <span class="nh-panel-badge">orchestrating</span>
      </header>

      <div class="nh-panel-summary">Monitoring agent progress...</div>

      <div class="nh-agent-rows">
        <div class="nh-agent-tree" aria-hidden="true"></div>

        <div class="nh-agent-row">
          <div class="nh-agent-row-top">
            <span class="nh-agent-row-label">
              <span class="nh-row-dot is-green"></span>
              <span class="nh-row-name">Auth Agent</span>
            </span>
            <span class="nh-row-file">jwt-service.ts</span>
          </div>
          <div class="nh-agent-row-task">Signing with RS256...</div>
        </div>

        <div class="nh-agent-row">
          <div class="nh-agent-row-top">
            <span class="nh-agent-row-label">
              <span class="nh-row-dot is-blue"></span>
              <span class="nh-row-name">API Agent</span>
            </span>
            <span class="nh-row-file">routes/auth.ts</span>
          </div>
          <div class="nh-agent-row-task">Validating headers...</div>
        </div>

        <div class="nh-agent-row">
          <div class="nh-agent-row-top">
            <span class="nh-agent-row-label">
              <span class="nh-row-dot is-purple"></span>
              <span class="nh-row-name">Test Agent</span>
            </span>
            <span class="nh-row-file">auth.test.ts</span>
          </div>
          <div class="nh-agent-row-task">Mocking responses...</div>
        </div>
      </div>

      <footer class="nh-panel-footer">
        <span class="nh-footer-glyph">&#8596;</span>
        <span class="nh-footer-line">All agents synced to <span class="nh-footer-target">auth-refactor.md</span></span>
      </footer>
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
  --nh-bg: #0a0d12;
  --nh-border: rgba(255, 255, 255, 0.05);
  --nh-divider: rgba(255, 255, 255, 0.06);
  --nh-green: #22c55e;
  --nh-green-soft: rgba(34, 197, 94, 0.13);
  --nh-green-line: rgba(34, 197, 94, 0.55);
  --nh-text: #f1f4f8;
  --nh-text-muted: #6b7280;
  --nh-text-dim: #7a8290;

  position: fixed;
  right: 24px;
  top: 24px;
  width: 52px;
  height: 52px;
  z-index: 2147483647;
  box-sizing: border-box;
  border: 1px solid var(--nh-border);
  border-radius: 14px;
  background: var(--nh-bg);
  box-shadow:
    0 20px 50px rgba(0, 0, 0, 0.5),
    0 0 0 1px rgba(255, 255, 255, 0.02);
  color: var(--nh-text);
  font-family: ui-monospace, "SF Mono", SFMono-Regular, Menlo, "JetBrains Mono", "Geist Mono", "Roboto Mono", Consolas, monospace;
  overflow: hidden;
  pointer-events: auto;
  user-select: none;
  transition:
    width 220ms cubic-bezier(0.22, 0.61, 0.36, 1),
    height 220ms cubic-bezier(0.22, 0.61, 0.36, 1),
    border-radius 220ms ease,
    box-shadow 220ms ease;
}

#${AGENT_PANEL_ROOT_ID},
#${AGENT_PANEL_ROOT_ID} * {
  box-sizing: border-box;
}

#${AGENT_PANEL_ROOT_ID}:hover,
#${AGENT_PANEL_ROOT_ID}:focus,
#${AGENT_PANEL_ROOT_ID}:focus-within {
  width: 560px;
  height: 340px;
  border-radius: 18px;
  border-color: rgba(255, 255, 255, 0.07);
  box-shadow:
    0 30px 80px rgba(0, 0, 0, 0.6),
    0 0 0 1px rgba(255, 255, 255, 0.03);
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
  width: 12px;
  height: 12px;
  border-radius: 50%;
  background: var(--nh-green);
  box-shadow: 0 0 0 5px var(--nh-green-soft);
}

#${AGENT_PANEL_ROOT_ID} .nh-agent-expanded {
  position: absolute;
  inset: 0;
  display: flex;
  flex-direction: column;
  padding: 28px 32px 22px;
  opacity: 0;
  transform: translateY(6px);
  transition:
    opacity 180ms ease 80ms,
    transform 180ms ease 80ms;
}

#${AGENT_PANEL_ROOT_ID}:hover .nh-agent-expanded,
#${AGENT_PANEL_ROOT_ID}:focus .nh-agent-expanded,
#${AGENT_PANEL_ROOT_ID}:focus-within .nh-agent-expanded {
  opacity: 1;
  transform: translateY(0);
}

#${AGENT_PANEL_ROOT_ID} .nh-panel-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 16px;
}

#${AGENT_PANEL_ROOT_ID} .nh-panel-title {
  display: flex;
  align-items: center;
  gap: 14px;
  min-width: 0;
}

#${AGENT_PANEL_ROOT_ID} .nh-panel-dot {
  flex: 0 0 auto;
  width: 11px;
  height: 11px;
  border-radius: 50%;
  background: var(--nh-green);
  box-shadow: 0 0 0 4px var(--nh-green-soft);
}

#${AGENT_PANEL_ROOT_ID} .nh-panel-name {
  overflow: hidden;
  color: var(--nh-text);
  font-size: 18px;
  line-height: 1;
  font-weight: 700;
  letter-spacing: 0;
  text-overflow: ellipsis;
  white-space: nowrap;
}

#${AGENT_PANEL_ROOT_ID} .nh-panel-badge {
  display: inline-flex;
  align-items: center;
  height: 24px;
  padding: 0 10px;
  border-radius: 6px;
  background: var(--nh-green-soft);
  color: #4ade80;
  font-size: 12px;
  line-height: 1;
  font-weight: 500;
  letter-spacing: 0;
  white-space: nowrap;
}

#${AGENT_PANEL_ROOT_ID} .nh-panel-summary {
  margin: 14px 0 0 25px;
  color: var(--nh-text-muted);
  font-size: 13px;
  line-height: 1.2;
  font-weight: 400;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

#${AGENT_PANEL_ROOT_ID} .nh-agent-rows {
  position: relative;
  flex: 1 1 auto;
  display: flex;
  flex-direction: column;
  justify-content: space-around;
  margin-top: 18px;
  padding-left: 26px;
  min-height: 0;
}

#${AGENT_PANEL_ROOT_ID} .nh-agent-tree {
  position: absolute;
  left: 8px;
  top: 8px;
  bottom: 8px;
  width: 1.5px;
  background: var(--nh-green-line);
  border-radius: 1px;
  pointer-events: none;
}

#${AGENT_PANEL_ROOT_ID} .nh-agent-row {
  position: relative;
  min-width: 0;
  padding: 2px 0;
}

#${AGENT_PANEL_ROOT_ID} .nh-agent-row-top {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 14px;
  margin-bottom: 6px;
}

#${AGENT_PANEL_ROOT_ID} .nh-agent-row-label {
  display: inline-flex;
  align-items: center;
  gap: 12px;
  min-width: 0;
  overflow: hidden;
}

#${AGENT_PANEL_ROOT_ID} .nh-row-dot {
  flex: 0 0 auto;
  width: 8px;
  height: 8px;
  border-radius: 50%;
}

#${AGENT_PANEL_ROOT_ID} .nh-row-dot.is-green {
  background: #22c55e;
}

#${AGENT_PANEL_ROOT_ID} .nh-row-dot.is-blue {
  background: #4a8cff;
}

#${AGENT_PANEL_ROOT_ID} .nh-row-dot.is-purple {
  background: #a06bf0;
}

#${AGENT_PANEL_ROOT_ID} .nh-row-name {
  overflow: hidden;
  color: var(--nh-text);
  font-size: 14px;
  line-height: 1;
  font-weight: 600;
  letter-spacing: 0;
  text-overflow: ellipsis;
  white-space: nowrap;
}

#${AGENT_PANEL_ROOT_ID} .nh-row-file {
  flex: 0 0 auto;
  overflow: hidden;
  max-width: 200px;
  color: var(--nh-text-dim);
  font-size: 13px;
  line-height: 1;
  font-weight: 400;
  text-overflow: ellipsis;
  white-space: nowrap;
}

#${AGENT_PANEL_ROOT_ID} .nh-agent-row-task {
  overflow: hidden;
  padding-left: 20px;
  color: var(--nh-text-muted);
  font-size: 13px;
  line-height: 1.2;
  font-weight: 400;
  text-overflow: ellipsis;
  white-space: nowrap;
}

#${AGENT_PANEL_ROOT_ID} .nh-panel-footer {
  display: flex;
  align-items: center;
  gap: 12px;
  margin-top: 16px;
  padding-top: 14px;
  border-top: 1px solid var(--nh-divider);
  color: var(--nh-text-muted);
  font-size: 13px;
  line-height: 1.2;
  white-space: nowrap;
  overflow: hidden;
}

#${AGENT_PANEL_ROOT_ID} .nh-footer-glyph {
  flex: 0 0 auto;
  color: var(--nh-green);
  font-size: 14px;
  line-height: 1;
}

#${AGENT_PANEL_ROOT_ID} .nh-footer-line {
  overflow: hidden;
  text-overflow: ellipsis;
}

#${AGENT_PANEL_ROOT_ID} .nh-footer-target {
  color: var(--nh-text);
  font-weight: 500;
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

// Guard against double-injection (HMR / re-injection after install).
// This must run after AGENT_PANEL_CSS is initialized because install() can
// synchronously mount the panel at document_start.
if ((window as unknown as { __nhInstalled?: boolean }).__nhInstalled) {
  log.warn("content script already installed on this page, skipping");
} else {
  (window as unknown as { __nhInstalled?: boolean }).__nhInstalled = true;
  install();
}
