// Trigger detection. Pure functions over (event, history).
//
// Five trigger types feed the same downstream judge pipeline:
//
//   1. form-submit    — any <form> submit event. Strong, single-shot.
//   2. terminal-nav   — nav to a URL whose path screams "you just finished
//                       something" (confirmation / success / thank-you /
//                       applied / order-placed / receipt). Strong, single-shot.
//   3. content-dwell  — user engaged with a page (foreground time + scroll
//                       or interactions) that scores HIGH-VALUE on richness
//                       (job posting, product, event, recipe, ...). One
//                       observation is enough.
//   4. repetition     — same pageKey cluster observed ≥ N distinct URLs
//                       in the recent past. Pure URL-pattern signal: NO
//                       richness gate, NO dwell-duration gate. Fires on
//                       every nav-with-page-context and every page-dwell
//                       in the cluster — the LLM filters meaningfulness,
//                       and a 7-day per-cluster throttle in ingest
//                       prevents refires. Used to catch URL-based reading
//                       patterns AND shopping-style browsing (3 car
//                       listings, 5 product pages, 4 Airbnb listings, ...).
//   5. action-click   — user clicked the same UI element ≥ N times on
//                       the same host within a short window. "Same UI
//                       element" = same testid OR same normalized
//                       accessible-name / text label. NO verb whitelist;
//                       we surface any repeated UI interaction and let
//                       the LLM judge whether it's meaningful. Catches
//                       "I bookmarked 10 tweets" / "saved 5 jobs" /
//                       "wishlisted 4 products" — and also a long tail
//                       of patterns we can't enumerate up front.
//
// All detectors are pure: they take in events and read-only history, return
// zero-or-more triggers. Side effects (judge call, store write, throttling)
// happen in background/ingest.ts.

import type { AppEvent, DwellMeta, Fingerprint } from "../types";
import { scoreRichness, clusterKeyForEvent, type RichnessScore } from "./richness";

export type TriggerReason =
  | "form-submit"
  | "terminal-nav"
  | "content-dwell"
  | "repetition"
  | "action-click"
  | "rich-page";

export interface Trigger {
  reason: TriggerReason;
  /** Human-readable explanation. Surfaces in the prompt and the UI. */
  note: string;
  /**
   * For repetition: pageKey cluster.
   * For action-click: `${host}:${verb}` cluster.
   * For others: undefined.
   */
  clusterKey?: string;
  /** For repetition: distinct URLs that contributed to the cluster. */
  clusterUrls?: string[];
  /** Carried into the judge prompt to inform the LLM how this fired. */
  richness?: RichnessScore;
}

/**
 * Path tokens that strongly suggest "you just finished something". Matched
 * against the canonicalized `pageKey` of a `nav` event.
 *
 * Kept conservative on purpose. Add post-submit terms only as we observe
 * real flows.
 */
const TERMINAL_PATH_RE =
  /(^|\/|[_-])(confirmation|submitted|success|thank[-_]?you|thanks|complete|completed|applied|order[-_]?placed|order[-_]?confirmed|receipt)(\/|$|[_-])/i;

// ---- Dwell trigger tuning -------------------------------------------------
// Generous on token budget per user direction — these thresholds are LOW
// because the judge call itself filters noise. Better to ask the LLM and
// get a "not meaningful" than to miss something.
const DWELL_HIGH_VALUE_FOREGROUND_MS = 6_000;   // 6 s on a job posting → trigger
// Engaged-content shortcut: a "content" tier page with high engagement
// (deep scroll + interactions) is a content-dwell trigger. Catches single
// deep-reads of tweets/articles where the user clearly cared.
const DWELL_ENGAGED_FOREGROUND_MS = 6_000;
const DWELL_ENGAGED_MIN_SCROLL_PCT = 70;
const DWELL_ENGAGED_MIN_INTERACTIONS = 2;

