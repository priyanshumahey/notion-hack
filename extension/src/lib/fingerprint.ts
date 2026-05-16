// DOM element → Fingerprint
//
// Goal: capture enough semantic identity that "the Save button on a LinkedIn
// job page" produces the same fingerprint regardless of which job it is, and
// keeps producing the same fingerprint after a CSS-class refactor.
//
// We DO NOT compute a CSS selector here. That belongs in a future resolver
// that runs at replay/extract time against the live DOM.

import type { Fingerprint } from "./types";
import { canonicalizeHref } from "./canonicalize";

const TEXT_MAX = 80;
const LANDMARK_ROLES = new Set([
  "main", "navigation", "banner", "contentinfo", "complementary",
  "search", "form", "region", "dialog",
]);
const DATA_ATTRS_OF_INTEREST = [
  "data-testid", "data-test", "data-test-id", "data-cy",
  "data-qa", "data-tracking-control-name", "data-control-name",
];

function trimText(s: string | null | undefined, max = TEXT_MAX): string | undefined {
  if (!s) return undefined;
  const t = s.replace(/\s+/g, " ").trim();
  return t ? t.slice(0, max) : undefined;
}

function computeRole(el: Element): string | undefined {
  const explicit = el.getAttribute("role");
  if (explicit) return explicit;
  const tag = el.tagName.toLowerCase();
  switch (tag) {
    case "a":      return (el as HTMLAnchorElement).href ? "link" : undefined;
    case "button": return "button";
    case "input": {
      const t = (el as HTMLInputElement).type.toLowerCase();
      if (t === "submit" || t === "button") return "button";
      if (t === "checkbox") return "checkbox";
      if (t === "radio")    return "radio";
      return "textbox";
    }
    case "textarea": return "textbox";
    case "select":   return "combobox";
    case "form":     return "form";
    case "nav":      return "navigation";
    case "main":     return "main";
    case "header":   return "banner";
    case "footer":   return "contentinfo";
    default: return undefined;
  }
}

function computeAccessibleName(el: Element): string | undefined {
  const aria = el.getAttribute("aria-label");
  if (aria) return trimText(aria);

  const labelledBy = el.getAttribute("aria-labelledby");
  if (labelledBy) {
    const parts = labelledBy.split(/\s+/)
      .map(id => el.ownerDocument?.getElementById(id)?.textContent ?? "")
      .filter(Boolean)
      .join(" ");
    const out = trimText(parts);
    if (out) return out;
  }

  // <input>/<textarea> → associated <label>
  if (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement || el instanceof HTMLSelectElement) {
    const labels = (el as HTMLInputElement).labels;
    if (labels && labels.length) {
      const txt = Array.from(labels).map(l => l.textContent || "").join(" ");
      const out = trimText(txt);
      if (out) return out;
    }
    const placeholder = (el as HTMLInputElement).placeholder;
    if (placeholder) return trimText(placeholder);
    const name = (el as HTMLInputElement).name;
    if (name) return trimText(name);
  }

  // <img alt>
  if (el instanceof HTMLImageElement && el.alt) return trimText(el.alt);

  // title attr
  const title = el.getAttribute("title");
  if (title) return trimText(title);

  return undefined;
}

function nearestLandmark(el: Element): string | undefined {
  let node: Element | null = el.parentElement;
  let depth = 0;
  while (node && depth < 16) {
    const role = computeRole(node);
    if (role && LANDMARK_ROLES.has(role)) return role;
    node = node.parentElement;
    depth++;
  }
  return undefined;
}

function pickDataAttrs(el: Element): Record<string, string> | undefined {
  const out: Record<string, string> = {};
  let n = 0;
  for (const k of DATA_ATTRS_OF_INTEREST) {
    const v = el.getAttribute(k);
    if (v) { out[k] = v.slice(0, 60); n++; }
    if (n >= 6) break;
  }
  return n ? out : undefined;
}

function pickTestid(el: Element): string | undefined {
  for (const k of ["data-testid", "data-test-id", "data-test", "data-cy", "data-qa"]) {
    const v = el.getAttribute(k);
    if (v) return v;
  }
  return undefined;
}

/**
 * Produce a fingerprint for an element. `null` if the element is not useful
 * to capture (e.g. text node, document body click).
 */
export function fingerprintOf(target: EventTarget | null, baseUrl: string): Fingerprint | undefined {
  if (!(target instanceof Element)) return undefined;
  // Walk up to a meaningful interactive ancestor so clicks on inner <span>s
  // resolve to the button/anchor the user intended.
  const interactive = closestInteractive(target);
  const el = interactive ?? target;

  const tag = el.tagName.toLowerCase();
  const role = computeRole(el);
  const accessibleName = computeAccessibleName(el);
  const text = trimText(el.textContent ?? undefined);
  const testid = pickTestid(el);
  const landmark = nearestLandmark(el);
  const attrs = pickDataAttrs(el);

  let hrefPattern: string | undefined;
  if (el instanceof HTMLAnchorElement && el.href) {
    hrefPattern = canonicalizeHref(el.getAttribute("href") || "", baseUrl);
  }

  return {
    tag, role, accessibleName, text, hrefPattern, testid, landmark, attrs,
  };
}

const INTERACTIVE_SELECTOR =
  "a, button, [role=button], [role=link], input, textarea, select, [role=menuitem], [role=tab], [contenteditable=true]";

function closestInteractive(el: Element): Element | null {
  // Element.closest works with our selector list.
  return el.closest(INTERACTIVE_SELECTOR);
}
