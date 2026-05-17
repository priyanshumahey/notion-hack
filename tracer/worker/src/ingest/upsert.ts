/**
 * Span → Notion upsert with Phase 1 projections.
 *
 * Pipeline per batch:
 *   1. Resolve all 6 database IDs (env vars, then title search fallback).
 *   2. Upsert the Session row (if present) so the trace can relate to it.
 *   3. Group spans by trace; for each trace:
 *      a. Compute trace-level aggregates (counts, tokens, cost).
 *      b. Upsert the Trace row.
 *      c. For each span:
 *         - Upsert the raw Span row.
 *         - If kind=llm, also project to LLM Calls.
 *         - If kind=tool, also project to Tool Calls.
 *         - If status=error, emit an Events row (Type=error).
 *         - If LLM and pricing unknown, emit an Events row (Type=note).
 *
 * Idempotency: every projection uses a stable primary key (Span ID for the
 * projection DBs, deterministic Event ID for events) so re-POSTing a batch
 * never duplicates rows.
 *
 * Database IDs: resolved from env vars (`TRACES_DB_ID`, `SPANS_DB_ID`,
 * `SESSIONS_DB_ID`, `LLM_CALLS_DB_ID`, `TOOL_CALLS_DB_ID`, `EVENTS_DB_ID`).
 * When unset, falls back to a one-time `notion.search` by initialTitle and
 * caches the result in-module.
 */

import type { Client as NotionClient } from "@notionhq/client";
import type { IngestBatch, SessionInfo, Span } from "../types.js";
import { costFor, normalizeProvider, type Provider } from "../pricing.js";

const DB_TITLES = {
  sessions: "Tracer · Sessions",
  traces: "Tracer · Traces",
  spans: "Tracer · Spans",
  llmCalls: "Tracer · LLM Calls",
  toolCalls: "Tracer · Tool Calls",
  events: "Tracer · Events",
} as const;

const ENV_VARS = {
  sessions: "SESSIONS_DB_ID",
  traces: "TRACES_DB_ID",
  spans: "SPANS_DB_ID",
  llmCalls: "LLM_CALLS_DB_ID",
  toolCalls: "TOOL_CALLS_DB_ID",
  events: "EVENTS_DB_ID",
} as const;

type DbKey = keyof typeof DB_TITLES;

// Notion rich_text plaintext per fragment has a 2000-char cap. We aim well
// under for safety + readable previews; bigger payloads should land in an
// attachment file later (Phase 2 follow-up).
const MAX_TEXT = 1800;

// Module-level cache: avoid the notion.search round-trip on every batch.
const dbIdCache: Partial<Record<DbKey, string>> = {};

export interface UpsertResult {
  tracesTouched: number;
  spansTouched: number;
  spansCreated: number;
  spansUpdated: number;
  llmCallsTouched: number;
  toolCallsTouched: number;
  eventsTouched: number;
  sessionsTouched: number;
}

export async function upsertBatch(
  notion: NotionClient,
  batch: IngestBatch,
): Promise<UpsertResult> {
  const empty: UpsertResult = {
    tracesTouched: 0,
    spansTouched: 0,
    spansCreated: 0,
    spansUpdated: 0,
    llmCallsTouched: 0,
    toolCallsTouched: 0,
    eventsTouched: 0,
    sessionsTouched: 0,
  };
  if (batch.spans.length === 0) return empty;

  const dbIds = await resolveAllDbIds(notion);
  // Sessions / projections are optional in the sense that ingest still works
  // if a DB hasn't been provisioned yet; we skip those writes with a warning
  // instead of failing the whole batch. Traces + Spans are required.
  if (!dbIds.traces || !dbIds.spans) {
    throw new Error(
      "Tracer Traces/Spans databases not found. Has `ntn workers deploy` run? " +
        "If yes, set TRACES_DB_ID and SPANS_DB_ID env vars.",
    );
  }

  const result = { ...empty };

  // 1. Session upsert (one per batch).
  let sessionPageId: string | null = null;
  if (batch.session && dbIds.sessions) {
    sessionPageId = await upsertSessionRow(
      notion,
      dbIds.sessions,
      batch.session,
      batch.spans,
    );
    result.sessionsTouched = 1;
  }

  // 2. Group spans by trace.
  const byTrace = new Map<string, Span[]>();
  for (const s of batch.spans) {
    const list = byTrace.get(s.traceId) ?? [];
    list.push(s);
    byTrace.set(s.traceId, list);
  }

  for (const [traceId, spans] of byTrace) {
    // 3a. Aggregates including LLM-derived cost/tokens.
    const metrics = aggregateTrace(spans);

    // 3b. Upsert Trace row.
    const tracePageId = await upsertTraceRow({
      notion,
      tracesDbId: dbIds.traces,
      traceId,
      spans,
      batch,
      metrics,
      sessionPageId,
    });
    result.tracesTouched++;

    // 3c. Per-span writes.
    for (const span of spans) {
      const action = await upsertSpanRow(notion, dbIds.spans, span, tracePageId);
      if (action === "created") result.spansCreated++;
      else result.spansUpdated++;
      result.spansTouched++;

      // Projections (best-effort; skip if the DB hasn't been provisioned).
      if (span.kind === "llm" && dbIds.llmCalls) {
        const { unknownPricing } = await upsertLLMCallRow(
          notion,
          dbIds.llmCalls,
          span,
          tracePageId,
        );
        result.llmCallsTouched++;
        if (unknownPricing && dbIds.events) {
          await upsertEventRow(
            notion,
            dbIds.events,
            pricingUnknownEvent(span),
            tracePageId,
          );
          result.eventsTouched++;
        }
      } else if (span.kind === "tool" && dbIds.toolCalls) {
        await upsertToolCallRow(notion, dbIds.toolCalls, span, tracePageId);
        result.toolCallsTouched++;
      }

      if (span.status === "error" && dbIds.events) {
        await upsertEventRow(notion, dbIds.events, errorSpanEvent(span), tracePageId);
        result.eventsTouched++;
      }
    }
  }

  return result;
}

