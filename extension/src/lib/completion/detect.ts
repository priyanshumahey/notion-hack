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
//   4. repetition     — same pageKey cluster observed ≥ N times across
//                       distinct URLs in the recent past. Used to catch
//                       URL-based reading patterns.
//   5. action-click   — user clicked ≥ N curated "action verb" buttons
//                       (Bookmark, Save, Like, Follow, Add to cart, RSVP,
//                       Subscribe, Wishlist, Star, Watch, Favorite, Pin,
//                       Upvote) on the same host within a short window.
//                       Catches the "I bookmarked 10 tweets" / "saved 5
//                       jobs" / "wishlisted 4 products" pattern, which is
//                       invisible to URL-based repetition.
//
// All detectors are pure: they take in events and read-only history, return
// zero-or-more triggers. Side effects (judge call, store write, throttling)
// happen in background/ingest.ts.

import type { AppEvent, DwellMeta } from "../types";
import { scoreRichness, clusterKeyForEvent, type RichnessScore } from "./richness";

export type TriggerReason =
  | "form-submit"
  | "terminal-nav"
  | "content-dwell"
  | "repetition"
  | "action-click";

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
const DWELL_CONTENT_FOREGROUND_MS = 12_000;     // 12 s on an article  → eligible for repetition
// Engaged-content shortcut: a "content" tier page with high engagement
// (deep scroll + interactions) is a content-dwell trigger even below the
// repetition threshold. Catches single deep-reads of tweets/articles where
// the user clearly cared.
const DWELL_ENGAGED_FOREGROUND_MS = 6_000;
const DWELL_ENGAGED_MIN_SCROLL_PCT = 70;
const DWELL_ENGAGED_MIN_INTERACTIONS = 2;

// ---- Repetition trigger tuning --------------------------------------------
const REPETITION_LOOKBACK_MS = 30 * 24 * 60 * 60 * 1000;  // 30 days
const REPETITION_MIN_DISTINCT_URLS = 3;                    // 3+ distinct URLs in cluster

// ---- Action-click trigger tuning ------------------------------------------
const ACTION_CLICK_WINDOW_MS = 5 * 60_000;  // 5 min rolling window per (host, verb)
const ACTION_CLICK_MIN_COUNT = 2;           // 2 of the same action → pattern

/**
 * Map a click target label (accessibleName/text) to a canonical action verb,
 * or null. Matches whole-label only (the button text IS the verb) and
 * tolerates common toggled / past-tense forms.
 *
 * Keep this list curated and tight — false positives here mean spurious
 * candidates. If a verb shows up that we don't want, prefer adding a
 * negative match or tightening the regex over making it more permissive.
 */
export function matchActionVerb(label: string | undefined | null): string | null {
  if (!label) return null;
  const t = label.trim().toLowerCase();
  if (!t || t.length > 32) return null;

  // bookmark / unbookmark
  if (/^bookmark(ed|s)?$/.test(t)) return "bookmark";
  // save / saved (NOT "save changes", "save as ...")
  if (/^save(d|s)?$/.test(t)) return "save";
  // like / liked / unlike (NOT "i like this")
  if (/^(un)?like(d|s)?$/.test(t)) return "like";
  // follow / unfollow / following
  if (/^(un)?follow(ed|ing|s)?$/.test(t)) return "follow";
  // subscribe / unsubscribe / subscribed
  if (/^(un)?subscribe(d|s)?$/.test(t)) return "subscribe";
  // add to cart/bag/wishlist/list
  if (/^add to (cart|bag|wishlist|list)$/.test(t)) return "add-to-cart";
  if (/^add$/.test(t)) return null; // too noisy by itself
  // wishlist / wishlisted
  if (/^wishlist(ed)?$/.test(t)) return "wishlist";
  // star / starred / unstar (GitHub etc.)
  if (/^(un)?star(red|s)?$/.test(t)) return "star";
  // watch / watching / unwatch (GitHub etc.)
  if (/^(un)?watch(ed|ing|s)?$/.test(t)) return "watch";
  // favorite / favorited / favourite / favourited
  if (/^favou?rite(d|s)?$/.test(t)) return "favorite";
  // rsvp / going / attending / interested
  if (/^rsvp$/.test(t)) return "rsvp";
  if (/^going$/.test(t)) return "rsvp";
  if (/^attend(ing)?$/.test(t)) return "rsvp";
  if (/^interested$/.test(t)) return "rsvp";
  // pin / pinned
  if (/^(un)?pin(ned|s)?$/.test(t)) return "pin";
  // upvote / downvote
  if (/^(up|down)vote(d|s)?$/.test(t)) return "vote";

  return null;
}

