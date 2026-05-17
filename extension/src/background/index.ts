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
import { ingest, retryJudge, resetIngestState } from "./ingest";
import { applyCandidate, denyCandidate } from "./apply";
import { getNotionGateway } from "../lib/notion/gateway";
import {
  getObservationsClient,
  resetObservationsClient,
  RealObservationsClient,
} from "../lib/notion/observations";
import {
  clearNotionConnection,
  describeKeySource,
  getNotionConnection,
  hasOpenAiKey,
  redactKey,
  setBootstrapState,
  setNotionToken,
  setOpenAiKey,
  getOpenAiKey,
  getAutoApplyEnabled,
  setAutoApplyEnabled,
} from "../lib/settings";
import {
  getObservationStats,
  getObservationLastError,
  clearObservationStats,
} from "../lib/notion/stats";
import { pingOpenAi } from "../lib/openai";
import type { Msg, MsgResponse } from "../lib/messages";
import type { AppEvent, RawEvent } from "../lib/types";
import { NotionGatewayError } from "../lib/notion/types";

const log = makeLog("bg");
const events = getEventStore();
const completions = getCompletionStore();
const notion = getNotionGateway();

// ---------------------------------------------------------------------------
// Self-heal: if the user deletes our system DBs in Notion's UI, the cached
// ids become stale and every query 404s. Detect that, re-bootstrap to
// recreate the DBs (search excludes trashed objects, so this is safe), and
// surface the new ids back into storage + the cached client.
// ---------------------------------------------------------------------------

let lastHealAt = 0;
let healInFlight: Promise<boolean> | null = null;
const HEAL_MIN_INTERVAL_MS = 10_000;

/** True when the error is a 404 from a system DB id (Observations / Workflows / Runs). */
function isDeletedDbError(e: unknown): boolean {
  return e instanceof NotionGatewayError && e.code === "not_found";
}

/**
 * Idempotent recovery from "system DB was trashed in Notion". Coalesces
 * concurrent calls into one bootstrap + persists the new ids. Returns true
 * if heal completed (or had completed recently); false if it can't run
 * (no parent page configured, etc.).
 */
export async function healSystemDatabases(): Promise<boolean> {
  if (healInFlight) return healInFlight;
  if (Date.now() - lastHealAt < HEAL_MIN_INTERVAL_MS) return true;
  const task = (async (): Promise<boolean> => {
    const conn = await getNotionConnection();
    if (!conn.hasToken || !conn.parentPageId) {
      log.warn("heal skipped: no token or parent page configured");
      return false;
    }
    const client = await getObservationsClient();
    if (!client) return false;
    try {
      const ids = await client.bootstrapAll(conn.parentPageId);
      await setBootstrapState({
        parentPageId: conn.parentPageId,
        parentPageTitle: conn.parentPageTitle,
        observationsDbId: ids.observationsDbId,
        workflowsDbId: ids.workflowsDbId,
        runsDbId: ids.runsDbId,
      });
      if (client instanceof RealObservationsClient) {
        client.setObservationsDbId(ids.observationsDbId);
        client.setWorkflowsDbId(ids.workflowsDbId);
        client.setRunsDbId(ids.runsDbId);
      }
      lastHealAt = Date.now();
      log("heal: system DBs reprovisioned", ids);
      return true;
    } catch (e) {
      log.error("heal failed", (e as Error).message);
      return false;
    }
  })();
  healInFlight = task.finally(() => {
    healInFlight = null;
  });
  return healInFlight;
}

chrome.runtime.onInstalled.addListener((details) => {
  log("installed", details.reason);
});

