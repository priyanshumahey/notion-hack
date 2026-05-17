/**
 * Notion helpers scoped to the workflow runtime databases (Sandboxes,
 * Functions, Function Runs). Wraps `notion.search` + `notion.databases.query`
 * with simple in-memory caches so each tick of the stepper doesn't have to
 * re-discover database IDs.
 *
 * Mirrors the cache pattern in `ingest/upsert.ts` but lives in its own
 * namespace so a one-off invalidation in tests doesn't clobber the trace
 * cache.
 */

import type { Client as NotionClient } from "@notionhq/client";

export type RuntimeDb = "sandboxes" | "functions" | "functionRuns" | "wakes" | "events";

const TITLES: Record<RuntimeDb, string> = {
  sandboxes: "Functions · Sandboxes",
  functions: "Functions · Catalog",
  functionRuns: "Functions · Runs",
  wakes: "Functions · Wakes",
  events: "Tracer · Events",
};

const ENV_VARS: Record<RuntimeDb, string> = {
  sandboxes: "SANDBOXES_DB_ID",
  functions: "FUNCTIONS_DB_ID",
  functionRuns: "FUNCTION_RUNS_DB_ID",
  wakes: "WAKES_DB_ID",
  events: "EVENTS_DB_ID",
};

const cache: Partial<Record<RuntimeDb, string>> = {};

export async function resolveRuntimeDbId(
  notion: NotionClient,
  key: RuntimeDb,
): Promise<string | null> {
  const envVal = process.env[ENV_VARS[key]];
  if (envVal) return envVal;
  if (cache[key]) return cache[key]!;

  const res = await notion.search({
    query: TITLES[key],
    filter: { property: "object", value: "database" },
  });
  for (const r of res.results) {
    if (
      r.object === "database" &&
      "title" in r &&
      Array.isArray((r as { title: unknown[] }).title)
    ) {
      const title = (r as { title: Array<{ plain_text?: string }> }).title
        .map((t) => t.plain_text ?? "")
        .join("");
      if (title === TITLES[key]) {
        cache[key] = r.id;
        return r.id;
      }
    }
  }
  return null;
}

/** Extract a rich_text plain string from a Notion page property bag. */
export function getRichText(
  props: Record<string, unknown>,
  name: string,
): string {
  const p = props[name] as
    | { type: "rich_text"; rich_text: Array<{ plain_text?: string }> }
    | undefined;
  if (!p || p.type !== "rich_text") return "";
  return (p.rich_text ?? []).map((t) => t.plain_text ?? "").join("");
}

export function getTitle(
  props: Record<string, unknown>,
  name: string,
): string {
  const p = props[name] as
    | { type: "title"; title: Array<{ plain_text?: string }> }
    | undefined;
  if (!p || p.type !== "title") return "";
  return (p.title ?? []).map((t) => t.plain_text ?? "").join("");
}

export function getSelect(
  props: Record<string, unknown>,
  name: string,
): string | null {
  const p = props[name] as
    | { type: "select"; select: { name: string } | null }
    | undefined;
  if (!p || p.type !== "select") return null;
  return p.select?.name ?? null;
}

export function getNumber(
  props: Record<string, unknown>,
  name: string,
): number | null {
  const p = props[name] as
    | { type: "number"; number: number | null }
    | undefined;
  if (!p || p.type !== "number") return null;
  return p.number;
}

export function getRelation(
  props: Record<string, unknown>,
  name: string,
): string[] {
  const p = props[name] as
    | { type: "relation"; relation: Array<{ id: string }> }
    | undefined;
  if (!p || p.type !== "relation") return [];
  return (p.relation ?? []).map((r) => r.id);
}

/** Find one row in a runtime DB by its rich_text primary key. */
export async function findRowByPK(
  notion: NotionClient,
  dbId: string,
  pkProperty: string,
  pkValue: string,
): Promise<
  | { pageId: string; properties: Record<string, unknown> }
  | null
> {
  const res = await notion.databases.query({
    database_id: dbId,
    filter: { property: pkProperty, rich_text: { equals: pkValue } },
    page_size: 1,
  });
  const r = res.results[0];
  if (!r || !("properties" in r)) return null;
  return {
    pageId: r.id,
    properties: (r as { properties: Record<string, unknown> }).properties,
  };
}

/** Truncate to fit Notion rich_text safety cap. */
export function truncate(s: string, max = 1800): string {
  if (s.length <= max) return s;
  return s.slice(0, max - 12) + "…[truncated]";
}

export function safeStringify(v: unknown): string {
  try {
    return JSON.stringify(v);
  } catch {
    return String(v);
  }
}

/** Cheap random hex of given byte length. */
export function randHex(bytes: number): string {
  const arr = new Uint8Array(bytes);
  // Use globalThis.crypto so we don't introduce a Node-only import here.
  globalThis.crypto.getRandomValues(arr);
  let out = "";
  for (const b of arr) out += b.toString(16).padStart(2, "0");
  return out;
}