/* =========================================================================
 * Database resolution
 * ========================================================================= */

async function resolveAllDbIds(
  notion: NotionClient,
): Promise<Partial<Record<DbKey, string>>> {
  const keys: DbKey[] = [
    "sessions",
    "traces",
    "spans",
    "llmCalls",
    "toolCalls",
    "events",
  ];
  const out: Partial<Record<DbKey, string>> = {};
  for (const k of keys) {
    const cached = dbIdCache[k];
    if (cached) {
      out[k] = cached;
      continue;
    }
    const envVal = process.env[ENV_VARS[k]];
    if (envVal) {
      dbIdCache[k] = envVal;
      out[k] = envVal;
      continue;
    }
    const found = await discoverDbByTitle(notion, DB_TITLES[k]);
    if (found) {
      dbIdCache[k] = found;
      out[k] = found;
    }
  }
  return out;
}

async function discoverDbByTitle(
  notion: NotionClient,
  title: string,
): Promise<string | null> {
  try {
    const res = (await notion.search({
      query: title,
      filter: { property: "object", value: "database" },
      page_size: 10,
    })) as { results: Array<{ id: string; title?: Array<{ plain_text?: string }> }> };
    // Notion stores titles with special characters (e.g. the middle-dot in
    // "Tracer · Traces") as multiple rich_text fragments. Join them all
    // before comparing or we'd only ever match the first fragment.
    const hit = res.results.find(
      (r) =>
        (r.title ?? [])
          .map((t) => t.plain_text ?? "")
          .join("")
          .trim() === title,
    );
    return hit?.id ?? null;
  } catch {
    return null;
  }
}

/* =========================================================================
 * Session
 * ========================================================================= */

async function upsertSessionRow(
  notion: NotionClient,
  sessionsDbId: string,
  session: SessionInfo,
  spans: Span[],
): Promise<string> {
  const existing = await findByRichText(notion, sessionsDbId, "Session ID", session.id);

  // Started At: earliest span time in this batch (only used on create).
  // Last Seen At: latest end time in this batch.
  let earliest = spans[0]!.startedAt;
  let latest = spans[0]!.endedAt;
  for (const s of spans) {
    if (s.startedAt < earliest) earliest = s.startedAt;
    if (s.endedAt > latest) latest = s.endedAt;
  }

  const baseProps: Record<string, unknown> = {
    Name: titleProp(
      session.userId ? `${session.userId} · ${shortId(session.id)}` : session.id,
    ),
    "Session ID": richTextProp(session.id),
    "User ID": session.userId ? richTextProp(session.userId) : { rich_text: [] },
    "Last Seen At": dateProp(latest),
  };

  if (existing) {
    await notion.pages.update({
      page_id: existing,
      properties: baseProps as never,
    });
    return existing;
  }

  const created = (await notion.pages.create({
    parent: { database_id: sessionsDbId },
    properties: {
      ...baseProps,
      "Started At": dateProp(earliest),
    } as never,
  })) as { id: string };
  return created.id;
}

/* =========================================================================
 * Trace
 * ========================================================================= */

