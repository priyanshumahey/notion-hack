/**
 * Shared types for span ingest.
 *
 * The wire format is OTLP/JSON-shaped but permissive: callers may send
 * unix-nano integers OR ISO timestamps, snake_case OR camelCase keys.
 * Normalisation happens in `ingest/parse.ts` so the rest of the worker
 * sees one canonical shape (`Span`).
 */

export type SpanKind =
  | "internal"
  | "llm"
  | "tool"
  | "http"
  | "db"
  | "agent"
  | "other";

export type SpanStatus = "ok" | "error" | "unset";

export interface SpanEvent {
  name: string;
  time: string; // ISO
  attributes?: Record<string, unknown>;
}

export interface Span {
  traceId: string;
  spanId: string;
  parentSpanId: string | null;
  name: string;
  kind: SpanKind;
  status: SpanStatus;
  startedAt: string; // ISO
  endedAt: string; // ISO
  durationMs: number;
  attributes: Record<string, unknown>;
  events: SpanEvent[];
  errorMessage: string | null;
}

export interface SessionInfo {
  id: string;
  userId?: string;
  tags?: string[];
}

export interface IngestBatch {
  resource: Record<string, unknown>;
  service: string;
  session: SessionInfo | null;
  spans: Span[];
}
