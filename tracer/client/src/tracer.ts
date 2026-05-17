/**
 * Tracer — the developer-facing object.
 *
 * Usage:
 *   const tracer = new Tracer({ url, secret, service: "my-agent" });
 *   await tracer.span("agent.run", async (span) => {
 *     span.setAttribute("user.id", uid);
 *     const completion = await openai.chat.completions.create({...});
 *     span.recordLLM({
 *       provider: "openai",
 *       model: "gpt-4o",
 *       promptTokens: completion.usage.prompt_tokens,
 *       completionTokens: completion.usage.completion_tokens,
 *     });
 *   });
 *   await tracer.shutdown();
 *
 * Concurrency: `span()` wraps the supplied async function; the active span is
 * threaded through a per-call AsyncLocalStorage so nested `tracer.span(...)`
 * calls automatically attach as children.
 */

import { AsyncLocalStorage } from "node:async_hooks";
import * as crypto from "node:crypto";

import { Transport, type TransportOptions } from "./transport.js";
import type {
  SessionInfo,
  SpanKind,
  SpanRecord,
  SpanStatus,
} from "./types.js";

export interface TracerOptions {
  /** Full ingest webhook URL printed by `ntn workers webhooks list`. */
  url: string;
  /** INGEST_SECRET configured on the worker. */
  secret: string;
  /** Service name attached to every batch (free-form). */
  service: string;
  /** Optional session info — id, optional user_id, optional tags. */
  session?: SessionInfo | null;
  /** Override transport defaults. */
  transport?: Partial<Omit<TransportOptions, "url" | "secret" | "service" | "session">>;
}

export interface ActiveSpan {
  readonly traceId: string;
  readonly spanId: string;
  setAttribute(key: string, value: unknown): void;
  addEvent(name: string, attributes?: Record<string, unknown>): void;
  setStatus(status: SpanStatus, errorMessage?: string): void;
  /** Convenience: stamp this span as kind=llm and attach standard usage fields. */
  recordLLM(usage: {
    provider?: string;
    model?: string;
    promptTokens?: number;
    completionTokens?: number;
    prompt?: string;
    completion?: string;
  }): void;
}

interface ActiveSpanContext {
  traceId: string;
  spanId: string;
  parentSpanId: string | null;
}

export class Tracer {
  private readonly transport: Transport;
  private readonly als = new AsyncLocalStorage<ActiveSpanContext>();

  constructor(private readonly opts: TracerOptions) {
    this.transport = new Transport({
      url: opts.url,
      secret: opts.secret,
      service: opts.service,
      session: opts.session ?? null,
      ...opts.transport,
    });
  }

  /**
   * Wrap an async function in a span. Automatically nests under any
   * currently-active span (same trace, parent_span_id set).
   */
  async span<T>(
    name: string,
    fn: (span: ActiveSpan) => Promise<T>,
    opts?: { kind?: SpanKind },
  ): Promise<T> {
    const parent = this.als.getStore();
    const traceId = parent?.traceId ?? newTraceId();
    const spanId = newSpanId();
    const parentSpanId = parent?.spanId ?? null;

    const ctx: ActiveSpanContext = { traceId, spanId, parentSpanId };

    const startedAt = new Date().toISOString();
    const attributes: Record<string, unknown> = {};
    const events: SpanRecord["events"] = [];
    let status: SpanStatus = "unset";
    let errorMessage: string | null = null;
    let kind: SpanKind = opts?.kind ?? "internal";

    const handle: ActiveSpan = {
      traceId,
      spanId,
      setAttribute(key, value) {
        attributes[key] = value;
      },
      addEvent(eventName, eventAttrs) {
        events.push({
          name: eventName,
          time: new Date().toISOString(),
          ...(eventAttrs ? { attributes: eventAttrs } : {}),
        });
      },
      setStatus(s, msg) {
        status = s;
        if (msg) errorMessage = msg;
      },
      recordLLM(usage) {
        kind = "llm";
        if (usage.provider) attributes["gen_ai.system"] = usage.provider;
        if (usage.model) attributes["gen_ai.request.model"] = usage.model;
        if (typeof usage.promptTokens === "number") {
          attributes["gen_ai.usage.prompt_tokens"] = usage.promptTokens;
        }
        if (typeof usage.completionTokens === "number") {
          attributes["gen_ai.usage.completion_tokens"] = usage.completionTokens;
        }
        if (usage.prompt) attributes["gen_ai.prompt"] = usage.prompt;
        if (usage.completion) attributes["gen_ai.completion"] = usage.completion;
      },
    };

    try {
      const result = await this.als.run(ctx, () => fn(handle));
      if (status === "unset") status = "ok";
      this.emit({
        trace_id: traceId,
        span_id: spanId,
        parent_span_id: parentSpanId,
        name,
        kind,
        status,
        started_at: startedAt,
        ended_at: new Date().toISOString(),
        attributes,
        events,
        error_message: errorMessage,
      });
      return result;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      this.emit({
        trace_id: traceId,
        span_id: spanId,
        parent_span_id: parentSpanId,
        name,
        kind,
        status: "error",
        started_at: startedAt,
        ended_at: new Date().toISOString(),
        attributes,
        events,
        error_message: msg,
      });
      throw err;
    }
  }

  /** Shorthand for tracer.span(name, fn, { kind: "llm" }). */
  llm<T>(name: string, fn: (span: ActiveSpan) => Promise<T>): Promise<T> {
    return this.span(name, fn, { kind: "llm" });
  }

  /** Shorthand for tracer.span(name, fn, { kind: "tool" }). */
  tool<T>(name: string, fn: (span: ActiveSpan) => Promise<T>): Promise<T> {
    return this.span(name, fn, { kind: "tool" });
  }

  /** Flush any buffered spans. Call on process shutdown. */
  async shutdown(): Promise<void> {
    await this.transport.flush();
  }

  private emit(span: SpanRecord): void {
    this.transport.enqueue(span);
  }
}

function newTraceId(): string {
  return `t_${crypto.randomBytes(8).toString("hex")}`;
}

function newSpanId(): string {
  return `s_${crypto.randomBytes(6).toString("hex")}`;
}
