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
import type { Trigger } from "../lib/completion/detect";
import { hasOpenAiKey } from "../lib/settings";
import { judgeCandidate, type KnownDatabase, type KnownWorkflow } from "../lib/openai";
import { getNotionGateway } from "../lib/notion/gateway";
import { getObservationsClient } from "../lib/notion/observations";
import { bumpObservationStats, setObservationLastError } from "../lib/notion/stats";
import { getNotionConnection, isFullyConnected, getAutoApplyEnabled } from "../lib/settings";
import { applyCandidate } from "./apply";
import { healSystemDatabases } from "./index";
import type { AppEvent, CompletionCandidate } from "../lib/types";
import { NotionGatewayError } from "../lib/notion/types";

const log = makeLog("bg");
const events = getEventStore();
const completions = getCompletionStore();
const notion = getNotionGateway();

// ---- tunables -------------------------------------------------------------
const LOOKBACK_FETCH = 800;                          // events scanned for activity-window + extended history
const AUTO_APPLY_MIN_CONFIDENCE = 0.55;              // skip silent apply when LLM is wishy-washy

export async function ingest(event: AppEvent): Promise<void> {
  // Hard block: never observe Notion itself. Otherwise the agent watches
  // the user browse their own databases and tries to file those visits
  // into… the same databases. Skip persistence entirely so notion pages
  // also stay out of extended history / observations.
  if (isBlockedHost(event.pageKey)) {
    return;
  }

  await events.append(event);

  // Kill switch: without Notion + OpenAI both connected, do nothing past
  // persistence. The user never spends OpenAI calls on data they have no
  // way to inspect.
  if (!(await isFullyConnected())) {
    return;
  }

  // ---- Hackathon model: one rolling-window judge per significant event,
  // ---- debounced. No clusters, no richness gates, no signature matching.
  // ---- The LLM sees the last few minutes of activity + existing DBs +
  // ---- existing workflows and decides everything.

  // Pre-filter: only events with actionable content get judged. Skip
  // bare nav-early notifications (no pageContext yet) and clicks with no
  // fingerprint (those carry no signal).
  if (!isSignificantEvent(event)) return;

  // Per-tab debounce — collapse rapid bursts (nav-early + nav-settled +
  // click + dwell-flush) into a single LLM call. Tabs run independently.
  if (shouldDebounceJudge(event)) {
    log("activity-judge debounced", event.tabId, event.kind);
    return;
  }
  markJudgeFired(event);

  try {
    await runActivityJudge(event);
  } catch (e) {
    log.error("runActivityJudge failed", (e as Error).message);
  }
}

/**
 * Significant = "carries content worth sending to the LLM".
 *  - nav with pageContext (the settled snapshot, not the early ping)
 *  - page-dwell (always has pageContext)
 *  - click with fingerprint (the user did something targeted)
 *  - submit (always rich)
 * Everything else returns false.
 */
function isSignificantEvent(e: AppEvent): boolean {
  if (e.kind === "page-dwell") return true;
  if (e.kind === "submit") return true;
  if (e.kind === "click") return !!e.fingerprint;
  if (e.kind === "nav") return !!e.pageContext;
  return false;
}

/**
 * Notion's own domains. Browsing the user's databases must not feed back
 * into the judge — the agent would otherwise propose filing Notion pages
 * into Notion. pageKey already lowercases the host and strips `www.`.
 */
function isBlockedHost(pageKey: string): boolean {
  const host = pageKey.split("/")[0] ?? "";
  if (!host) return false;
  return (
    host === "notion.so" ||
    host.endsWith(".notion.so") ||
    host === "notion.site" ||
    host.endsWith(".notion.site")
  );
}

/** In-memory per-tab last-fire timestamps. Service-worker scoped. */
const lastJudgeByTab = new Map<number, number>();
const JUDGE_DEBOUNCE_MS = 2500;

function shouldDebounceJudge(event: AppEvent): boolean {
  const last = lastJudgeByTab.get(event.tabId);
  if (last == null) return false;
  return event.ts - last < JUDGE_DEBOUNCE_MS;
}

function markJudgeFired(event: AppEvent): void {
  lastJudgeByTab.set(event.tabId, event.ts);
}

