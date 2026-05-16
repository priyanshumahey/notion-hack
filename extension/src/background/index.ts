// MV3 service worker. Owns the IndexedDB store and routes typed messages.
//
// Step 2: the heavy lifting moved into ingest.ts. This file is now mostly a
// router. Detection + LLM judge run inside ingest() for every event.
//
// Debug from the SW console:
//   await __nh.recent(20)
//   await __nh.count()
//   await __nh.completions(20)
//   await __nh.completionCount()
//   await __nh.clear()
//   await __nh.clearCompletions()

import { makeLog } from "../lib/log";
import { getEventStore, getCompletionStore } from "../lib/store";
import { canonicalizeUrl } from "../lib/canonicalize";
import { newId } from "../lib/ids";
import { ingest, retryJudge } from "./ingest";
import { describeKeySource, hasOpenAiKey, redactKey, setOpenAiKey, getOpenAiKey } from "../lib/settings";
import { pingOpenAi } from "../lib/openai";
import type { Msg, MsgResponse } from "../lib/messages";
import type { AppEvent, RawEvent } from "../lib/types";

const log = makeLog("bg");
const events = getEventStore();
const completions = getCompletionStore();

chrome.runtime.onInstalled.addListener((details) => {
  log("installed", details.reason);
});

chrome.runtime.onStartup.addListener(() => {
  log("startup");
});

// ---- Cross-origin nav fallback ---------------------------------------------
chrome.webNavigation.onCommitted.addListener((details) => {
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
  void ingest(ev).catch((e) => log.error("ingest(nav) failed", e));
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
    return true;
  },
);

async function handle(msg: Msg, sender: chrome.runtime.MessageSender): Promise<MsgResponse> {
  switch (msg.t) {
    case "evt": {
      const tabId = sender.tab?.id ?? -1;
      const ev = stampRaw(msg.event, tabId);
      await ingest(ev);
      return { t: "ok" };
    }
    case "completionPrompt":
      // Background emits this to content scripts; ignore if it is ever routed
      // back through runtime.onMessage.
      return { t: "ok" };
    case "getRecent": {
      const evts = await events.recent(msg.limit);
      return { t: "recent", events: evts };
    }
    case "clearAll": {
      await events.clear();
      log.warn("cleared all events");
      return { t: "ok" };
    }
    case "setCompletionStatus": {
      const c = await completions.get(msg.id);
      if (c) {
        c.status = msg.status;
        await completions.update(c);
        log("completion status updated", msg.id, msg.status);
      }
      return { t: "ok" };
    }
    case "getCompletions": {
      const list = await completions.recent(msg.limit);
      return { t: "completions", completions: list };
    }
    case "getCompletion": {
      const c = (await completions.get(msg.id)) ?? null;
      return { t: "completion", completion: c };
    }
    case "retryJudge": {
      const c = await retryJudge(msg.id);
      return { t: "completion", completion: c };
    }
    case "deleteCompletion": {
      await completions.delete(msg.id);
      return { t: "ok" };
    }
    case "clearCompletions": {
      await completions.clear();
      log.warn("cleared all completions");
      return { t: "ok" };
    }
    case "getKeyStatus": {
      const source = await describeKeySource();
      const hasKey = source !== "none";
      const redacted = hasKey ? redactKey(await getOpenAiKey()) : "";
      return { t: "keyStatus", hasKey, source, redacted };
    }
    case "setOpenAiKey": {
      await setOpenAiKey(msg.key);
      log("openai key updated; hasKey=", await hasOpenAiKey());
      return { t: "ok" };
    }
    case "testOpenAi": {
      const r = await pingOpenAi();
      return { t: "testResult", ok: r.ok, error: r.error };
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
    pageContext: raw.pageContext,
    formContext: raw.formContext,
    meta: raw.meta,
  };
}

// ---- Debug surface in the SW console --------------------------------------
(globalThis as unknown as { __nh: unknown }).__nh = {
  recent: (n = 50) => events.recent(n),
  count: () => events.count(),
  clear: () => events.clear(),
  completions: (n = 50) => completions.recent(n),
  completionCount: () => completions.count(),
  clearCompletions: () => completions.clear(),
};
