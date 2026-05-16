// Page-context capture.
//
// Goal: turn the live DOM into a small, structured snapshot the LLM can
// actually reason over. We bias toward what tends to be HIGH-SIGNAL on
// real-world pages:
//
//   - <title>, canonical URL, lang
//   - <meta name=description>, og:*, twitter:*  (publisher-curated summaries)
//   - h1/h2/h3 headings                          (page outline)
//   - JSON-LD blocks                             (structured data: jobs, products, events, articles)
//   - main/article text excerpt                  (fallback when nothing structured exists)
//   - current selection                          (if the user has highlighted something)
//
// And for form submits specifically: the form's action/method and a snapshot
// of every field (name, type, associated <label>, value). File inputs record
// the filename only. PASSWORDS are deliberately excluded from `value` for
// security reasons (regardless of the "don't redact" preference) — sending
// a plaintext password to OpenAI is not something we want to do by default.
//
// Hard rules:
//   - All capture is synchronous and bounded. No DOM mutation observers,
//     no network, no waiting.
//   - Every string is length-capped. Every list is count-capped. Total
//     snapshot stays well under ~30 KB even on rich pages.
//   - Failures are swallowed and reported in `errors[]`. Never throw.

import type { FormContext, FormField, PageContext } from "./types";

// ---- limits ---------------------------------------------------------------
const LIM = {
  title: 300,
  description: 600,
  heading: 240,
  headingsCount: 12,
  mainText: 2400,
  selectionText: 1000,
  metaField: 400,
  jsonLdBlocks: 5,
  jsonLdSerializedBytes: 6_000,    // per block; we re-stringify after parse
  formFields: 80,
  formFieldValue: 1_000,
  formFieldLabel: 240,
  textNodeMin: 2,                  // skip whitespace-only nodes
} as const;

/** Capture a structured snapshot of the current document. Safe on any page. */
export function capturePageContext(): PageContext {
  const errors: string[] = [];
  const safe = <T>(fn: () => T, fallback: T, label: string): T => {
    try {
      return fn();
    } catch (e) {
      errors.push(`${label}: ${(e as Error).message}`);
      return fallback;
    }
  };

  const title = safe(() => clip(document.title, LIM.title), "", "title");
  const lang = safe(() => document.documentElement.lang || undefined, undefined, "lang");
  const canonicalUrl = safe(
    () => (document.querySelector('link[rel="canonical"]') as HTMLLinkElement | null)?.href || undefined,
    undefined,
    "canonical",
  );

  const meta = safe(() => readMeta(), {}, "meta");
  const og = safe(() => readPrefixed("og:"), {}, "og");
  const twitter = safe(() => readPrefixed("twitter:"), {}, "twitter");
  const description = meta.description || og.description || twitter.description || undefined;

  const headings = safe(() => readHeadings(), [], "headings");
  const jsonLd = safe(() => readJsonLd(errors), [], "jsonLd");
  const mainText = safe(() => readMainText(), "", "mainText");
  const selectionText = safe(() => readSelection(), undefined, "selection");

  const ctx: PageContext = {
    capturedAt: Date.now(),
    url: location.href,
    canonicalUrl,
    title,
    lang,
    description: description ? clip(description, LIM.description) : undefined,
    og: pruneEmpty(og),
    twitter: pruneEmpty(twitter),
    headings,
    jsonLd,
    mainText,
    selectionText,
    contentHash: "",
    errors: errors.length ? errors : undefined,
  };
  ctx.contentHash = hashContext(ctx);
  return ctx;
}

/** Capture form context for a <form> at submit time. */
export function captureFormContext(form: HTMLFormElement): FormContext {
  const errors: string[] = [];
  const fields: FormField[] = [];

  let action = "";
  let method = "get";
  try {
    action = form.action || "";
    method = (form.method || "get").toLowerCase();
  } catch {
    /* some pages override form.action with non-strings */
  }

  let i = 0;
  for (const el of Array.from(form.elements)) {
    if (i >= LIM.formFields) {
      errors.push(`truncated at ${LIM.formFields} fields`);
      break;
    }
    const f = readField(el);
    if (f) {
      fields.push(f);
      i++;
    }
  }

  return {
    action,
    method,
    formName: form.name || form.id || undefined,
    fields,
    errors: errors.length ? errors : undefined,
  };
}

// ---------------------------------------------------------------------------
// meta / og / twitter
// ---------------------------------------------------------------------------

function readMeta(): Record<string, string> {
  const out: Record<string, string> = {};
  const nodes = document.head.querySelectorAll('meta[name][content]');
  for (const n of Array.from(nodes)) {
    const name = (n.getAttribute("name") || "").toLowerCase();
    const content = n.getAttribute("content") || "";
    if (!name || !content) continue;
    if (out[name]) continue;
    out[name] = clip(content, LIM.metaField);
  }
  return out;
}