export interface DetectInput {
  event: AppEvent;
  /** All recent events (newest→oldest), used by repetition + action-click. */
  history: AppEvent[];
  /**
   * Cluster keys we've ALREADY fired a repetition trigger for recently —
   * used to throttle. Owned by the ingest layer.
   */
  recentlyFiredRepetitionClusters: Set<string>;
  /**
   * `${host}:${verb}` keys we've ALREADY fired an action-click trigger for
   * recently — used to throttle.
   */
  recentlyFiredActionClusters: Set<string>;
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
  if (event.kind === "page-dwell") {
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

    // 4. Repetition — same pageKey cluster ≥ N distinct URLs in window.
    if (
      dwell &&
      (rich.tier === "high-value" || rich.tier === "content") &&
      dwell.foregroundMs >= DWELL_CONTENT_FOREGROUND_MS
    ) {
      const rep = detectRepetition(event, input.history, input.recentlyFiredRepetitionClusters);
      if (rep) out.push(rep);
    }
  }

  // 5. Action-click — curated action verb on same host repeated.
  if (event.kind === "click") {
    const ac = detectActionClick(event, input.history, input.recentlyFiredActionClusters);
    if (ac) out.push(ac);
  }

  return out;
}

function detectRepetition(
  event: AppEvent,
  history: AppEvent[],
  recentlyFired: Set<string>,
): Trigger | null {
  const cluster = clusterKeyForEvent(event.pageKey);
  if (!cluster) return null;
  if (recentlyFired.has(cluster)) return null;

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

function detectActionClick(
  event: AppEvent,
  history: AppEvent[],
  recentlyFired: Set<string>,
): Trigger | null {
  const fp = event.fingerprint;
  if (!fp) return null;
  const label = (fp.accessibleName || fp.text || "").trim();
  const verb = matchActionVerb(label);
  if (!verb) return null;

  const host = hostOfPageKey(event.pageKey);
  if (!host) return null;

  const cluster = `${host}:${verb}`;
  if (recentlyFired.has(cluster)) return null;

  const cutoffTs = event.ts - ACTION_CLICK_WINDOW_MS;
  let count = 1; // this event itself
  for (const e of history) {
    if (e.id === event.id) continue;
    if (e.ts < cutoffTs) break;
    if (e.kind !== "click") continue;
    if (hostOfPageKey(e.pageKey) !== host) continue;
    const efp = e.fingerprint;
    if (!efp) continue;
    const elabel = (efp.accessibleName || efp.text || "").trim();
    if (matchActionVerb(elabel) !== verb) continue;
    count++;
  }

  if (count < ACTION_CLICK_MIN_COUNT) return null;

  return {
    reason: "action-click",
    note: `${count} "${verb}" actions on ${host} within ${Math.round(ACTION_CLICK_WINDOW_MS / 60_000)} min`,
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
  DWELL_CONTENT_FOREGROUND_MS,
  DWELL_ENGAGED_FOREGROUND_MS,
  DWELL_ENGAGED_MIN_SCROLL_PCT,
  DWELL_ENGAGED_MIN_INTERACTIONS,
  REPETITION_LOOKBACK_MS,
  REPETITION_MIN_DISTINCT_URLS,
  ACTION_CLICK_WINDOW_MS,
  ACTION_CLICK_MIN_COUNT,
};

