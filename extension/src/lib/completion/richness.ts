// Content-richness scoring & clustering.
//
// "Rich" means: the page has structured signal we can build a Notion artifact
// around. Concretely we score the PageContext by looking at JSON-LD @type,
// og:type, mainText length, and JSON-LD field density.
//
// Tiers:
//   - "high-value"  → the page is itself the artifact (job posting, product
//                     page, event listing, recipe). One observation is enough
//                     to be worth a judge call.
//   - "content"     → reading-style content (article, tweet, video page) —
//                     individually low-value to Notion, but interesting when
//                     it REPEATS. Eligible for repetition triggering.
//   - "noise"       → SERPs, settings pages, app shells, blank screens.
//                     Never triggers.
//
// Cluster key: the dimension along which "repetition" is measured. We use
// the canonicalized `pageKey` — it's already designed to collapse instance
// IDs (e.g. `x.com/databricks/status/:id`) so 10 distinct tweets from the
// same author share one cluster key automatically.

import type { PageContext } from "../types";

export type RichnessTier = "noise" | "content" | "high-value";

export interface RichnessScore {
  tier: RichnessTier;
  /** Free-form reasons surfaced in the UI / prompt. */
  reasons: string[];
  /** Primary structured-type label, if any (e.g. "JobPosting"). */
  primaryType: string | null;
}

/** JSON-LD @types that nearly always represent a single-shot saveable artifact. */
const HIGH_VALUE_LD_TYPES = new Set([
  "JobPosting",
  "Product",
  "Event",
  "Recipe",
  "Course",
  "Movie",
  "TVSeries",
  "Book",
  "MusicAlbum",
  "MusicRecording",
  "SoftwareApplication",
  "RealEstateListing",
  "Apartment",
  "House",
  "Vehicle",
  "FlightReservation",
  "LodgingReservation",
  "Reservation",
  "Order",
]);

/** JSON-LD @types that are "content" — interesting when repeated, not alone. */
const CONTENT_LD_TYPES = new Set([
  "Article",
  "NewsArticle",
  "BlogPosting",
  "SocialMediaPosting",
  "DiscussionForumPosting",
  "VideoObject",
  "Question",
  "Answer",
  "HowTo",
  "WebPage",
  "Review",
  "ImageObject",
]);

/** og:type values mapped to a coarse tier. */
const OG_HIGH_VALUE = new Set(["product", "product.item", "book", "video.movie", "video.tv_show"]);
const OG_CONTENT = new Set(["article", "video.other", "video.episode", "music.song", "profile"]);

export function scoreRichness(ctx: PageContext | undefined): RichnessScore {
  if (!ctx) return { tier: "noise", reasons: ["no page context"], primaryType: null };

  const reasons: string[] = [];
  let primaryType: string | null = null;

  // 1. JSON-LD @type is the strongest signal. Look at every block; pick the
  //    first matching high-value type, then content type.
  let ldTier: RichnessTier = "noise";
  for (const block of ctx.jsonLd) {
    const type = readType(block);
    if (!type) continue;
    if (HIGH_VALUE_LD_TYPES.has(type)) {
      ldTier = "high-value";
      primaryType = type;
      reasons.push(`json-ld @type=${type}`);
      break;
    }
    if (CONTENT_LD_TYPES.has(type) && ldTier === "noise") {
      ldTier = "content";
      primaryType = type;
      reasons.push(`json-ld @type=${type}`);
    }
  }

  // 2. og:type as a secondary signal.
  const ogType = ctx.og?.type;
  if (ogType) {
    if (OG_HIGH_VALUE.has(ogType) && ldTier !== "high-value") {
      ldTier = "high-value";
      primaryType = primaryType ?? ogType;
      reasons.push(`og:type=${ogType}`);
    } else if (OG_CONTENT.has(ogType) && ldTier === "noise") {
      ldTier = "content";
      primaryType = primaryType ?? ogType;
      reasons.push(`og:type=${ogType}`);
    }
  }

  // 3. Heuristic: long article-ish content even without structured data.
  if (ldTier === "noise" && ctx.mainText.length > 800 && ctx.title.length > 10) {
    ldTier = "content";
    reasons.push(`long-form text (${ctx.mainText.length} chars)`);
  }

  if (ldTier === "noise") {
    reasons.push("no high-signal markers");
  }
  return { tier: ldTier, reasons, primaryType };
}

/** Read @type from a JSON-LD block. Handles arrays + namespaced types. */
function readType(block: unknown): string | null {
  if (!block || typeof block !== "object") return null;
  const t = (block as Record<string, unknown>)["@type"];
  if (typeof t === "string") return stripNs(t);
  if (Array.isArray(t)) {
    for (const v of t) if (typeof v === "string") return stripNs(v);
  }
  return null;
}
function stripNs(t: string): string {
  // "schema:JobPosting" → "JobPosting"
  const i = t.lastIndexOf(":");
  return i >= 0 ? t.slice(i + 1) : t;
}

/**
 * The "cluster" an event belongs to. Repetition is measured per cluster.
 *
 * For now: `pageKey` is the cluster. It's already canonicalized to collapse
 * instance IDs (tweet id, product id, article slug). Plain and effective.
 *
 * Future refinements (not done now): blend in JSON-LD author/publisher so we
 * cluster across paths (e.g. "all @databricks posts wherever they appear").
 */
export function clusterKeyForEvent(pageKey: string): string {
  return pageKey;
}
