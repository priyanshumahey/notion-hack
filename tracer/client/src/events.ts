/**
 * Inngest-style event sender for the Notion Tracer worker.
 *
 * Usage:
 *   import { sendEvent } from "@notion-tracer/client";
 *
 *   await sendEvent({
 *     url: process.env.SEND_EVENT_URL!,   // /webhooks/.../sendEvent
 *     secret: process.env.TRACER_SECRET!, // INGEST_SECRET on the worker
 *     name: "user.signup",
 *     data: { email: "alice@example.com", plan: "pro" },
 *   });
 *
 * The worker fans this event out to every enabled function whose
 * `Event Name` matches (exact, or prefix `user.*`). Functions can also
 * park on `step.waitForEvent(...)` and resume when this event arrives.
 *
 * For higher throughput, hold a long-lived `EventSender` instance instead
 * of calling `sendEvent` per call — same HMAC code path, but skips
 * recomputing the function closure each time.
 */

import * as crypto from "node:crypto";

export interface SendEventArgs {
  url: string;
  secret: string;
  name: string;
  data?: Record<string, unknown>;
  /** Caller-supplied event id (default: random `evt_<hex>`). */
  id?: string;
  /**
   * Idempotency key. The worker rejects a second event with the same key
   * regardless of `id`, so it's the right knob for "this event might fire
   * twice but should only run once" cases (e.g. webhook retries).
   */
  idempotencyKey?: string;
  /** Override fetch (e.g. for testing). Default: global fetch. */
  fetchImpl?: typeof fetch;
  /** Per-request timeout. Default 10 000 ms. */
  requestTimeoutMs?: number;
}

export interface SendEventResult {
  /** HTTP status from the worker. 200/202 = accepted. */
  status: number;
  /** The event id we sent (so callers can correlate with Notion rows). */
  eventId: string;
}

const SIGNATURE_HEADER = "x-tracer-signature";

export async function sendEvent(args: SendEventArgs): Promise<SendEventResult> {
  const eventId =
    args.id ?? `evt_${crypto.randomBytes(6).toString("hex")}`;
  const body = JSON.stringify({
    id: eventId,
    name: args.name,
    data: args.data ?? {},
    ...(args.idempotencyKey ? { idempotencyKey: args.idempotencyKey } : {}),
  });
  const signature = sign(body, args.secret);
  const fetchImpl = args.fetchImpl ?? fetch;
  const timeoutMs = args.requestTimeoutMs ?? 10_000;

  const controller = new AbortController();
  const t = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetchImpl(args.url, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        [SIGNATURE_HEADER]: signature,
      },
      body,
      signal: controller.signal,
    });
    if (res.status < 200 || res.status >= 300) {
      const text = await res.text().catch(() => "");
      throw new Error(
        `sendEvent: HTTP ${res.status}${text ? ` — ${text}` : ""}`,
      );
    }
    return { status: res.status, eventId };
  } finally {
    clearTimeout(t);
  }
}

export interface EventSenderOptions {
  url: string;
  secret: string;
  /** Override fetch (e.g. for testing). Default: global fetch. */
  fetchImpl?: typeof fetch;
  /** Per-request timeout. Default 10 000 ms. */
  requestTimeoutMs?: number;
}

/**
 * Long-lived helper for code paths that emit events frequently. Holds the
 * worker URL + HMAC secret so call sites only need `name` and `data`.
 */
export class EventSender {
  constructor(private readonly opts: EventSenderOptions) {}

  send(args: {
    name: string;
    data?: Record<string, unknown>;
    id?: string;
    idempotencyKey?: string;
  }): Promise<SendEventResult> {
    return sendEvent({
      url: this.opts.url,
      secret: this.opts.secret,
      fetchImpl: this.opts.fetchImpl,
      requestTimeoutMs: this.opts.requestTimeoutMs,
      ...args,
    });
  }
}

function sign(body: string, secret: string): string {
  const mac = crypto.createHmac("sha256", secret).update(body).digest("hex");
  return `sha256=${mac}`;
}
