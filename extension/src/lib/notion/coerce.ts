// Validate + coerce a proposal's row cells against a database schema.
//
// Pure functions. No I/O. The output is what we hand to the gateway.
//
// Coercion rules per type:
//   title / rich_text  : toString, trim to 2000 chars
//   url                : require http(s), trim to 2000 chars
//   date               : pass through ISO or parse via new Date()
//   number             : Number(x), reject NaN
//   select             : case-insensitive match to schema options; else new option
//   multi_select       : array or comma-split; same option matching
//
// Anything that fails coercion is collected in `dropped` so the UI can show
// it. New select/multi_select options the schema doesn't yet know about are
// collected in `newOptions` (real Notion needs a separate PATCH to add them;
// mock auto-accepts).

import type { NotionPropertySpec, NotionRowCell } from "../types";
import type { NotionPropertyValue } from "./types";

const TEXT_MAX = 2000;
const URL_MAX = 2000;

export interface CoerceResult {
  values: Record<string, NotionPropertyValue>;
  dropped: { property: string; reason: string }[];
  newOptions: { property: string; options: string[] }[];
}

export function coerceRow(
  row: NotionRowCell[],
  schema: NotionPropertySpec[],
): CoerceResult {
  const byName = new Map(schema.map((p) => [p.name, p]));
  const values: Record<string, NotionPropertyValue> = {};
  const dropped: { property: string; reason: string }[] = [];
  const newOptionsByProp = new Map<string, Set<string>>();

  for (const cell of row) {
    const spec = byName.get(cell.property);
    if (!spec) {
      dropped.push({ property: cell.property, reason: "no such property in schema" });
      continue;
    }
    const result = coerceOne(spec, cell.value);
    if ("error" in result) {
      dropped.push({ property: cell.property, reason: result.error });
      continue;
    }
    values[spec.name] = result.value;
    if (result.newOptions?.length) {
      let set = newOptionsByProp.get(spec.name);
      if (!set) {
        set = new Set();
        newOptionsByProp.set(spec.name, set);
      }
      for (const o of result.newOptions) set.add(o);
    }
  }

  // The title property is required; synthesize "(untitled)" if missing so
  // pages always have a visible name.
  const titleProp = schema.find((p) => p.type === "title");
  if (titleProp && !values[titleProp.name]) {
    values[titleProp.name] = { type: "title", value: "(untitled)" };
  }

  return {
    values,
    dropped,
    newOptions: Array.from(newOptionsByProp.entries()).map(([property, set]) => ({
      property,
      options: Array.from(set),
    })),
  };
}

type OneResult =
  | { value: NotionPropertyValue; newOptions?: string[] }
  | { error: string };

function coerceOne(spec: NotionPropertySpec, raw: unknown): OneResult {
  switch (spec.type) {
    case "title":
    case "rich_text": {
      const s = toStringValue(raw);
      if (s === null) return { error: "expected string" };
      return { value: { type: spec.type, value: s.slice(0, TEXT_MAX) } };
    }
    case "url": {
      const s = toStringValue(raw);
      if (!s) return { error: "expected url string" };
      if (!/^https?:\/\//i.test(s)) return { error: "url must be http(s)" };
      return { value: { type: "url", value: s.slice(0, URL_MAX) } };
    }
    case "date": {
      const s = toStringValue(raw);
      if (!s) return { error: "expected date string" };
      const iso = coerceIso(s);
      if (!iso) return { error: `unparseable date: ${s}` };
      return { value: { type: "date", value: iso } };
    }
    case "number": {
      const n = typeof raw === "number" ? raw : Number(raw);
      if (!Number.isFinite(n)) return { error: "not a number" };
      return { value: { type: "number", value: n } };
    }
    case "select": {
      const s = toStringValue(raw);
      if (!s) return { error: "expected select string" };
      const known = spec.options.find((o) => o.toLowerCase() === s.toLowerCase());
      return {
        value: { type: "select", value: known ?? s },
        newOptions: known ? undefined : [s],
      };
    }
    case "multi_select": {
      const arr = toStringArray(raw);
      if (!arr) return { error: "expected array or comma-separated string" };
      const resolved = arr.map((s) => {
        const known = spec.options.find((o) => o.toLowerCase() === s.toLowerCase());
        return known ?? s;
      });
      const newOptions = resolved.filter(
        (o) => !spec.options.some((k) => k.toLowerCase() === o.toLowerCase()),
      );
      return { value: { type: "multi_select", value: resolved }, newOptions };
    }
  }
}

function toStringValue(raw: unknown): string | null {
  if (typeof raw === "string") return raw;
  if (typeof raw === "number") return String(raw);
  if (Array.isArray(raw)) return raw.map((x) => String(x)).join(", ");
  if (raw == null) return null;
  return null;
}

function toStringArray(raw: unknown): string[] | null {
  if (Array.isArray(raw)) {
    return raw.map((v) => (typeof v === "string" ? v : String(v))).filter(Boolean);
  }
  if (typeof raw === "string") {
    return raw.split(",").map((s) => s.trim()).filter(Boolean);
  }
  return null;
}

function coerceIso(s: string): string | null {
  // Common YYYY-MM-DD path
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) {
    const d = new Date(s + "T00:00:00Z");
    if (!isNaN(d.getTime())) return d.toISOString();
  }
  const d = new Date(s);
  if (!isNaN(d.getTime())) return d.toISOString();
  return null;
}
