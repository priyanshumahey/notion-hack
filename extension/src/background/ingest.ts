// Background ingest pipeline.
//
//   event arrives
//     │
//     ▼
//   persist event
//     │
//     ▼
//   detectTriggers(event, history) → [Trigger]
//     │
//     ▼
//   for each trigger (filtered by coalesce + repetition/action throttle):
//      buildLookback → store unjudged → judgeCandidate → update
//
// Coalesce rule: when a new trigger fires in the same tab within 10 s of a
// recent candidate's last event, REPLACE that candidate (delete + recreate
// with the newer trigger). This handles the common pattern where a form
// submit is followed within 1-2 s by a terminal-nav to the confirmation
// page — both fire, the latter has richer page context.
//
// Repetition throttle: once we fire a "repetition" trigger for a given
// pageKey cluster, we don't fire another for 7 days. Tracked via the
// completions store (no separate state needed).
//
// Action-click throttle: once we fire an "action-click" trigger for a
// given (host, verb) pair, we don't fire another for 5 min. Tracked the
// same way.

import { makeLog } from "../lib/log";
import { newId } from "../lib/ids";
import { getEventStore, getCompletionStore } from "../lib/store";
import { detectTriggers, clickSignature, type Trigger } from "../lib/completion/detect";
import { buildLookback } from "../lib/completion/lookback";
import { hasOpenAiKey } from "../lib/settings";
import { judgeCandidate, type KnownDatabase } from "../lib/openai";
import { getNotionGateway } from "../lib/notion/gateway";
import { executeConnectorFlow } from "./connectors";
import type { AppEvent, CompletionCandidate } from "../lib/types";

const log = makeLog("bg");
const events = getEventStore();
const completions = getCompletionStore();
const notion = getNotionGateway();

// ---- tunables -------------------------------------------------------------
const LOOKBACK_FETCH = 800;                          // events scanned for lookback + repetition history
const COALESCE_WINDOW_MS = 10_000;                   // candidates within this window in same tab get replaced
const REPETITION_THROTTLE_MS = 7 * 24 * 60 * 60_000; // 7 days per pageKey cluster
const ACTION_CLICK_THROTTLE_MS = 5 * 60_000;         // 5 min per (host, verb)
const ACTION_CLICK_CONTEXT_WINDOW_MS = 5 * 60_000;   // include action-clicks from last 5 min in context
const ACTION_CLICK_MAX_CONTEXT = 40;                 // hard cap on context size for action-click
const AUTO_APPLY_MIN_CONFIDENCE = 0.55;              // skip silent apply when LLM is wishy-washy

export async function ingest(event: AppEvent): Promise<void> {
  await events.append(event);

  // Strict gate: without an OpenAI key, do nothing past persistence. We
  // also skip the trigger walk to save work.
  if (!(await hasOpenAiKey())) {
    return;
  }

  // Pull enough recent history to feed both lookback and repetition.
  const history = await events.recent(LOOKBACK_FETCH);

  // Build the throttle sets. Cheap scans of the latest few hundred candidates.
  const [repThrottle, recentlyFiredAction] = await Promise.all([
    loadRepetitionThrottle(),
    loadRecentActionClusters(),
  ]);

  const triggers = detectTriggers({
    event,
    history,
    recentlyFiredRepetitionClusters: repThrottle.blockedClusters,
    recentlyFiredRepetitionUrls: repThrottle.firedUrls,
    recentlyFiredActionClusters: recentlyFiredAction,
  });
  if (triggers.length === 0) return;
  log("triggers fired", triggers.map((t) => `${t.reason}(${t.note})`).join(", "));

  // For each trigger, run the judge pipeline. Coalesce duplicates as we go.
  for (const trig of triggers) {
    try {
      await runTrigger(event, trig, history);
    } catch (e) {
      log.error("runTrigger failed", trig.reason, e);
    }
  }
}

