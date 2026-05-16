// MV3 service worker. Owns the IndexedDB store and routes typed messages.
//
// Responsibilities (this step):
//   - Receive `evt` messages from content scripts, stamp tabId, persist.
//   - Listen to chrome.webNavigation.onCommitted as a fallback nav source
//     (covers cross-origin navigations, new tabs, etc.).
//   - Serve `getRecent`, `clearAll`, `ping` queries from the popup.
//
// Debug from the SW console:
//   await __nh.recent(20)
//   await __nh.count()
//   await __nh.clear()

import { makeLog } from "../lib/log";
import { getEventStore } from "../lib/store";
import { canonicalizeUrl } from "../lib/canonicalize";
import { newId } from "../lib/ids";
import type { Msg, MsgResponse } from "../lib/messages";
import type { AppEvent, RawEvent } from "../lib/types";

const log = makeLog("bg");
const store = getEventStore();

chrome.runtime.onInstalled.addListener((details) => {
  log("installed", details.reason);
});

chrome.runtime.onStartup.addListener(() => {
  log("startup");
});

// ---- Cross-origin nav fallback ---------------------------------------------
// content scripts can't observe a navigation that unloads them. webNavigation
// in the bg picks up the next page's commit so we get a clean nav event
// regardless of where the user went.
chrome.webNavigation.onCommitted.addListener((details) => {
  // Only main frame, only http(s).
  if (details.frameId !== 0) return;
  if (!/^https?:/.test(details.url)) return;

  const ev: AppEvent = {
    id: newId(),
    ts: Date.now(),
    tabId: details.tabId,
    url: details.url,
    pageKey: canonicalizeUrl(details.url),
    kind: "nav",
    meta: { source: "webNavigation", transitionType: details.transitionType },
  };
  void persist(ev);
});

// ---- Message router --------------------------------------------------------
chrome.runtime.onMessage.addListener(
  (msg: Msg, sender, sendResponse: (r: MsgResponse) => void) => {
    handle(msg, sender)
      .then(sendResponse)
      .catch((e) => {
        log.error("handler threw", e);
        sendResponse({ t: "error", message: (e as Error).message });
      });
    // Tell chrome we'll respond asynchronously.
    return true;
  },
);

async function handle(msg: Msg, sender: chrome.runtime.MessageSender): Promise<MsgResponse> {
  switch (msg.t) {
    case "evt": {
      const tabId = sender.tab?.id ?? -1;
      const ev = stampRaw(msg.event, tabId);
      await persist(ev);
      return { t: "ok" };
    }
    case "getRecent": {
      const events = await store.recent(msg.limit);
      return { t: "recent", events };
    }
    case "clearAll": {
      await store.clear();
      log.warn("cleared all events");
      return { t: "ok" };
    }
    case "ping":
      return { t: "pong", at: Date.now() };
  }
}

function stampRaw(raw: RawEvent, tabId: number): AppEvent {
  return {
    id: raw.id ?? newId(),
    ts: raw.ts ?? Date.now(),
    tabId: raw.tabId ?? tabId,
    url: raw.url,
    pageKey: raw.pageKey,
    kind: raw.kind,
    fingerprint: raw.fingerprint,
    meta: raw.meta,
  };
}

async function persist(ev: AppEvent): Promise<void> {
  try {
    await store.append(ev);
    log(ev.kind, ev.pageKey, summarize(ev));
  } catch (e) {
    log.error("persist failed", e, ev);
  }
}

function summarize(ev: AppEvent): string {
  const fp = ev.fingerprint;
  if (!fp) return "";
  const label = fp.accessibleName || fp.text || fp.testid || fp.role || fp.tag;
  return `${fp.role ?? fp.tag}:${JSON.stringify(label).slice(0, 60)}`;
}

// ---- Debug surface in the SW console --------------------------------------
// `globalThis.__nh.recent(20)` etc. — handy while we have no real UI yet.
(globalThis as unknown as { __nh: unknown }).__nh = {
  recent: (n = 50) => store.recent(n),
  count: () => store.count(),
  clear: () => store.clear(),
};