// ---- Repetition trigger tuning --------------------------------------------
const REPETITION_LOOKBACK_MS = 30 * 24 * 60 * 60 * 1000;  // 30 days
const REPETITION_MIN_DISTINCT_URLS = 3;                    // 3+ distinct URLs in cluster

// ---- Action-click trigger tuning ------------------------------------------
const ACTION_CLICK_WINDOW_MS = 5 * 60_000;  // 5 min rolling window per (host, signature)
const ACTION_CLICK_MIN_COUNT = 2;           // 2 of the same signature → pattern
const ACTION_CLICK_MIN_GAP_MS = 500;        // ignore near-duplicate fires (capture-phase double-fire)
const SIGNATURE_MAX_LEN = 60;               // labels longer than this are tile-cards, not buttons
const SIGNATURE_MIN_LEN = 2;                // labels shorter than this carry no signal

/**
 * Compute a short, normalized signature for a click target. Two clicks
 * with the same signature on the same host are treated as "the same UI
 * action repeated".
 *
 * NO verb / noun matching. We let the LLM decide whether a cluster of
 * repeated clicks is meaningful — the detector's only job is to surface
 * the pattern.
 *
 * Returns null when the click isn't a candidate for clustering:
 *   - empty / whitespace label
 *   - very long label (almost certainly a tile-card aggregate, not a button)
 *   - very short label (no signal)
 */
export function clickSignature(fp: Fingerprint | undefined): string | null {
  if (!fp) return null;
  // testid is the most stable identity — prefer it whenever the page
  // provides one. Same testid on different pages = same UI element.
  if (fp.testid) {
    const t = fp.testid.trim().toLowerCase();
    if (t.length >= SIGNATURE_MIN_LEN && t.length <= SIGNATURE_MAX_LEN) {
      return `testid:${t}`;
    }
  }
  // Fall back to accessibleName, then visible text.
  const raw = (fp.accessibleName || fp.text || "").trim();
  if (!raw) return null;
  const norm = raw.replace(/\s+/g, " ").toLowerCase();
  if (norm.length < SIGNATURE_MIN_LEN) return null;
  if (norm.length > SIGNATURE_MAX_LEN) return null;
  return `label:${norm}`;
}

/** Pretty-print a signature for human display (strips the kind prefix). */
function prettySignature(sig: string): string {
  const idx = sig.indexOf(":");
  return idx === -1 ? sig : sig.slice(idx + 1);
}

export interface DetectInput {
  event: AppEvent;
  /** All recent events (newest→oldest), used by repetition + action-click. */
  history: AppEvent[];
  /**
   * Cluster keys we should NOT fire a repetition trigger for right now.
   * Owned by ingest. Populated from:
   *   - clusters with a pending or denied candidate (don't pester);
   *   - approved clusters do NOT appear here — we want re-fires there so
   *     the user can keep adding new items to the same DB.
   */
  recentlyFiredRepetitionClusters: Set<string>;
  /**
   * Exact URLs already firing a repetition candidate in the recent past.
   * Per-URL dedup runs in addition to the cluster check — prevents
   * duplicate candidates for the same job/listing as the user revisits
   * the same SPA page.
   */
  recentlyFiredRepetitionUrls: Set<string>;
  /**
   * `${host}:${verb}` keys we've ALREADY fired an action-click trigger for
   * recently — used to throttle.
   */
  recentlyFiredActionClusters: Set<string>;
  /**
   * Exact URLs we've already fired a `rich-page` trigger for recently.
   * Per-URL dedup; prevents re-judging the same recipe page on every
   * revisit. Owned by ingest, sourced from the completions store.
   */
  recentlyFiredRichUrls: Set<string>;
  /**
   * Exact URLs we've already fired a `content-dwell` trigger for recently.
   * Dwell can re-emit every time the user revisits a page, which without
   * this dedup creates duplicate candidates for the same artifact.
   */
  recentlyFiredDwellUrls: Set<string>;
}

/**
 * Detect all triggers for a single event. May return 0..N. Caller will
 * coalesce duplicates downstream.
 */