// Rolling-window context: include events from the last N minutes.
const ACTIVITY_WINDOW_MS = 3 * 60_000;        // last 3 min of full events
const ACTIVITY_MAX_EVENTS = 30;               // hard cap on detail events
const EXT_HISTORY_LOOKBACK_MS = 7 * 24 * 60 * 60_000; // 7 days
const EXT_HISTORY_MAX = 60;                   // one-line summaries

/**
 * Run a single rolling-window judge call for a significant event.
 *
 *  1. Gather the last N minutes of significant events as full context.
 *  2. Build an extended-history summary from older nav-with-pageContext
 *     events so the LLM can spot patterns without us clustering.
 *  3. Load existing DBs (with sample rows) + workflows.
 *  4. Build a synthetic CompletionCandidate (reason="activity") and call
 *     the judge.
 *  5. If meaningful → notify and/or auto-apply, same as the legacy path.
 */
async function runActivityJudge(event: AppEvent): Promise<void> {
  const history = await events.recent(LOOKBACK_FETCH);
  const winCutoff = event.ts - ACTIVITY_WINDOW_MS;

  // RECENT ACTIVITY = the last N min of significant events, oldest→newest,
  // capped. The trigger event is always included even if cap would drop it.
  const windowEvents: AppEvent[] = [];
  for (const e of history) {
    if (e.ts < winCutoff) break;
    if (!isSignificantEvent(e)) continue;
    windowEvents.push(e);
  }
  // history is newest→oldest; flip and cap (keeping the newest items).
  windowEvents.reverse();
  if (!windowEvents.some((e) => e.id === event.id)) windowEvents.push(event);
  const context = windowEvents.slice(-ACTIVITY_MAX_EVENTS);

  // EXTENDED HISTORY = older nav-with-pageContext events as one-liners,
  // for pattern detection (e.g. "user has viewed 2 other job postings").
  const extCutoff = event.ts - EXT_HISTORY_LOOKBACK_MS;
  const seenPageKeys = new Set<string>();
  const extendedHistory: CompletionCandidate["extendedHistory"] = [];
  for (const e of history) {
    if (e.ts < extCutoff) break;
    if (e.ts >= winCutoff) continue; // already covered by RECENT ACTIVITY
    if (e.kind !== "nav") continue;
    if (!e.pageContext) continue;
    if (seenPageKeys.has(e.pageKey)) continue;
    seenPageKeys.add(e.pageKey);
    extendedHistory.push({
      ts: e.ts,
      pageKey: e.pageKey,
      host: e.pageKey.split("/")[0] || undefined,
      title: e.pageContext.title || undefined,
    });
    if (extendedHistory.length >= EXT_HISTORY_MAX) break;
  }

  const pageKeys = uniq(context.map((e) => e.pageKey));
  const hosts = uniq(pageKeys.map((pk) => pk.split("/")[0]).filter(Boolean));

  const candidate: CompletionCandidate = {
    id: newId(),
    detectedAt: Date.now(),
    reason: "activity",
    triggerNote: `${event.kind} on ${event.pageKey}`,
    trigger: event,
    context,
    extendedHistory,
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
  log(
    "activity candidate stored",
    candidate.id,
    "ctx=" + context.length,
    "extHist=" + extendedHistory.length,
  );

  // Observations row — best-effort, fire-and-forget.
  void writeObservation(event, {
    reason: "rich-page",
    note: candidate.triggerNote ?? "",
  } as Trigger).catch((e) =>
    log.warn("observation write failed", (e as Error).message),
  );

  try {
    const ctx = await loadJudgeContext();
    const judgement = await judgeCandidate(candidate, ctx.databases, ctx.workflows);
    candidate.judgement = judgement;
    candidate.error = null;
    await completions.update(candidate);
    log("activity candidate judged", candidate.id, {
      meaningful: judgement.meaningful,
      confidence: judgement.confidence,
      proposalDb: judgement.proposal?.database.name,
      mode: judgement.proposal?.database.mode,
    });

    // Auto-apply: same rule as before — existing DB previously approved
    // by user + LLM confidence ≥ threshold + autoApply toggle ON.
    let autoApplied = false;
    if (
      judgement.meaningful &&
      judgement.proposal &&
      judgement.proposal.database.mode === "use-existing" &&
      judgement.proposal.database.existingId &&
      judgement.confidence >= AUTO_APPLY_MIN_CONFIDENCE &&
      (await getAutoApplyEnabled())
    ) {
      const dbId = judgement.proposal.database.existingId;
      if (await isApprovedDatabase(dbId)) {
        log("auto-apply: DB previously approved", candidate.id, "→", dbId);
        await applyCandidate(candidate.id, { auto: true });
        autoApplied = true;
      }
    }

    if (judgement.meaningful && !autoApplied) {
      notifyCompletionPrompt(candidate).catch((err) => {
        log.warn("completion prompt notify failed", candidate.id, err);
      });
      notifyPendingCandidate(candidate).catch((err) => {
        log.warn("desktop notification failed", candidate.id, err);
      });
    }
  } catch (e) {
    const msg = (e as Error).message;
    log.error("activity judge failed", candidate.id, msg);
    candidate.error = msg;
    await completions.update(candidate);
  }
}

// ---- Observations write (Phase 1) -----------------------------------------

async function writeObservation(event: AppEvent, trig: Trigger): Promise<void> {
  const client = await getObservationsClient();
  if (!client) return;
  const conn = await getNotionConnection();
  if (!conn.bootstrapped) return;

  const host = event.pageKey.split("/")[0] ?? "";
  const title = (event.pageContext?.title ?? "").trim();
  const verb = trig.reason;
  const name = title ? `${verb} · ${title}` : `${verb} · ${host}`;

  // Try to identify the page type from JSON-LD or OG metadata for a
  // human-legible select. Best-effort.
  const pageType = derivePageType(event);

  const extracted: Record<string, unknown> = {
    title,
    canonicalUrl: event.pageContext?.canonicalUrl,
    headings: (event.pageContext?.headings ?? []).slice(0, 5),
  };

  const dwellMeta = event.kind === "page-dwell" ? (event.meta as unknown) : undefined;
  const engagement = isDwellMeta(dwellMeta)
    ? {
        foregroundMs: dwellMeta.foregroundMs,
        scrollPct: dwellMeta.maxScrollPct,
        interactions: dwellMeta.interactionCount,
      }
    : undefined;

  // Local heuristic confidence (PRD §3.1). Derived from richness tier when
  // available; otherwise from trigger kind (form-submit / terminal-nav are
  // strong single-shot signals). The judge will produce its own confidence
  // downstream — this is just a coarse "how sure was the detector".
  const confidence = computeLocalConfidence(trig);

  try {
    const rec = await client.createObservation({
      name: name.slice(0, 180),
      capturedAt: event.ts,
      url: event.url,
      clusterKey: event.pageKey,
      host,
      triggerKind: trig.reason,
      pageType,
      extracted,
      engagement,
      confidence,
      localEventId: event.id,
    });
    if (rec) {
      await bumpObservationStats();
      await setObservationLastError("");
      log("observation logged", rec.id);
    }
  } catch (e) {
    // If the Observations DB was deleted in Notion, recreate it once and
    // retry. bootstrapAll() is idempotent + uses /search which excludes
    // trashed objects, so it's safe to call here.
    if (e instanceof NotionGatewayError && e.code === "not_found") {
      const healed = await healSystemDatabases();
      if (healed) {
        const fresh = await getObservationsClient();
        if (fresh) {
          try {
            const rec = await fresh.createObservation({
              name: name.slice(0, 180),
              capturedAt: event.ts,
              url: event.url,
              clusterKey: event.pageKey,
              host,
              triggerKind: trig.reason,
              pageType,
              extracted,
              engagement,
              confidence,
              localEventId: event.id,
            });
            if (rec) {
              await bumpObservationStats();
              await setObservationLastError("");
              log("observation logged (post-heal)", rec.id);
              return;
            }
          } catch (e2) {
            const m2 = (e2 as Error).message;
            await setObservationLastError(m2);
            throw e2;
          }
        }
      }
    }
    const m = (e as Error).message;
    await setObservationLastError(m);
    throw e;
  }
}

function derivePageType(event: AppEvent): string | undefined {
  const pc = event.pageContext;
  if (!pc) return undefined;
  // JSON-LD @type wins when present.
  for (const block of pc.jsonLd ?? []) {
    const t = (block as { "@type"?: unknown })["@type"];
    if (typeof t === "string") return t;
    if (Array.isArray(t)) {
      const s = t.find((x) => typeof x === "string");
      if (s) return s as string;
    }
  }
  const og = pc.og?.["type"];
  if (typeof og === "string" && og) return og;
  return undefined;
}

/** Coarse local-heuristic 0..1 score for the Observations.Confidence column.
 *  Strong single-shot signals beat pattern signals; richness tier refines. */
function computeLocalConfidence(trig: Trigger): number {
  // Pattern triggers — depend almost entirely on judge to filter.
  if (trig.reason === "repetition" || trig.reason === "action-click") return 0.4;
  // Single-shot strong intent signals.
  if (trig.reason === "form-submit" || trig.reason === "terminal-nav") return 0.85;
  // Content / rich-page — let richness drive.
  const tier = trig.richness?.tier;
  if (tier === "high-value") return 0.9;
  if (tier === "content") return 0.6;
  return 0.5;
}

function isDwellMeta(v: unknown): v is {
  foregroundMs: number;
  maxScrollPct: number;
  interactionCount: number;
} {
  if (!v || typeof v !== "object") return false;
  const o = v as Record<string, unknown>;
  return (
    typeof o.foregroundMs === "number" &&
    typeof o.maxScrollPct === "number" &&
    typeof o.interactionCount === "number"
  );
}

/** One full pipeline run for a single trigger. */
// Removed in hackathon refactor: runTrigger() and friends. The single
// `runActivityJudge` path above replaces them.

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
 * Surface a meaningful candidate to the OS notification center so the user
 * knows there's something pending review even when the page that triggered
 * it is no longer in the foreground. Clicking the notification opens the
 * popup on the Completions tab.
 */
async function notifyPendingCandidate(candidate: CompletionCandidate): Promise<void> {
  if (!chrome.notifications?.create) return;
  const prop = candidate.judgement?.proposal;
  const dbName = prop?.database.name ?? "candidate";
  const mode = prop?.database.mode === "use-existing" ? "log to" : "create";
  await chrome.notifications.create(`pending:${candidate.id}`, {
    type: "basic",
    iconUrl: chrome.runtime.getURL("public/icon-128.png"),
    title: "Notion Hack — review pending",
    message: `Proposed: ${mode} "${dbName}". Click to review and apply.`,
    priority: 0,
  });
}

/**
 * For repetition triggers, the context is the union of:
 *   (a) the current event's same-tab lookback (recent activity around it), and
 *   (b) all past `page-dwell` / `nav` events sharing the same cluster (pageKey)
 *       — these are what makes the pattern visible to the LLM.
 * Result is sorted by time and deduped by id.
 */
// Removed in hackathon refactor: buildRepetitionContext, buildActionClickContext,
// coalesceWithRecent, loadRepetitionThrottle, loadRecentActionClusters,
// loadRecentRichUrls, loadRecentDwellUrls. The activity-judge path uses a
// flat time-windowed context and lets the LLM filter meaningfulness.

/** Re-run the judge for an existing candidate (popup "Retry"). */
export async function retryJudge(id: string): Promise<CompletionCandidate | null> {
  const c = await completions.get(id);
  if (!c) return null;
  if (!(await isFullyConnected())) {
    c.error = (await hasOpenAiKey()) ? "notion-not-connected" : "no-openai-key";
    await completions.update(c);
    return c;
  }
  try {
    const ctx = await loadJudgeContext();
    const judgement = await judgeCandidate(c, ctx.databases, ctx.workflows);
    c.judgement = judgement;
    c.error = null;
  } catch (e) {
    c.error = (e as Error).message;
  }
  await completions.update(c);
  return c;
}

/**
 * Snapshot of REAL workspace state the judge needs to decide whether to
 * reuse an existing destination DB and/or workflow vs. propose a new one.
 *
 *  - databases: all child DBs of the user's parent page (excludes the 3
 *    system DBs). The judge prefers `use-existing` against any of these.
 *  - workflows: all rows from the user's Workflows DB. The judge treats
 *    a matching workflow as a STANDING APPROVAL to reuse its target DB.
 *
 * Cached for 30s so a burst of triggers in the same tab doesn't re-fetch.
 */
interface JudgeContext {
  databases: KnownDatabase[];
  workflows: KnownWorkflow[];
}
const CTX_TTL_MS = 30_000;
let ctxCache: { at: number; value: JudgeContext } | null = null;

async function loadJudgeContext(): Promise<JudgeContext> {
  if (ctxCache && Date.now() - ctxCache.at < CTX_TTL_MS) {
    return ctxCache.value;
  }
  const client = await getObservationsClient();
  const conn = await getNotionConnection();
  if (!client || !conn.bootstrapped) {
    // Fall back to the (mostly empty) mock gateway so dev mode without a
    // real Notion connection still has SOMETHING to show the judge.
    const fallback = await notion.listDatabases();
    const value: JudgeContext = {
      databases: fallback.map((d) => ({
        id: d.id,
        name: d.name,
        description: "",
        properties: d.properties,
      })),
      workflows: [],
    };
    ctxCache = { at: Date.now(), value };
    return value;
  }
  // Parallel: child DBs under the parent + recent workflows from Workflows DB.
  const [databases, workflowsRaw] = await Promise.all([
    client.listChildDatabases(conn.parentPageId, 50).catch((e) => {
      log.warn("loadJudgeContext: listChildDatabases failed", (e as Error).message);
      return [] as Awaited<ReturnType<typeof client.listChildDatabases>>;
    }),
    client.listWorkflows(50).catch((e) => {
      log.warn("loadJudgeContext: listWorkflows failed", (e as Error).message);
      return [] as Awaited<ReturnType<typeof client.listWorkflows>>;
    }),
  ]);
  const workflows: KnownWorkflow[] = workflowsRaw
    .filter((w) => w.status !== "archived")
    .map((w) => ({
      id: w.id,
      name: w.name,
      status: w.status,
      runMode: w.runMode,
      targetDatabaseId: w.targetDatabaseId,
      targetDatabaseName: w.targetDatabaseName,
      sourceApps: w.sourceApps,
      reasoning: w.reasoning,
      runCount: w.runCount,
    }));
  const value: JudgeContext = {
    databases: databases.map((d) => ({
      id: d.id,
      name: d.name,
      description: d.description,
      properties: d.properties,
    })),
    workflows,
  };

  // Best-effort: fetch a few recent rows per DB so the judge can pattern-
  // match what already lives there. Parallel, capped concurrency via simple
  // batching. Failures swallow to []; absent samples just reduces prompt
  // signal, not a hard error.
  const SAMPLE_LIMIT = 5;
  const rowsByDb = await Promise.all(
    value.databases.map((d) =>
      client
        .listRecentRows(d.id, SAMPLE_LIMIT)
        .catch(() => [] as Awaited<ReturnType<typeof client.listRecentRows>>),
    ),
  );
  for (let i = 0; i < value.databases.length; i++) {
    const rows = rowsByDb[i] ?? [];
    if (rows.length) {
      value.databases[i].recentRows = rows.map((r) => ({ properties: r.properties }));
    }
  }

  ctxCache = { at: Date.now(), value };
  log(
    "judge context loaded",
    `dbs=${value.databases.length}·workflows=${value.workflows.length}·cache=${CTX_TTL_MS}ms`,
  );
  return value;
}

/** Force a re-fetch on next judge call. Call after applying a candidate
 *  so a newly-created workflow + DB appears in subsequent judgements
 *  without waiting for the TTL. */
export function invalidateJudgeContext(): void {
  ctxCache = null;
}

/** Reset in-memory ingest state — per-tab debounce + judge context cache.
 *  Call after a destructive local-data wipe so the next event behaves like
 *  a cold start. */
export function resetIngestState(): void {
  lastJudgeByTab.clear();
  ctxCache = null;
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
