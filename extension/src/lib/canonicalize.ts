// URL → pageKey
//
// "pageKey" is what makes the same logical page across different IDs collapse
// to one identity (e.g. all `linkedin.com/jobs/view/123…` → `linkedin.com/jobs/view/:id`).
// Everything downstream — episode segmentation, trigger matching, workflow
// fingerprints — joins on pageKey, so this function carries a lot of weight.
//
// Rules:
//  - host: lowercased, strip `www.`
//  - path segments:
//      * pure digits           → :id
//      * UUID                  → :uuid
//      * 24-char hex (mongo)   → :id
//      * mixed-with-digit slug ≥ 8 chars → :slug  (e.g. linkedin's URN-like ids)
//      * otherwise kept
//  - query: dropped entirely (we'll opt specific params in later if needed)
//  - hash: dropped
//  - trailing slash: stripped (except root)

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const HEX24_RE = /^[0-9a-f]{24}$/i;
const ALL_DIGITS_RE = /^\d+$/;
const HAS_DIGIT_RE = /\d/;

function canonSegment(seg: string): string {
  if (!seg) return seg;
  if (ALL_DIGITS_RE.test(seg)) return ":id";
  if (UUID_RE.test(seg)) return ":uuid";
  if (HEX24_RE.test(seg)) return ":id";
  // long opaque slugs with digits → likely an id (linkedin urns etc.)
  if (seg.length >= 8 && HAS_DIGIT_RE.test(seg) && !/^[a-z][a-z-]*$/i.test(seg)) {
    return ":slug";
  }
  return seg.toLowerCase();
}

export function canonicalizeUrl(rawUrl: string): string {
  let u: URL;
  try {
    u = new URL(rawUrl);
  } catch {
    return rawUrl;
  }
  const host = u.hostname.replace(/^www\./, "").toLowerCase();
  const segments = u.pathname.split("/").filter(Boolean).map(canonSegment);
  const path = segments.length ? "/" + segments.join("/") : "";
  return host + path;
}

/** Canonicalize a relative or absolute href. Returns "" if not parseable. */
export function canonicalizeHref(href: string, baseUrl: string): string {
  if (!href) return "";
  try {
    const u = new URL(href, baseUrl);
    return canonicalizeUrl(u.toString());
  } catch {
    return "";
  }
}