// Notification-id format: "pending:<candidateId>" (review pending) or
// "run:<candidateId>" (workflow ran). Persist a one-shot routing intent so
// the popup can land on the right tab + scroll to the right row, then
// open the popup. openPopup() requires a focused window in Chrome MV3,
// so we fall back to opening the extension's pop-out in a new tab if it
// errors.
chrome.notifications?.onClicked.addListener((notificationId) => {
  const [kind, candidateId] = notificationId.split(":");
  if (!candidateId) return;
  const intent =
    kind === "run"
      ? { tab: "runs" as const, candidateId, at: Date.now() }
      : kind === "pending"
        ? { tab: "completions" as const, candidateId, at: Date.now() }
        : null;
  if (!intent) return;
  void (async () => {
    try {
      await chrome.storage.local.set({ popupIntent: intent });
      try {
        await chrome.action.openPopup();
      } catch {
        // openPopup() can fail if no window is focused; fall back to a tab.
        await chrome.tabs.create({
          url: chrome.runtime.getURL("src/popup/index.html"),
        });
      }
      try {
        await chrome.notifications.clear(notificationId);
      } catch {
        /* non-fatal */
      }
    } catch (e) {
      log.warn("notification click failed", (e as Error).message);
    }
  })();
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
    case "applyCandidate": {
      const c = await applyCandidate(msg.id);
      return { t: "completion", completion: c };
    }
    case "denyCandidate": {
      const c = await denyCandidate(msg.id);
      return { t: "completion", completion: c };
    }
    case "notionListDatabases": {
      const dbs = await notion.listDatabases();
      return { t: "notionDatabases", workspace: notion.workspaceLabel(), databases: dbs };
    }
    case "notionGetDatabase": {
      const db = await notion.getDatabase(msg.id);
      return { t: "notionDatabase", database: db };
    }
    case "notionListPages": {
      const pages = await notion.listPages(msg.databaseId, msg.limit);
      return { t: "notionPages", pages };
    }
    case "notionClearAll": {
      await notion.clearAll();
      log.warn("cleared all notion mock data");
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
    case "getAutoApply": {
      return { t: "autoApply", enabled: await getAutoApplyEnabled() };
    }
    case "setAutoApply": {
      await setAutoApplyEnabled(msg.enabled);
      log("auto-apply", msg.enabled ? "enabled" : "disabled");
      return { t: "autoApply", enabled: msg.enabled };
    }
    case "clearLocalData": {
      // Wipe everything the extension has saved locally (events, judged
      // candidates / runs, observation stats counters, in-memory caches).
      // Credentials (OpenAI key, Notion token, bootstrapped DB ids,
      // auto-apply toggle) are intentionally preserved — the user can
      // disconnect those separately.
      await events.clear();
      await completions.clear();
      await clearObservationStats();
      resetIngestState();
      log.warn("cleared all local data (events + completions + stats)");
      return { t: "ok" };
    }
    // ---- Notion connection (Phase 1) -----------------------------------
    case "notionGetConnection": {
      const c = await getNotionConnection();
      return {
        t: "notionConnection",
        hasToken: c.hasToken,
        bootstrapped: c.bootstrapped,
        workspaceName: c.workspaceName,
        parentPageId: c.parentPageId,
        parentPageTitle: c.parentPageTitle,
        observationsDbId: c.observationsDbId,
        workflowsDbId: c.workflowsDbId,
        runsDbId: c.runsDbId,
        redactedToken: c.redactedToken,
      };
    }
    case "notionSetToken": {
      await setNotionToken(msg.token);
      // Clear cached bootstrap/workspace state — must re-verify with the new token.
      await setBootstrapState({
        workspaceName: "",
        parentPageId: "",
        parentPageTitle: "",
        observationsDbId: "",
        workflowsDbId: "",
        runsDbId: "",
      });
      resetObservationsClient();
      log("notion token updated");
      return { t: "ok" };
    }
    case "notionDisconnect": {
      await clearNotionConnection();
      resetObservationsClient();
      log("notion disconnected");
      return { t: "ok" };
    }
    case "notionTestConnection": {
      try {
        const client = await getObservationsClient();
        if (!client) return { t: "testResult", ok: false, error: "no token" };
        const me = await client.whoAmI();
        await setBootstrapState({ workspaceName: me.workspaceName });
        resetObservationsClient();
        return { t: "testResult", ok: true, detail: me.workspaceName };
      } catch (e) {
        const m = (e as Error).message;
        log.error("notion test failed", m);
        return { t: "testResult", ok: false, error: m };
      }
    }
    case "notionSearchParents": {
      const client = await getObservationsClient();
      if (!client) return { t: "notionParents", results: [] };
      try {
        const results = await client.searchParentPages(msg.query, 20);
        return { t: "notionParents", results };
      } catch (e) {
        log.error("notion search failed", (e as Error).message);
        return { t: "error", message: (e as Error).message };
      }
    }
    case "notionBootstrap": {
      const client = await getObservationsClient();
      if (!client) return { t: "error", message: "Notion not connected" };
      try {
        const ids = await client.bootstrapAll(msg.parentPageId);
        await setBootstrapState({
          parentPageId: msg.parentPageId,
          parentPageTitle: msg.parentPageTitle,
          observationsDbId: ids.observationsDbId,
          workflowsDbId: ids.workflowsDbId,
          runsDbId: ids.runsDbId,
        });
        // Refresh cached client so it picks up the new db ids.
        resetObservationsClient();
        if (client instanceof RealObservationsClient) {
          client.setObservationsDbId(ids.observationsDbId);
          client.setWorkflowsDbId(ids.workflowsDbId);
          client.setRunsDbId(ids.runsDbId);
        }
        log("notion bootstrap complete", ids);
        return {
          t: "notionBootstrapped",
          observationsDbId: ids.observationsDbId,
          workflowsDbId: ids.workflowsDbId,
          runsDbId: ids.runsDbId,
        };
      } catch (e) {
        log.error("notion bootstrap failed", (e as Error).message);
        return { t: "error", message: (e as Error).message };
      }
    }
    case "notionObservationStats": {
      const stats = await getObservationStats();
      const lastError = await getObservationLastError();
      return {
        t: "notionObservationStats",
        today: stats.today,
        total: stats.total,
        lastError: lastError || undefined,
      };
    }
    case "notionListObservations": {
      const client = await getObservationsClient();
      if (!client) return { t: "notionObservations", observations: [] };
      try {
        const observations = await client.listRecentObservations(msg.limit);
        return { t: "notionObservations", observations };
      } catch (e) {
        if (isDeletedDbError(e) && (await healSystemDatabases())) {
          const fresh = await getObservationsClient();
          if (fresh) {
            try {
              const observations = await fresh.listRecentObservations(msg.limit);
              return { t: "notionObservations", observations };
            } catch (e2) {
              log.error("notion list observations post-heal failed", (e2 as Error).message);
              return { t: "error", message: (e2 as Error).message };
            }
          }
        }
        log.error("notion list observations failed", (e as Error).message);
        return { t: "error", message: (e as Error).message };
      }
    }
    case "notionListWorkflows": {
      const client = await getObservationsClient();
      if (!client) return { t: "notionWorkflows", workflows: [] };
      try {
        const workflows = await client.listWorkflows(msg.limit);
        return { t: "notionWorkflows", workflows };
      } catch (e) {
        if (isDeletedDbError(e) && (await healSystemDatabases())) {
          const fresh = await getObservationsClient();
          if (fresh) {
            try {
              const workflows = await fresh.listWorkflows(msg.limit);
              return { t: "notionWorkflows", workflows };
            } catch (e2) {
              log.error("notion list workflows post-heal failed", (e2 as Error).message);
              return { t: "error", message: (e2 as Error).message };
            }
          }
        }
        log.error("notion list workflows failed", (e as Error).message);
        return { t: "error", message: (e as Error).message };
      }
    }
    case "notionListRuns": {
      const client = await getObservationsClient();
      if (!client) return { t: "notionRuns", runs: [] };
      try {
        const runs = await client.listRuns(msg.limit);
        return { t: "notionRuns", runs };
      } catch (e) {
        if (isDeletedDbError(e) && (await healSystemDatabases())) {
          const fresh = await getObservationsClient();
          if (fresh) {
            try {
              const runs = await fresh.listRuns(msg.limit);
              return { t: "notionRuns", runs };
            } catch (e2) {
              log.error("notion list runs post-heal failed", (e2 as Error).message);
              return { t: "error", message: (e2 as Error).message };
            }
          }
        }
        log.error("notion list runs failed", (e as Error).message);
        return { t: "error", message: (e as Error).message };
      }
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
  applyCandidate: (id: string) => applyCandidate(id),
  notionDatabases: () => notion.listDatabases(),
  notionPages: (dbId: string, n = 100) => notion.listPages(dbId, n),
  notionClear: () => notion.clearAll(),
};