/** One full pipeline run for a single trigger. */
async function runTrigger(event: AppEvent, trig: Trigger, history: AppEvent[]): Promise<void> {
  // Context window varies by trigger type — see helpers below.
  let context: AppEvent[];
  if (trig.reason === "repetition" && trig.clusterKey) {
    context = buildRepetitionContext(event, history, trig.clusterKey);
  } else if (trig.reason === "action-click" && trig.clusterKey) {
    context = buildActionClickContext(event, history, trig.clusterKey);
  } else {
    context = buildLookback(history, event);
  }

  const pageKeys = uniq(context.map((e) => e.pageKey));
  const hosts = uniq(pageKeys.map((pk) => pk.split("/")[0]).filter(Boolean));

  // Coalesce check — only for single-shot completion-y triggers (the second
  // one of a form-submit→terminal-nav pair). Pattern triggers (repetition,
  // action-click) are throttled separately and never coalesce.
  if (trig.reason !== "repetition" && trig.reason !== "action-click") {
    const replaced = await coalesceWithRecent(event, trig, context);
    if (replaced === "skip") {
      log("coalesce: skip", trig.reason);
      return;
    }
    if (replaced === "replace") {
      log("coalesce: replaced older candidate");
    }
  }

  const candidate: CompletionCandidate = {
    id: newId(),
    detectedAt: Date.now(),
    reason: trig.reason,
    triggerNote: trig.note,
    trigger: event,
    context,
    scope: {
      tabId: event.tabId,
      sinceTs: context[0]?.ts ?? event.ts,
      untilTs: event.ts,
      pageKeys,
      hosts,
    },
    judgement: null,
    error: null,
    status: "new",
  };

  await completions.append(candidate);
  log("candidate stored", candidate.id, trig.reason, "ctx=" + context.length);

  // Judge (best-effort; errors are stored on the candidate).
  try {
    const knownDbs = await loadKnownDatabases();
    const judgement = await judgeCandidate(candidate, knownDbs);
    candidate.judgement = judgement;
    candidate.error = null;
    await completions.update(candidate);
    log("candidate judged", candidate.id, {
      meaningful: judgement.meaningful,
      confidence: judgement.confidence,
      proposalDb: judgement.proposal?.database.name,
      mode: judgement.proposal?.database.mode,
    });
    // Auto-apply path: the user has previously approved a candidate
    // landing in some database X. If the judge now picks `use-existing`
    // pointing at that same X, treat the user's prior approval as a
    // standing trust signal for X and apply silently. The LLM does the
    // semantic matching; the user's prior approval validates the
    // destination.
    //
    // We do NOT require trigger reason or pageKey match — recipes,
    // articles, jobs, etc. all have unique slugs so pageKey-equality is
    // too tight. The DB-equality gate plus the LLM's confidence is the
    // right level of strictness.
    let autoApplied = false;
    if (
      judgement.meaningful &&
      judgement.proposal &&
      judgement.proposal.database.mode === "use-existing" &&
      judgement.proposal.database.existingId &&
      judgement.confidence >= AUTO_APPLY_MIN_CONFIDENCE
    ) {
      const dbId = judgement.proposal.database.existingId;
      if (await isApprovedDatabase(dbId)) {
        log("auto-apply: DB previously approved", candidate.id, "→", dbId);
        const result = await executeConnectorFlow("notion", candidate.id, { auto: true });
        autoApplied = result.completion?.applied?.status === "applied";
      }
    }

    if (judgement.meaningful && !autoApplied) {
      notifyCompletionPrompt(candidate).catch((err) => {
        log.warn("completion prompt notify failed", candidate.id, err);
      });
    }
  } catch (e) {
    const msg = (e as Error).message;
    log.error("judge failed", candidate.id, msg);
    candidate.error = msg;
    await completions.update(candidate);
  }
}

async function notifyCompletionPrompt(candidate: CompletionCandidate): Promise<void> {
  const tabId = candidate.trigger.tabId;
  if (tabId < 0) return;
  await chrome.tabs.sendMessage(tabId, {
    t: "completionPrompt",
    id: candidate.id,
    reason: candidate.reason,
    databaseName: candidate.judgement?.proposal?.database.name,
    confidence: candidate.judgement?.confidence,
  });
}