export interface TraceMetrics {
  spanCount: number;
  errorCount: number;
  startedAt: string;
  endedAt: string;
  durationMs: number;
  totalTokens: number;
  costUsd: number;
}

export function aggregateTrace(spans: Span[]): TraceMetrics {
  let startedAt = spans[0]!.startedAt;
  let endedAt = spans[0]!.endedAt;
  let errorCount = 0;
  let totalTokens = 0;
  let costUsd = 0;
  for (const s of spans) {
    if (s.startedAt < startedAt) startedAt = s.startedAt;
    if (s.endedAt > endedAt) endedAt = s.endedAt;
    if (s.status === "error") errorCount++;
    if (s.kind === "llm") {
      const llm = extractLLM(s);
      totalTokens += llm.totalTokens;
      costUsd += llm.cost.usd;
    }
  }
  return {
    spanCount: spans.length,
    errorCount,
    startedAt,
    endedAt,
    durationMs: new Date(endedAt).getTime() - new Date(startedAt).getTime(),
    totalTokens,
    costUsd: round8(costUsd),
  };
}

async function upsertTraceRow(args: {
  notion: NotionClient;
  tracesDbId: string;
  traceId: string;
  spans: Span[];
  batch: IngestBatch;
  metrics: TraceMetrics;
  sessionPageId: string | null;
}): Promise<string> {
  const { notion, tracesDbId, traceId, spans, batch, metrics, sessionPageId } = args;

  const existingPageId = await findByRichText(notion, tracesDbId, "Trace ID", traceId);
  const root = spans.find((s) => s.parentSpanId === null) ?? spans[0]!;

  const properties: Record<string, unknown> = {
    Name: titleProp(`${root.name} · ${shortId(traceId)}`),
    "Trace ID": richTextProp(traceId),
    "Root Span Name": richTextProp(root.name),
    Status: selectProp(metrics.errorCount > 0 ? "error" : "ok"),
    "Started At": dateProp(metrics.startedAt),
    "Ended At": dateProp(metrics.endedAt),
    "Duration (ms)": numberProp(metrics.durationMs),
    "Span Count": numberProp(metrics.spanCount),
    "Error Count": numberProp(metrics.errorCount),
    "Total Tokens": numberProp(metrics.totalTokens),
    "Cost (USD)": numberProp(metrics.costUsd),
    Service: richTextProp(batch.service),
    "Session ID": batch.session?.id
      ? richTextProp(batch.session.id)
      : { rich_text: [] },
    Session: sessionPageId
      ? { relation: [{ id: sessionPageId }] }
      : { relation: [] },
  };

  // Tags: only set if the batch session supplies tags. Notion creates new
  // multi-select options on the fly from `name` strings, so unseeded tags
  // are fine — they just appear with the default color.
  const tags = batch.session?.tags ?? [];
  if (tags.length > 0) {
    properties.Tags = {
      multi_select: tags.slice(0, 25).map((t) => ({ name: t })),
    };
  }

  if (existingPageId) {
    await notion.pages.update({
      page_id: existingPageId,
      properties: properties as never,
    });
    return existingPageId;
  }

  const created = (await notion.pages.create({
    parent: { database_id: tracesDbId },
    properties: properties as never,
  })) as { id: string };
  return created.id;
}

/* =========================================================================
 * Span
 * ========================================================================= */

async function upsertSpanRow(
  notion: NotionClient,
  spansDbId: string,
  span: Span,
  tracePageId: string,
): Promise<"created" | "updated"> {
  const existing = await findByRichText(notion, spansDbId, "Span ID", span.spanId);
  const properties = spanProperties(span, tracePageId) as never;
  if (existing) {
    await notion.pages.update({ page_id: existing, properties });
    return "updated";
  }
  await notion.pages.create({
    parent: { database_id: spansDbId },
    properties,
  });
  return "created";
}

function spanProperties(span: Span, tracePageId: string): Record<string, unknown> {
  return {
    Name: titleProp(`${span.name} · ${shortId(span.spanId)}`),
    "Span ID": richTextProp(span.spanId),
    "Trace ID": richTextProp(span.traceId),
    Trace: { relation: [{ id: tracePageId }] },
    "Parent Span ID": span.parentSpanId
      ? richTextProp(span.parentSpanId)
      : { rich_text: [] },
    Kind: selectProp(span.kind),
    Status: selectProp(span.status),
    "Started At": dateProp(span.startedAt),
    "Ended At": dateProp(span.endedAt),
    "Duration (ms)": numberProp(span.durationMs),
    Attributes: richTextProp(truncate(safeStringify(span.attributes))),
    Events: richTextProp(truncate(safeStringify(span.events))),
    "Error Message": span.errorMessage
      ? richTextProp(truncate(span.errorMessage))
      : { rich_text: [] },
  };
}

