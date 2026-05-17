/**
 * Permissive OTLP/JSON-shaped batch parser.
 *
 * Accepts either:
 *   - OTel-style: { resource, scopeSpans: [{ spans: [...] }] } with unix-nano times
 *   - Tracer-native: { service, session, spans: [...] } with ISO times
 *
 * Produces a single canonical IngestBatch. Unknown / missing fields default
 * sensibly (kind=internal, status=unset). Malformed spans are SKIPPED with a
 * structured warning rather than rejecting the whole batch — this matters
 * because we get retried up to 3 times on any throw, and we don't want one
 * bad span to block the whole batch forever.
 */

import type {
  IngestBatch,
  SessionInfo,
  Span,
  SpanEvent,
  SpanKind,
  SpanStatus,
} from "../types.js";

const VALID_KINDS: ReadonlySet<SpanKind> = new Set([
  "internal",
  "llm",
  "tool",
  "http",
  "db",
  "agent",
  "other",
]);

const VALID_STATUS: ReadonlySet<SpanStatus> = new Set(["ok", "error", "unset"]);

export interface ParseResult {
  batch: IngestBatch;
  skipped: Array<{ reason: string; span: unknown }>;
}

export function parseBatch(body: Record<string, unknown>): ParseResult {
  const resource = isRecord(body.resource) ? body.resource : {};
  const service =
    pickString(resource["service.name"]) ??
    pickString((body as { service?: unknown }).service) ??
    "unknown";

  const session = parseSession((body as { session?: unknown }).session);

  // Flatten OTel-style scopeSpans[].spans[] OR accept a flat spans[].
  const rawSpans: unknown[] = (() => {
    const direct = (body as { spans?: unknown }).spans;
    if (Array.isArray(direct)) return direct;
    const scopeSpans = (body as { scopeSpans?: unknown }).scopeSpans;
    if (Array.isArray(scopeSpans)) {
      return scopeSpans.flatMap((s) =>
        isRecord(s) && Array.isArray(s.spans) ? (s.spans as unknown[]) : [],
      );
    }
    return [];
  })();

  const skipped: ParseResult["skipped"] = [];
  const spans: Span[] = [];

  for (const raw of rawSpans) {
    const parsed = parseSpan(raw);
    if (parsed.ok) {
      spans.push(parsed.span);
    } else {
      skipped.push({ reason: parsed.reason, span: raw });
    }
  }

  return {
    batch: { resource, service, session, spans },
    skipped,
  };
}

function parseSession(raw: unknown): SessionInfo | null {
  if (!isRecord(raw)) return null;
  const id = pickString(raw.id) ?? pickString(raw.session_id);
  if (!id) return null;
  const userId = pickString(raw.user_id) ?? pickString(raw.userId);
  const tagsRaw = raw.tags;
  const tags = Array.isArray(tagsRaw)
    ? tagsRaw.map(String).filter(Boolean)
    : undefined;
  return { id, ...(userId ? { userId } : {}), ...(tags ? { tags } : {}) };
}

type SpanParseOk = { ok: true; span: Span };
type SpanParseFail = { ok: false; reason: string };

function parseSpan(raw: unknown): SpanParseOk | SpanParseFail {
  if (!isRecord(raw)) return { ok: false, reason: "not an object" };

  const traceId =
    pickString(raw.trace_id) ?? pickString(raw.traceId);
  const spanId = pickString(raw.span_id) ?? pickString(raw.spanId);
  if (!traceId || !spanId) {
    return { ok: false, reason: "missing trace_id or span_id" };
  }

  const parentSpanId =
    pickString(raw.parent_span_id) ?? pickString(raw.parentSpanId) ?? null;

  const name = pickString(raw.name) ?? "unnamed";

  const kindRaw = pickString(raw.kind)?.toLowerCase() ?? "internal";
  const kind: SpanKind = (VALID_KINDS.has(kindRaw as SpanKind)
    ? kindRaw
    : "internal") as SpanKind;

  const status = pickStatus(raw.status);

  const startedAt = pickTimestamp(
    raw.start_time_unix_nano ?? raw.startTimeUnixNano ?? raw.started_at ?? raw.startedAt,
  );
  const endedAt = pickTimestamp(
    raw.end_time_unix_nano ?? raw.endTimeUnixNano ?? raw.ended_at ?? raw.endedAt,
  );
  if (!startedAt || !endedAt) {
    return { ok: false, reason: "missing start/end time" };
  }

  const durationMs = Math.max(
    0,
    new Date(endedAt).getTime() - new Date(startedAt).getTime(),
  );

  const attributes = isRecord(raw.attributes) ? raw.attributes : {};
  const events = parseEvents(raw.events);
  const errorMessage =
    pickString(raw.error_message) ??
    pickString(raw.errorMessage) ??
    (status === "error" ? pickString(attributes["error.message"]) ?? null : null);

  return {
    ok: true,
    span: {
      traceId,
      spanId,
      parentSpanId,
      name,
      kind,
      status,
      startedAt,
      endedAt,
      durationMs,
      attributes,
      events,
      errorMessage,
    },
  };
}

function parseEvents(raw: unknown): SpanEvent[] {
  if (!Array.isArray(raw)) return [];
  const out: SpanEvent[] = [];
  for (const e of raw) {
    if (!isRecord(e)) continue;
    const name = pickString(e.name);
    const time = pickTimestamp(
      e.time_unix_nano ?? e.timeUnixNano ?? e.time ?? e.at,
    );
    if (!name || !time) continue;
    const attributes = isRecord(e.attributes) ? e.attributes : undefined;
    out.push({ name, time, ...(attributes ? { attributes } : {}) });
  }
  return out;
}

function pickStatus(raw: unknown): SpanStatus {
  if (typeof raw === "string") {
    const lower = raw.toLowerCase();
    return VALID_STATUS.has(lower as SpanStatus)
      ? (lower as SpanStatus)
      : "unset";
  }
  if (isRecord(raw)) {
    const code = pickString(raw.code)?.toLowerCase();
    if (code === "ok" || code === "error" || code === "unset") return code;
    // OTel sometimes uses numeric codes: 0=unset, 1=ok, 2=error
    if (typeof raw.code === "number") {
      if (raw.code === 1) return "ok";
      if (raw.code === 2) return "error";
    }
  }
  return "unset";
}

function pickTimestamp(raw: unknown): string | null {
  if (typeof raw === "string") {
    // ISO 8601 string
    const d = new Date(raw);
    return Number.isNaN(d.getTime()) ? null : d.toISOString();
  }
  if (typeof raw === "number" && Number.isFinite(raw)) {
    // OTel uses unix nanoseconds; some senders use milliseconds.
    // Heuristic: > 1e16 = nanos, > 1e12 = millis, else seconds.
    let ms: number;
    if (raw > 1e16) ms = raw / 1e6;
    else if (raw > 1e12) ms = raw;
    else ms = raw * 1000;
    return new Date(ms).toISOString();
  }
  if (typeof raw === "bigint") {
    return new Date(Number(raw / 1_000_000n)).toISOString();
  }
  return null;
}

function pickString(v: unknown): string | null {
  return typeof v === "string" && v.length > 0 ? v : null;
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}