/**
 * For repetition triggers, the context is the union of:
 *   (a) the current event's same-tab lookback (recent activity around it), and
 *   (b) all past `page-dwell` / `nav` events sharing the same cluster (pageKey)
 *       — these are what makes the pattern visible to the LLM.
 * Result is sorted by time and deduped by id.
 */
function buildRepetitionContext(
  event: AppEvent,
  history: AppEvent[],
  clusterKey: string,
): AppEvent[] {
  const sameTab = buildLookback(history, event);
  const clusterMembers: AppEvent[] = [];
  const cutoffTs = event.ts - 30 * 24 * 60 * 60_000;
  for (const e of history) {
    if (e.ts < cutoffTs) break;
    if (e.id === event.id) continue;
    if (e.kind !== "page-dwell" && e.kind !== "nav") continue;
    if (e.pageKey !== clusterKey) continue;
    clusterMembers.push(e);
  }
  const byId = new Map<string, AppEvent>();
  for (const e of [...sameTab, ...clusterMembers, event]) byId.set(e.id, e);
  return Array.from(byId.values()).sort((a, b) => a.ts - b.ts);
}

/**
 * For action-click triggers, the context is:
 *   (a) every click in the action-click window on the same host that matched
 *       the same verb — these ARE the pattern, and the LLM needs to see them all
 *       (often each click's fingerprint carries the local content the user
 *       acted on, e.g. tweet text near a Bookmark button).
 *   (b) every page-dwell / nav event in the window on the same host — gives
 *       the LLM page-level context (titles, JSON-LD, og:* on the surrounding
 *       pages).
 *   (c) the trigger event itself.
 * Deduped, sorted, capped.
 */
function buildActionClickContext(
  event: AppEvent,
  history: AppEvent[],
  clusterKey: string,
): AppEvent[] {
  // clusterKey shape: `${host}::${signature}` (signature itself contains a
  // single colon, e.g. "label:save recipe" or "testid:bookmark-btn").
  const sepIdx = clusterKey.indexOf("::");
  if (sepIdx === -1) return [event];
  const host = clusterKey.slice(0, sepIdx);
  const sig = clusterKey.slice(sepIdx + 2);
  if (!host || !sig) return [event];

  const cutoffTs = event.ts - ACTION_CLICK_CONTEXT_WINDOW_MS;
  const picked: AppEvent[] = [];
  for (const e of history) {
    if (e.ts < cutoffTs) break;
    if (e.id === event.id) continue;
    const h = e.pageKey.split("/")[0];
    if (h !== host) continue;
    if (e.kind === "click") {
      if (clickSignature(e.fingerprint) !== sig) continue;
      picked.push(e);
    } else if (e.kind === "page-dwell" || e.kind === "nav") {
      picked.push(e);
    }
  }
  picked.push(event);

  const byId = new Map<string, AppEvent>();
  for (const e of picked) byId.set(e.id, e);
  const merged = Array.from(byId.values()).sort((a, b) => a.ts - b.ts);
  if (merged.length <= ACTION_CLICK_MAX_CONTEXT) return merged;
  // Keep oldest dwell/nav anchors + all the action clicks + the trigger.
  // Simple strategy: keep the LAST N (most recent) up to cap.
  return merged.slice(-ACTION_CLICK_MAX_CONTEXT);
}

/**
 * Look for a recently-created candidate in the same tab whose trigger event
 * is within COALESCE_WINDOW_MS of the new trigger. If found:
 *   - delete it (the new one will replace it)
 *   - return "replace"
 * If no recent candidate, return "ok".
 */
async function coalesceWithRecent(
  event: AppEvent,
  _trig: Trigger,
  _context: AppEvent[],
): Promise<"ok" | "replace" | "skip"> {
  const recent = await completions.recent(20);
  for (const c of recent) {
    if (c.trigger.tabId !== event.tabId) continue;
    // Don't coalesce pattern-style candidates — only single-shot ones.
    if (c.reason === "repetition" || c.reason === "action-click") continue;
    const dt = event.ts - c.trigger.ts;
    if (dt < 0 || dt > COALESCE_WINDOW_MS) continue;
    await completions.delete(c.id);
    return "replace";
  }
  return "ok";
}

