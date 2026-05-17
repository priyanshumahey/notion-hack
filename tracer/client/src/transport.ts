/**
 * HMAC-signed batched transport. POSTs JSON to the worker's `ingest` webhook.
 *
 * The wire is intentionally simple: one HTTP request per `flush()`, signed
 * with HMAC-SHA256 over the request body. Failures fall back to a single
 * exponential-backoff retry; persistent failures are logged and dropped
 * (we never block the caller's agent path on tracing).
 */

import * as crypto from "node:crypto";
import type { IngestPayload, SpanRecord, SessionInfo } from "./types.js";

export const SIGNATURE_HEADER = "x-tracer-signature";

export interface TransportOptions {
  url: string;
  secret: string;
  service: string;
  session: SessionInfo | null;
  /** Max spans buffered before an automatic flush. Default 100. */
  maxBatchSize?: number;
  /** Max ms between automatic flushes when at least one span is buffered. Default 2000. */
  maxBatchAgeMs?: number;
  /** Per-request timeout. Default 10_000. */
  requestTimeoutMs?: number;
  /** Override fetch (e.g. for testing). Default global fetch. */
  fetchImpl?: typeof fetch;
  /** Called on transport errors so the host app can surface them. */
  onError?: (err: Error) => void;
}

export class Transport {
  private buffer: SpanRecord[] = [];
  private flushTimer: ReturnType<typeof setTimeout> | null = null;
  private readonly maxBatchSize: number;
  private readonly maxBatchAgeMs: number;
  private readonly requestTimeoutMs: number;
  private readonly fetchImpl: typeof fetch;

  constructor(private readonly opts: TransportOptions) {
    this.maxBatchSize = opts.maxBatchSize ?? 100;
    this.maxBatchAgeMs = opts.maxBatchAgeMs ?? 2000;
    this.requestTimeoutMs = opts.requestTimeoutMs ?? 10_000;
    this.fetchImpl = opts.fetchImpl ?? fetch;
  }

  enqueue(span: SpanRecord): void {
    this.buffer.push(span);
    if (this.buffer.length >= this.maxBatchSize) {
      // Fire and forget; errors surface via onError.
      void this.flush();
    } else if (!this.flushTimer) {
      this.flushTimer = setTimeout(() => {
        this.flushTimer = null;
        void this.flush();
      }, this.maxBatchAgeMs);
    }
  }

  async flush(): Promise<void> {
    if (this.flushTimer) {
      clearTimeout(this.flushTimer);
      this.flushTimer = null;
    }
    if (this.buffer.length === 0) return;

    const spans = this.buffer.splice(0, this.buffer.length);
    const payload: IngestPayload = {
      resource: { "service.name": this.opts.service },
      service: this.opts.service,
      session: this.opts.session,
      spans,
    };
    const body = JSON.stringify(payload);
    const signature = sign(body, this.opts.secret);

    try {
      await this.postWithRetry(body, signature);
    } catch (err) {
      this.opts.onError?.(err as Error);
    }
  }

  private async postWithRetry(body: string, signature: string): Promise<void> {
    const attempts = 2;
    let lastErr: unknown;
    for (let i = 0; i < attempts; i++) {
      try {
        await this.postOnce(body, signature);
        return;
      } catch (err) {
        lastErr = err;
        if (i < attempts - 1) {
          await sleep(250 * Math.pow(2, i));
        }
      }
    }
    throw lastErr instanceof Error
      ? lastErr
      : new Error(`tracer transport failed: ${String(lastErr)}`);
  }

  private async postOnce(body: string, signature: string): Promise<void> {
    const controller = new AbortController();
    const t = setTimeout(() => controller.abort(), this.requestTimeoutMs);
    try {
      const res = await this.fetchImpl(this.opts.url, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          [SIGNATURE_HEADER]: signature,
        },
        body,
        signal: controller.signal,
      });
      // Notion answers 202 Accepted; treat any 2xx as success.
      if (res.status < 200 || res.status >= 300) {
        throw new Error(`tracer ingest HTTP ${res.status}`);
      }
    } finally {
      clearTimeout(t);
    }
  }
}

function sign(body: string, secret: string): string {
  const mac = crypto.createHmac("sha256", secret).update(body).digest("hex");
  return `sha256=${mac}`;
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