function readPrefixed(prefix: string): Record<string, string> {
  const out: Record<string, string> = {};
  const nodes = document.head.querySelectorAll(`meta[property^="${prefix}"][content], meta[name^="${prefix}"][content]`);
  for (const n of Array.from(nodes)) {
    const key = ((n.getAttribute("property") || n.getAttribute("name")) ?? "")
      .toLowerCase()
      .replace(prefix, "");
    const content = n.getAttribute("content") || "";
    if (!key || !content) continue;
    if (out[key]) continue;
    out[key] = clip(content, LIM.metaField);
  }
  return out;
}

// ---------------------------------------------------------------------------
// headings
// ---------------------------------------------------------------------------

function readHeadings(): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  const nodes = document.querySelectorAll("h1, h2, h3");
  for (const n of Array.from(nodes)) {
    const t = collapseWhitespace((n as HTMLElement).innerText || n.textContent || "");
    if (t.length < LIM.textNodeMin) continue;
    const clipped = clip(t, LIM.heading);
    if (seen.has(clipped)) continue;
    seen.add(clipped);
    const level = n.tagName.toLowerCase();
    out.push(`${level}: ${clipped}`);
    if (out.length >= LIM.headingsCount) break;
  }
  return out;
}

// ---------------------------------------------------------------------------
// JSON-LD — the highest-signal source on most real pages.
//
// Pages commonly ship an array of blocks, a `@graph` with many entities,
// or a single object. We normalize all of these to a flat array of objects,
// then truncate aggressively per block.
// ---------------------------------------------------------------------------

function readJsonLd(errors: string[]): unknown[] {
  const out: unknown[] = [];
  const scripts = document.querySelectorAll('script[type="application/ld+json"]');
  for (const s of Array.from(scripts)) {
    if (out.length >= LIM.jsonLdBlocks) break;
    const raw = s.textContent;
    if (!raw) continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch (e) {
      errors.push("jsonLd parse: " + (e as Error).message);
      continue;
    }
    for (const item of normalizeLd(parsed)) {
      if (out.length >= LIM.jsonLdBlocks) break;
      out.push(truncateJson(item, LIM.jsonLdSerializedBytes));
    }
  }
  return out;
}

function normalizeLd(x: unknown): unknown[] {
  if (Array.isArray(x)) return x.flatMap(normalizeLd);
  if (x && typeof x === "object") {
    const o = x as Record<string, unknown>;
    if (Array.isArray(o["@graph"])) return (o["@graph"] as unknown[]).flatMap(normalizeLd);
    return [o];
  }
  return [];
}

/**
 * Re-serialize an object and if it's over `maxBytes`, recursively strip the
 * largest string/array fields until it fits. Always returns a valid object;
 * never throws.
 */
function truncateJson(x: unknown, maxBytes: number): unknown {
  let s = safeStringify(x);
  if (s.length <= maxBytes) {
    try {
      return JSON.parse(s);
    } catch {
      return x;
    }
  }
  // Shrink: cap strings, drop deeply nested arrays beyond 5 items.
  const shrink = (val: unknown, depth: number): unknown => {
    if (typeof val === "string") return val.length > 400 ? val.slice(0, 400) + "…" : val;
    if (Array.isArray(val)) {
      const arr = (val.length > 5 ? val.slice(0, 5) : val).map((v) => shrink(v, depth + 1));
      if (val.length > 5) arr.push(`…${val.length - 5} more`);
      return arr;
    }
    if (val && typeof val === "object" && depth < 6) {
      const o: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(val as Record<string, unknown>)) {
        o[k] = shrink(v, depth + 1);
      }
      return o;
    }
    return val;
  };
  const trimmed = shrink(x, 0);
  s = safeStringify(trimmed);
  if (s.length > maxBytes) {
    return { "@truncated": true, preview: s.slice(0, maxBytes) };
  }
  try {
    return JSON.parse(s);
  } catch {
    return trimmed;
  }
}

function safeStringify(x: unknown): string {
  const seen = new WeakSet<object>();
  return JSON.stringify(x, (_k, v) => {
    if (v && typeof v === "object") {
      if (seen.has(v)) return "[cycle]";
      seen.add(v);
    }
    return v;
  }) ?? "";
}

// ---------------------------------------------------------------------------
// main / article text excerpt
//
// Strategy: pick the largest meaningful container that's likely to be the
// page's primary content, then take its innerText collapsed.
//   1. <main>, <article>, [role=main]
//   2. fallback: first element with the most "content-ish" text
//   3. fallback: document.body.innerText
// ---------------------------------------------------------------------------