export function detectTriggers(input: DetectInput): Trigger[] {
  const { event } = input;
  const out: Trigger[] = [];

  // 1. Form submit — always strong.
  if (event.kind === "submit") {
    out.push({
      reason: "form-submit",
      note: event.formContext
        ? `submitted form ${event.formContext.formName ?? ""} with ${event.formContext.fields.length} fields`
        : "form submit",
    });
  }

  // 2. Terminal-nav — confirmation-style URL.
  if (event.kind === "nav" && TERMINAL_PATH_RE.test(event.pageKey)) {
    out.push({
      reason: "terminal-nav",
      note: `URL matched terminal pattern: ${event.pageKey}`,
    });
  }

  // 3. Content-dwell — engaged with a rich page.
  if (event.kind === "page-dwell" && !input.recentlyFiredDwellUrls.has(event.url)) {
    const dwell = event.meta as DwellMeta | undefined;
    const rich = scoreRichness(event.pageContext);
    if (dwell && rich.tier === "high-value" && dwell.foregroundMs >= DWELL_HIGH_VALUE_FOREGROUND_MS) {
      out.push({
        reason: "content-dwell",
        note: `engaged ${secs(dwell.foregroundMs)}s with ${rich.primaryType ?? "rich"} page (scroll ${Math.round(dwell.maxScrollPct)}%, ${dwell.interactionCount} interactions)`,
        richness: rich,
      });
    } else if (
      dwell &&
      rich.tier === "content" &&
      dwell.foregroundMs >= DWELL_ENGAGED_FOREGROUND_MS &&
      dwell.maxScrollPct >= DWELL_ENGAGED_MIN_SCROLL_PCT &&
      dwell.interactionCount >= DWELL_ENGAGED_MIN_INTERACTIONS
    ) {
      // Engaged-content shortcut: deep scroll + interactions on a content
      // page (article, tweet, video). Even a single observation is worth a
      // judge call — the user's behavior says they cared.
      out.push({
        reason: "content-dwell",
        note: `deep engagement on ${rich.primaryType ?? "content"} page: ${secs(dwell.foregroundMs)}s, scroll ${Math.round(dwell.maxScrollPct)}%, ${dwell.interactionCount} interactions`,
        richness: rich,
      });
    }
  }

  // 4. Repetition — same pageKey cluster ≥ N distinct URLs in window.
  //    Runs on every page-dwell and on every nav that has page context
  //    (the post-load / SPA-settled snapshot, NOT the bare webNavigation
  //    notifications). NO richness or duration gate — pure URL-pattern
  //    clustering. The LLM judges whether the pattern is meaningful;
  //    the 7-day per-cluster throttle in ingest prevents refires.
  if (
    event.kind === "page-dwell" ||
    (event.kind === "nav" && event.pageContext)
  ) {
    const rep = detectRepetition(
      event,
      input.history,
      input.recentlyFiredRepetitionClusters,
      input.recentlyFiredRepetitionUrls,
    );
    if (rep) out.push(rep);
  }

  // 5. Action-click — curated action verb on same host repeated.
  if (event.kind === "click") {
    const ac = detectActionClick(event, input.history, input.recentlyFiredActionClusters);
    if (ac) out.push(ac);
  }

  // 6. Rich-page — any nav-with-pageContext (or page-dwell) whose page
  //    has at least "content"-tier richness. No clustering, no dwell
  //    requirement; the judge call decides if this artifact belongs in a
  //    user-approved DB. URL-deduped against recent rich-page fires so
  //    repeat visits don't burn tokens.
  if (
    event.kind === "page-dwell" ||
    (event.kind === "nav" && event.pageContext)
  ) {
    const rp = detectRichPage(event, input.recentlyFiredRichUrls);
    if (rp) out.push(rp);
  }

  return out;
}

