/**
 * `getTrace` — read-only agent tool.
 *
 * Returns the full Trace row and an ordered, hierarchical view of its spans
 * (parent → children). Designed so Notion AI can call it to answer questions
 * like "what happened in trace t_abc?".
 *
 * Caps output at MAX_NODES; if exceeded, returns a depth-2 skeleton with a
 * `truncated: true` flag and a hint to drill into specific spans via a
 * follow-up tool call.
 */

import { type Worker } from "@notionhq/workers";
import { j } from "@notionhq/workers/schema-builder";

// Tool returns must satisfy JSONValue (recursive { [k: string]: JSONValue }).
// We type-erase via this helper instead of sprinkling `as any` at every
// return site — keeps call-site code readable while still letting tsc check
// the rest of the function body.
type Json = null | boolean | number | string | Json[] | { [k: string]: Json };
const asJson = <T,>(v: T): Json => v as unknown as Json;

const TRACES_TITLE = "Tracer · Traces";
const SPANS_TITLE = "Tracer · Spans";
const MAX_NODES = 200;

export function registerGetTrace(worker: Worker) {
  worker.tool("getTrace", {
    title: "Get Trace",
    description:
      "Fetch a single trace and its full span tree from the Tracer database. Use this when the user references a specific trace ID and you need to inspect what happened (e.g. 'why did trace t_abc fail?', 'show me the steps in trace ...'). Returns the trace summary and an ordered tree of spans with kind, status, duration, and attributes.",
    hints: { readOnlyHint: true },
    schema: j.object({
      traceId: j
        .string()
        .describe(
          "The trace identifier (e.g. 't_abc123' or a 32-char hex string). Required.",
        ),
      includeAttributes: j
        .boolean()
        .describe(
          "If true, include each span's attributes JSON in the response. Default false to keep responses small.",
        )
        .nullable(),
    }),
    execute: async ({ traceId, includeAttributes }, { notion }) => {
      const tracesDbId = await resolveDbId(notion, TRACES_TITLE, "TRACES_DB_ID");
      const spansDbId = await resolveDbId(notion, SPANS_TITLE, "SPANS_DB_ID");
      if (!tracesDbId || !spansDbId) {
        return asJson({
          ok: false,
          error:
            "Tracer databases not found. Has the worker been deployed and granted access?",
        });
      }

      const traceRow = await fetchTraceRow(notion, tracesDbId, traceId);
      if (!traceRow) {
        return asJson({
          ok: false,
          error: `No trace found with Trace ID = ${traceId}.`,
        });
      }

      const spans = await fetchSpansForTrace(notion, spansDbId, traceId);
      const tree = buildTree(spans, Boolean(includeAttributes));

      const truncated = spans.length > MAX_NODES;
      return asJson({
        ok: true,
        trace: traceRow,
        spans: truncated
          ? skeleton(tree, 2)
          : tree,
        spanCount: spans.length,
        truncated,
        ...(truncated && {
          hint: `Trace has ${spans.length} spans which exceeds the ${MAX_NODES}-node cap. The response is a depth-2 skeleton; call getTrace again with a more specific filter (e.g. only error spans) or query the Spans database directly.`,
        }),
      });
    },
  });
}

/* ------------------------------ Read helpers ------------------------------ */

interface TraceSummary {
  traceId: string;
  name: string;
  rootSpanName: string;
  status: string;
  startedAt: string | null;
  endedAt: string | null;
  durationMs: number | null;
  spanCount: number | null;
  errorCount: number | null;
  service: string | null;
  sessionId: string | null;
  pageUrl: string | null;
}

async function fetchTraceRow(
  notion: any,
  tracesDbId: string,
  traceId: string,
): Promise<TraceSummary | null> {
  const res = await notion.databases.query({
    database_id: tracesDbId,
    filter: { property: "Trace ID", rich_text: { equals: traceId } },
    page_size: 1,
  });
  const page = res.results[0];
  if (!page) return null;
  const p = page.properties;
  return {
    traceId,
    name: plainText(p.Name) ?? "",
    rootSpanName: plainText(p["Root Span Name"]) ?? "",
    status: selectName(p.Status) ?? "unset",
    startedAt: dateStart(p["Started At"]),
    endedAt: dateStart(p["Ended At"]),
    durationMs: numberOf(p["Duration (ms)"]),
    spanCount: numberOf(p["Span Count"]),
    errorCount: numberOf(p["Error Count"]),
    service: plainText(p.Service),
    sessionId: plainText(p["Session ID"]),
    pageUrl: page.url ?? null,
  };
}