function readMainText(): string {
  const candidates: HTMLElement[] = [];
  const sel = "main, article, [role='main']";
  for (const n of Array.from(document.querySelectorAll(sel))) {
    candidates.push(n as HTMLElement);
  }
  let best: HTMLElement | null = null;
  let bestLen = 0;
  for (const c of candidates) {
    const len = (c.innerText || "").length;
    if (len > bestLen) {
      best = c;
      bestLen = len;
    }
  }
  const target = best || document.body;
  if (!target) return "";
  const text = collapseWhitespace(target.innerText || "");
  return clip(text, LIM.mainText);
}

function readSelection(): string | undefined {
  const sel = window.getSelection?.();
  const t = sel ? sel.toString() : "";
  const collapsed = collapseWhitespace(t);
  if (!collapsed) return undefined;
  return clip(collapsed, LIM.selectionText);
}

// ---------------------------------------------------------------------------
// form fields
// ---------------------------------------------------------------------------

function readField(el: Element): FormField | null {
  // Only real form controls.
  if (
    !(el instanceof HTMLInputElement) &&
    !(el instanceof HTMLTextAreaElement) &&
    !(el instanceof HTMLSelectElement)
  ) {
    return null;
  }
  const type = el instanceof HTMLInputElement ? el.type : el.tagName.toLowerCase();
  // Skip cosmetic / non-data controls.
  if (type === "submit" || type === "button" || type === "reset" || type === "image") return null;
  const name = el.name || el.id || "";

  let value: string | string[] | null;
  let filename: string | undefined;

  if (type === "password") {
    // Hard exclusion. Not negotiable.
    value = null;
  } else if (type === "file" && el instanceof HTMLInputElement) {
    const files = Array.from(el.files ?? []);
    filename = files.map((f) => f.name).join(", ") || undefined;
    value = null;
  } else if (type === "checkbox" && el instanceof HTMLInputElement) {
    value = el.checked ? (el.value || "on") : "";
  } else if (type === "radio" && el instanceof HTMLInputElement) {
    if (!el.checked) return null; // only emit the selected radio
    value = el.value;
  } else if (el instanceof HTMLSelectElement && el.multiple) {
    value = Array.from(el.selectedOptions).map((o) => o.value);
  } else {
    value = clip(el.value ?? "", LIM.formFieldValue);
  }

  const label = findLabelText(el);
  return {
    name: name || undefined,
    type,
    label: label ? clip(label, LIM.formFieldLabel) : undefined,
    value: value ?? undefined,
    filename,
  };
}

function findLabelText(el: HTMLElement): string {
  // <label for="id">
  if (el.id) {
    const lab = document.querySelector(`label[for="${cssEscape(el.id)}"]`);
    if (lab) return collapseWhitespace((lab as HTMLElement).innerText || lab.textContent || "");
  }
  // wrapped <label>foo <input/></label>
  const parentLabel = el.closest("label");
  if (parentLabel) {
    return collapseWhitespace((parentLabel as HTMLElement).innerText || parentLabel.textContent || "");
  }
  // aria-label / aria-labelledby
  const aria = el.getAttribute("aria-label");
  if (aria) return collapseWhitespace(aria);
  const labelledBy = el.getAttribute("aria-labelledby");
  if (labelledBy) {
    const parts = labelledBy
      .split(/\s+/)
      .map((id) => document.getElementById(id))
      .filter((n): n is HTMLElement => !!n)
      .map((n) => n.innerText || n.textContent || "");
    if (parts.length) return collapseWhitespace(parts.join(" "));
  }
  // placeholder as last resort
  const placeholder = el.getAttribute("placeholder");
  if (placeholder) return collapseWhitespace(placeholder);
  return "";
}

function cssEscape(s: string): string {
  if (typeof CSS !== "undefined" && typeof CSS.escape === "function") return CSS.escape(s);
  return s.replace(/["\\]/g, "\\$&");
}

// ---------------------------------------------------------------------------
// utilities
// ---------------------------------------------------------------------------

function collapseWhitespace(s: string): string {
  return s.replace(/\s+/g, " ").trim();
}

function clip(s: string, max: number): string {
  if (s.length <= max) return s;
  return s.slice(0, max - 1) + "…";
}

function pruneEmpty(o: Record<string, string>): Record<string, string> | undefined {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(o)) {
    if (v) out[k] = v;
  }
  return Object.keys(out).length ? out : undefined;
}

/**
 * Cheap, fast 32-bit string hash (FNV-1a). Used as a change-detector
 * between successive SPA snapshots. Not cryptographic.
 */
function hashContext(c: PageContext): string {
  const parts = [
    c.title,
    c.canonicalUrl ?? c.url,
    c.description ?? "",
    c.headings.join("|"),
    safeStringify(c.jsonLd).slice(0, 2000),
    c.mainText.slice(0, 500),
  ];
  return fnv1a(parts.join("\u0001"));
}

function fnv1a(s: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = (h + ((h << 1) + (h << 4) + (h << 7) + (h << 8) + (h << 24))) >>> 0;
  }
  return h.toString(16).padStart(8, "0");
}