function detectRepetition(
  event: AppEvent,
  history: AppEvent[],
  blockedClusters: Set<string>,
  firedUrls: Set<string>,
): Trigger | null {
  const cluster = clusterKeyForEvent(event.pageKey);
  if (!cluster) return null;
  if (blockedClusters.has(cluster)) return null;
  // Per-URL dedup: never fire two candidates for the exact same URL.
  if (firedUrls.has(event.url)) return null;

  const cutoffTs = event.ts - REPETITION_LOOKBACK_MS;
  const distinctUrls = new Set<string>();
  distinctUrls.add(event.url);
  for (const e of history) {
    if (e.id === event.id) continue;
    if (e.ts < cutoffTs) break; // history is newest→oldest
    if (e.kind !== "page-dwell" && e.kind !== "nav") continue;
    if (clusterKeyForEvent(e.pageKey) !== cluster) continue;
    distinctUrls.add(e.url);
    if (distinctUrls.size >= REPETITION_MIN_DISTINCT_URLS) break;
  }
  if (distinctUrls.size < REPETITION_MIN_DISTINCT_URLS) return null;

  const urls = Array.from(distinctUrls);
  return {
    reason: "repetition",
    note: `${urls.length} distinct URLs in cluster "${cluster}" within ${Math.round(REPETITION_LOOKBACK_MS / 86_400_000)} days`,
    clusterKey: cluster,
    clusterUrls: urls,
  };
}

function detectRichPage(
  event: AppEvent,
  firedUrls: Set<string>,
): Trigger | null {
  if (firedUrls.has(event.url)) return null;
  const rich = scoreRichness(event.pageContext);
  if (rich.tier === "noise") return null;
  return {
    reason: "rich-page",
    note: rich.primaryType
      ? `rich ${rich.tier} page (${rich.primaryType})`
      : `rich ${rich.tier} page`,
    richness: rich,
  };
}

function detectActionClick(
  event: AppEvent,
  history: AppEvent[],
  recentlyFired: Set<string>,
): Trigger | null {
  const sig = clickSignature(event.fingerprint);
  if (!sig) return null;

  const host = hostOfPageKey(event.pageKey);
  if (!host) return null;

  const cluster = `${host}::${sig}`;
  if (recentlyFired.has(cluster)) return null;

  const cutoffTs = event.ts - ACTION_CLICK_WINDOW_MS;
  let count = 1;
  let lastCountedTs = event.ts;
  for (const e of history) {
    if (e.id === event.id) continue;
    if (e.ts < cutoffTs) break;
    if (e.kind !== "click") continue;
    if (hostOfPageKey(e.pageKey) !== host) continue;
    if (clickSignature(e.fingerprint) !== sig) continue;
    // Drop near-duplicate clicks (capture-phase double-fire on the same UI).
    if (Math.abs(lastCountedTs - e.ts) < ACTION_CLICK_MIN_GAP_MS) {
      lastCountedTs = e.ts;
      continue;
    }
    count++;
    lastCountedTs = e.ts;
  }

  if (count < ACTION_CLICK_MIN_COUNT) return null;

  return {
    reason: "action-click",
    note: `${count} clicks on "${prettySignature(sig)}" at ${host} within ${Math.round(ACTION_CLICK_WINDOW_MS / 60_000)} min`,
    clusterKey: cluster,
  };
}

function hostOfPageKey(pageKey: string): string {
  return pageKey.split("/")[0] ?? "";
}

function secs(ms: number): number {
  return Math.round(ms / 1000);
}

/** Exposed for tests / debugging. */
export const _internals = {
  TERMINAL_PATH_RE,
  DWELL_HIGH_VALUE_FOREGROUND_MS,
  DWELL_ENGAGED_FOREGROUND_MS,
  DWELL_ENGAGED_MIN_SCROLL_PCT,
  DWELL_ENGAGED_MIN_INTERACTIONS,
  REPETITION_LOOKBACK_MS,
  REPETITION_MIN_DISTINCT_URLS,
  ACTION_CLICK_WINDOW_MS,
  ACTION_CLICK_MIN_COUNT,
  ACTION_CLICK_MIN_GAP_MS,
};