interface SpanRow {
  spanId: string;
  parentSpanId: string | null;
  name: string;
  kind: string;
  status: string;
  startedAt: string | null;
  endedAt: string | null;
  durationMs: number | null;
  errorMessage: string | null;
  attributes?: unknown;
  events?: unknown;
}

async function fetchSpansForTrace(
  notion: any,
  spansDbId: string,
  traceId: string,
): Promise<SpanRow[]> {
  const rows: SpanRow[] = [];
  let cursor: string | undefined;
  do {
    const res: any = await notion.databases.query({
      database_id: spansDbId,
      filter: { property: "Trace ID", rich_text: { equals: traceId } },
      sorts: [{ property: "Started At", direction: "ascending" }],
      start_cursor: cursor,
      page_size: 100,
    });
    for (const page of res.results) {
      const p = page.properties;
      const spanId = plainText(p["Span ID"]);
      if (!spanId) continue;
      rows.push({
        spanId,
        parentSpanId: plainText(p["Parent Span ID"]) || null,
        name: plainText(p.Name) ?? "",
        kind: selectName(p.Kind) ?? "other",
        status: selectName(p.Status) ?? "unset",
        startedAt: dateStart(p["Started At"]),
        endedAt: dateStart(p["Ended At"]),
        durationMs: numberOf(p["Duration (ms)"]),
        errorMessage: plainText(p["Error Message"]),
        attributes: parseJson(plainText(p.Attributes)),
        events: parseJson(plainText(p.Events)),
      });
    }
    cursor = res.has_more ? res.next_cursor : undefined;
  } while (cursor);
  return rows;
}

/* ------------------------------- Tree build ------------------------------- */

interface TreeNode {
  spanId: string;
  name: string;
  kind: string;
  status: string;
  startedAt: string | null;
  durationMs: number | null;
  errorMessage?: string | null;
  attributes?: unknown;
  children: TreeNode[];
}

function buildTree(spans: SpanRow[], includeAttributes: boolean): TreeNode[] {
  const byId = new Map<string, TreeNode>();
  for (const s of spans) {
    byId.set(s.spanId, {
      spanId: s.spanId,
      name: s.name,
      kind: s.kind,
      status: s.status,
      startedAt: s.startedAt,
      durationMs: s.durationMs,
      ...(s.errorMessage ? { errorMessage: s.errorMessage } : {}),
      ...(includeAttributes ? { attributes: s.attributes } : {}),
      children: [],
    });
  }
  const roots: TreeNode[] = [];
  for (const s of spans) {
    const node = byId.get(s.spanId)!;
    if (s.parentSpanId && byId.has(s.parentSpanId)) {
      byId.get(s.parentSpanId)!.children.push(node);
    } else {
      roots.push(node);
    }
  }
  return roots;
}

function skeleton(nodes: TreeNode[], depth: number): TreeNode[] {
  if (depth <= 0) {
    return nodes.map((n) => ({ ...n, children: [] }));
  }
  return nodes.map((n) => ({
    ...n,
    children: skeleton(n.children, depth - 1),
  }));
}

/* ------------------------------ DB resolution ----------------------------- */

async function resolveDbId(
  notion: any,
  title: string,
  envVar: string,
): Promise<string | null> {
  const fromEnv = process.env[envVar];
  if (fromEnv) return fromEnv;
  try {
    const res = await notion.search({
      query: title,
      filter: { property: "object", value: "database" },
      page_size: 5,
    });
    const hit = res.results.find(
      (r: any) => (r?.title?.[0]?.plain_text ?? "").trim() === title,
    );
    return hit?.id ?? null;
  } catch {
    return null;
  }
}

/* ----------------------------- Property accessors ------------------------- */

function plainText(prop: any): string | null {
  if (!prop) return null;
  const rt = prop.rich_text ?? prop.title;
  if (!Array.isArray(rt) || rt.length === 0) return null;
  return rt.map((t: any) => t.plain_text ?? t.text?.content ?? "").join("");
}

function numberOf(prop: any): number | null {
  return typeof prop?.number === "number" ? prop.number : null;
}

function selectName(prop: any): string | null {
  return prop?.select?.name ?? null;
}

function dateStart(prop: any): string | null {
  return prop?.date?.start ?? null;
}

function parseJson(s: string | null): unknown {
  if (!s) return null;
  try {
    return JSON.parse(s);
  } catch {
    return s;
  }
}