/* =========================================================================
 * LLM Call projection
 * ========================================================================= */

export interface LLMExtraction {
  provider: Provider;
  model: string;
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  prompt: string;
  completion: string;
  cost: ReturnType<typeof costFor>;
}

export function extractLLM(span: Span): LLMExtraction {
  const a = span.attributes;
  const providerHint = normalizeProvider(a["gen_ai.system"]);
  const model = String(
    a["gen_ai.request.model"] ?? a["gen_ai.response.model"] ?? "",
  );
  const promptTokens = numAttr(
    a["gen_ai.usage.prompt_tokens"] ?? a["gen_ai.usage.input_tokens"],
  );
  const completionTokens = numAttr(
    a["gen_ai.usage.completion_tokens"] ?? a["gen_ai.usage.output_tokens"],
  );
  const prompt = stringAttr(a["gen_ai.prompt"]);
  const completion = stringAttr(a["gen_ai.completion"]);
  const cost = costFor(model, promptTokens, completionTokens, providerHint);
  return {
    provider: cost.provider,
    model,
    promptTokens,
    completionTokens,
    totalTokens: promptTokens + completionTokens,
    prompt,
    completion,
    cost,
  };
}

async function upsertLLMCallRow(
  notion: NotionClient,
  llmCallsDbId: string,
  span: Span,
  tracePageId: string,
): Promise<{ unknownPricing: boolean }> {
  const llm = extractLLM(span);
  const existing = await findByRichText(notion, llmCallsDbId, "Span ID", span.spanId);

  const properties: Record<string, unknown> = {
    Name: titleProp(`${llm.model || "llm"} · ${shortId(span.spanId)}`),
    "Span ID": richTextProp(span.spanId),
    "Trace ID": richTextProp(span.traceId),
    Trace: { relation: [{ id: tracePageId }] },
    Provider: selectProp(llm.provider),
    Model: llm.model ? richTextProp(llm.model) : { rich_text: [] },
    "Prompt Tokens": numberProp(llm.promptTokens),
    "Completion Tokens": numberProp(llm.completionTokens),
    "Total Tokens": numberProp(llm.totalTokens),
    "Cost (USD)": numberProp(llm.cost.usd),
    "Latency (ms)": numberProp(span.durationMs),
    Prompt: llm.prompt ? richTextProp(truncate(llm.prompt)) : { rich_text: [] },
    Completion: llm.completion
      ? richTextProp(truncate(llm.completion))
      : { rich_text: [] },
    Status: selectProp(span.status === "error" ? "error" : "ok"),
  };

  if (existing) {
    await notion.pages.update({
      page_id: existing,
      properties: properties as never,
    });
  } else {
    await notion.pages.create({
      parent: { database_id: llmCallsDbId },
      properties: properties as never,
    });
  }

  // Only flag unknown pricing when a model was actually claimed. A span with
  // no `gen_ai.request.model` attribute is probably a custom/local model and
  // we shouldn't spam events for it.
  return { unknownPricing: Boolean(llm.model) && !llm.cost.known };
}

/* =========================================================================
 * Tool Call projection
 * ========================================================================= */

async function upsertToolCallRow(
  notion: NotionClient,
  toolCallsDbId: string,
  span: Span,
  tracePageId: string,
): Promise<void> {
  const a = span.attributes;
  const toolName = stringAttr(a["tool.name"]) || span.name;
  const args = stringAttr(
    a["tool.args"] ?? a["tool.arguments"] ?? a["function.arguments"],
  );
  const result = stringAttr(a["tool.result"] ?? a["function.result"]);

  const existing = await findByRichText(notion, toolCallsDbId, "Span ID", span.spanId);

  const properties: Record<string, unknown> = {
    Name: titleProp(`${toolName} · ${shortId(span.spanId)}`),
    "Span ID": richTextProp(span.spanId),
    "Trace ID": richTextProp(span.traceId),
    Trace: { relation: [{ id: tracePageId }] },
    "Tool Name": richTextProp(toolName),
    Args: args ? richTextProp(truncate(args)) : { rich_text: [] },
    Result: result ? richTextProp(truncate(result)) : { rich_text: [] },
    Status: selectProp(span.status === "error" ? "error" : "ok"),
    "Latency (ms)": numberProp(span.durationMs),
  };

  if (existing) {
    await notion.pages.update({
      page_id: existing,
      properties: properties as never,
    });
  } else {
    await notion.pages.create({
      parent: { database_id: toolCallsDbId },
      properties: properties as never,
    });
  }
}