/**
 * Compute the per-cluster throttle state for the repetition trigger.
 *
 *   blockedClusters: clusters where firing another candidate right now would
 *     be noise — they have a recent pending OR denied candidate. Approved
 *     clusters are deliberately NOT blocked: once the user has decided
 *     "yes, track these", new items in the cluster should surface so they
 *     can add them to the same DB.
 *
 *   firedUrls: every URL we've already shown the user a candidate for in
 *     the lookback window. Stops SPA revisits to the same page from
 *     creating duplicate candidates even in approved clusters.
 */
async function loadRepetitionThrottle(): Promise<{
  blockedClusters: Set<string>;
  firedUrls: Set<string>;
}> {
  const recent = await completions.recent(500);
  const cutoffTs = Date.now() - REPETITION_THROTTLE_MS;
  const blockedClusters = new Set<string>();
  const firedUrls = new Set<string>();
  for (const c of recent) {
    if (c.reason !== "repetition") continue;
    if (c.detectedAt < cutoffTs) continue;
    // Dedup by exact URL regardless of decision state.
    firedUrls.add(c.trigger.url);
    // Cluster is blocked unless the user explicitly approved a row from it.
    const approved = c.applied?.status === "applied";
    if (!approved) blockedClusters.add(c.trigger.pageKey);
  }
  return { blockedClusters, firedUrls };
}

/**
 * Same idea for action-click — derive `${host}::${signature}` from each
 * recent action-click candidate's trigger event.
 */
async function loadRecentActionClusters(): Promise<Set<string>> {
  const recent = await completions.recent(200);
  const out = new Set<string>();
  const cutoffTs = Date.now() - ACTION_CLICK_THROTTLE_MS;
  for (const c of recent) {
    if (c.reason !== "action-click") continue;
    if (c.detectedAt < cutoffTs) continue;
    const host = c.trigger.pageKey.split("/")[0];
    if (!host) continue;
    const sig = clickSignature(c.trigger.fingerprint);
    if (!sig) continue;
    out.add(`${host}::${sig}`);
  }
  return out;
}

/** Re-run the judge for an existing candidate (popup "Retry"). */
export async function retryJudge(id: string): Promise<CompletionCandidate | null> {
  const c = await completions.get(id);
  if (!c) return null;
  if (!(await hasOpenAiKey())) {
    c.error = "no-openai-key";
    await completions.update(c);
    return c;
  }
  try {
    const knownDbs = await loadKnownDatabases();
    const judgement = await judgeCandidate(c, knownDbs);
    c.judgement = judgement;
    c.error = null;
  } catch (e) {
    c.error = (e as Error).message;
  }
  await completions.update(c);
  return c;
}

/**
 * Snapshot of currently-known Notion databases for the judge prompt.
 * Lets the LLM choose `use-existing` and reuse a DB the user has already
 * approved, instead of proposing a near-duplicate every time a new item
 * in an approved cluster fires a candidate.
 */
async function loadKnownDatabases(): Promise<KnownDatabase[]> {
  const dbs = await notion.listDatabases();
  return dbs.map((d) => ({ id: d.id, name: d.name, properties: d.properties }));
}

/**
 * Has the user ever applied a candidate that landed in this database?
 * Used by the auto-apply path: prior approval to a DB = standing trust
 * signal for any future judgement that proposes `use-existing` → same DB.
 */
async function isApprovedDatabase(dbId: string): Promise<boolean> {
  const recent = await completions.recent(500);
  for (const c of recent) {
    if (c.applied?.status === "applied" && c.applied.databaseId === dbId) {
      return true;
    }
  }
  return false;
}

function uniq<T>(xs: T[]): T[] {
  return Array.from(new Set(xs));
}
