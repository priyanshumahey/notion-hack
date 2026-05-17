/**
 * Public API surface for @notion-tracer/client.
 *
 *   - `Tracer` with `span()` / `llm()` / `tool()` — OpenTelemetry-style
 *     manual instrumentation; spans are batched + HMAC-signed and shipped
 *     to the worker's `ingest` webhook.
 *   - `sendEvent` / `EventSender` — Inngest-style event emission; fires
 *     background functions defined in Notion that match the event name.
 *
 * Phase 0: just `Tracer` with `span()` and `llm()`. No auto-instrumentation;
 * users opt into wrapping their calls explicitly. Phase 1 will add
 * `instrument.openai()` and `instrument.anthropic()`.
 */

export { Tracer, type TracerOptions, type ActiveSpan } from "./tracer.js";
export {
  sendEvent,
  EventSender,
  type SendEventArgs,
  type SendEventResult,
  type EventSenderOptions,
} from "./events.js";
export type {
  SpanKind,
  SpanStatus,
  SpanRecord,
  SessionInfo,
  IngestPayload,
} from "./types.js";