/* =========================================================================
 * Events
 * ========================================================================= */

interface EventInput {
  eventId: string;
  spanId: string;
  traceId: string;
  type: "error" | "feedback" | "signal" | "note";
  severity: "info" | "warn" | "error";
  category: string;
  summary: string;
  detail: string;
  at: string;
}

function errorSpanEvent(span: Span): EventInput {
  return {
    eventId: `e_err_${span.spanId}`,
    spanId: span.spanId,
    traceId: span.traceId,
    type: "error",
    severity: "error",
    // Category is filled by the Phase 3 errorClassifier sync; leave blank.
    category: "",
    summary: truncate(span.errorMessage ?? span.name),
    detail: truncate(
      safeStringify({ attributes: span.attributes, events: span.events }),
    ),
    at: span.endedAt,
  };
}

function pricingUnknownEvent(span: Span): EventInput {
  const model = String(span.attributes["gen_ai.request.model"] ?? "unknown");
  return {
    eventId: `e_pricing_${span.spanId}`,
    spanId: span.spanId,
    traceId: span.traceId,
    type: "note",
    severity: "warn",
    category: "pricing.unknown",
    summary: `Unknown LLM pricing for model "${model}". Cost reported as 0.`,
    detail: `Add a price entry to worker/src/pricing.ts to track cost for "${model}".`,
    at: span.endedAt,
  };
}

async function upsertEventRow(
  notion: NotionClient,
  eventsDbId: string,
  event: EventInput,
  tracePageId: string,
): Promise<void> {
  const existing = await findByRichText(notion, eventsDbId, "Event ID", event.eventId);

  const properties: Record<string, unknown> = {
    Name: titleProp(`${event.type} · ${shortId(event.eventId)}`),
    "Event ID": richTextProp(event.eventId),
    "Trace ID": richTextProp(event.traceId),
    Trace: { relation: [{ id: tracePageId }] },
    "Span ID": richTextProp(event.spanId),
    Type: selectProp(event.type),
    Severity: selectProp(event.severity),
    Category: event.category ? richTextProp(event.category) : { rich_text: [] },
    Summary: richTextProp(event.summary),
    Detail: event.detail ? richTextProp(event.detail) : { rich_text: [] },
    At: dateProp(event.at),
  };

  if (existing) {
    await notion.pages.update({
      page_id: existing,
      properties: properties as never,
    });
  } else {
    await notion.pages.create({
      parent: { database_id: eventsDbId },
      properties: properties as never,
    });
  }
}

/* =========================================================================
 * Query helpers
 * ========================================================================= */

async function findByRichText(
  notion: NotionClient,
  databaseId: string,
  property: string,
  value: string,
): Promise<string | null> {
  const res = (await notion.databases.query({
    database_id: databaseId,
    filter: { property, rich_text: { equals: value } },
    page_size: 1,
  })) as { results: Array<{ id: string }> };
  return res.results[0]?.id ?? null;
}

/* =========================================================================
 * Property builders + small utilities
 * ========================================================================= */

function titleProp(text: string) {
  return { title: [{ text: { content: truncate(text) } }] };
}

function richTextProp(text: string) {
  return { rich_text: [{ text: { content: truncate(text) } }] };
}

function numberProp(n: number) {
  return { number: Number.isFinite(n) ? n : 0 };
}

function selectProp(name: string) {
  return { select: { name } };
}

function dateProp(iso: string) {
  return { date: { start: iso } };
}

function truncate(s: string): string {
  if (s.length <= MAX_TEXT) return s;
  const tail = ` ... [+${s.length - MAX_TEXT} chars]`;
  return s.slice(0, MAX_TEXT - tail.length) + tail;
}

function shortId(id: string): string {
  return id.length > 8 ? id.slice(0, 8) : id;
}

function safeStringify(v: unknown): string {
  try {
    return JSON.stringify(v) ?? "";
  } catch {
    return "[unserializable]";
  }
}

function numAttr(v: unknown): number {
  if (typeof v === "number" && Number.isFinite(v)) return v;
  if (typeof v === "string") {
    const n = Number(v);
    return Number.isFinite(n) ? n : 0;
  }
  return 0;
}

function stringAttr(v: unknown): string {
  if (v == null) return "";
  if (typeof v === "string") return v;
  return safeStringify(v);
}

function round8(n: number): number {
  return Math.round(n * 1e8) / 1e8;
}
