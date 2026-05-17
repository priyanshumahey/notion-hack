/**
 * Wire types shared between client and worker. Mirror of worker/src/types.ts
 * but written out separately so the client has zero dep on the worker package.
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

export interface SpanRecord {
  trace_id: string;
  span_id: string;
  parent_span_id: string | null;
  name: string;
  kind: SpanKind;
  status: SpanStatus;
  started_at: string; // ISO 8601
  ended_at: string; // ISO 8601
  attributes: Record<string, unknown>;
  events: Array<{
    name: string;
    time: string;
    attributes?: Record<string, unknown>;
  }>;
  error_message: string | null;
}

export interface SessionInfo {
  id: string;
  user_id?: string;
  tags?: string[];
}

export interface IngestPayload {
  resource: { "service.name": string };
  service: string;
  session: SessionInfo | null;
  spans: SpanRecord[];
}
