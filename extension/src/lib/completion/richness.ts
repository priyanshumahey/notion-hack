// Page-signal gate + cluster key.
//
// We do NOT try to classify pages here. No tiers, no artifact-type inference,
// no URL-path heuristics. The LLM reads the page context (JSON-LD, og, title,
// URL, mainText) and decides what kind of thing it is.
//
// Our only job is to filter out pages that obviously have no substance —
// chrome://newtab, blank tabs, error pages, login walls — so we don't spam
// LLM calls on nothing. Anything with structured data OR an og tag OR a
// reasonable chunk of main text passes through to the judge.
//
// Cluster key: the dimension along which "repetition" is measured. We use
// the canonicalized `pageKey` — it's already designed to collapse instance
// IDs (e.g. `x.com/databricks/status/:id`) so 10 distinct tweets from the
// same author share one cluster key automatically.

import type { PageContext } from "../types";

/** Does the page have enough substance that the LLM has anything to reason over? */
export function hasSubstantiveContent(ctx: PageContext | undefined): boolean {
  if (!ctx) return false;
  if (ctx.jsonLd && ctx.jsonLd.length > 0) return true;
  if (ctx.og && Object.keys(ctx.og).length > 0) return true;
  if (ctx.title && ctx.title.length > 4 && ctx.mainText && ctx.mainText.length > 200) {
    return true;
  }
  return false;
}

/**
 * The "cluster" an event belongs to. Repetition is measured per cluster.
 *
 * For now: `pageKey` is the cluster. It's already canonicalized to collapse
 * instance IDs (tweet id, product id, article slug). Plain and effective.
 */
export function clusterKeyForEvent(pageKey: string): string {
  return pageKey;
}

