// Tracer trigger client.
//
// Posts to the Notion-hosted worker's `triggerFunction` webhook with the
// HMAC signature scheme implemented in `tracer/worker/src/ingest/webhook.ts`:
//
//   header: x-tracer-signature: sha256=<lowercase hex>
//   secret: INGEST_SECRET (synced into the extension via vite env at build)
//   body:   the raw JSON request body
//
// The signature is computed over the request body bytes (NOT a structured
// payload). Keep the body byte-stable between sign-time and send-time by
// signing the same string we hand to fetch.

import { makeLog } from "./log";
import {
  getTracerTriggerUrl,
  getTracerIngestSecret,
} from "./settings";

const log = makeLog("tracer");

export interface TriggerInput {
  /** Function key declared in the worker's seed-syncs (e.g. "job-prospector"). */
  functionKey: string;
  /** Extension-generated id; correlates back to the resulting Functions · Runs row. */
  runId: string;
  /** Free-form payload merged into the run's `state.input.*`. */
  input: Record<string, unknown>;
}

export interface TriggerResult {
  ok: boolean;
  status: number;
  /** Run ID as accepted by the worker (echoes input.runId on success). */
  runId: string;
  /** Truncated response body for diagnostics. */
  body: string;
}

/**
 * POST to the worker's triggerFunction webhook and return a normalized result.
 *
 * Errors are surfaced as a non-ok result with a useful `body` string rather
 * than as thrown exceptions — the job-agent treats trigger failures as
 * recoverable (the user can retry).
 */
export async function triggerJobProspector(
  input: Record<string, unknown>,
  runId: string,
): Promise<TriggerResult> {
  const [url, secret] = await Promise.all([
    getTracerTriggerUrl(),
    getTracerIngestSecret(),
  ]);
  if (!url) {
    return {
      ok: false,
      status: 0,
      runId,
      body: "tracer trigger url not configured",
    };
  }
  if (!secret) {
    return {
      ok: false,
      status: 0,
      runId,
      body: "tracer ingest secret not configured",
    };
  }
  return triggerFunction(url, secret, {
    functionKey: "job-prospector",
    runId,
    input,
  });
}

export async function triggerFunction(
  url: string,
  secret: string,
  payload: TriggerInput,
): Promise<TriggerResult> {
  // Stringify ONCE — the same bytes are signed and sent.
  const body = JSON.stringify(payload);
  const signature = await signBody(secret, body);

  try {
    const r = await fetch(url, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-tracer-signature": signature,
      },
      body,
    });
    const text = await safeReadText(r);
    if (!r.ok) {
      log.warn("trigger failed", r.status, text);
    } else {
      log("trigger ok", payload.functionKey, payload.runId, r.status);
    }
    return {
      ok: r.ok,
      status: r.status,
      runId: payload.runId,
      body: text,
    };
  } catch (e) {
    const msg = (e as Error)?.message ?? String(e);
    log.warn("trigger threw", msg);
    return { ok: false, status: 0, runId: payload.runId, body: msg };
  }
}

/**
 * HMAC-SHA256 the raw body with the shared secret, return `sha256=<hex>`.
 * Uses `crypto.subtle` which is available in MV3 service workers AND in
 * the popup window.
 */
export async function signBody(secret: string, body: string): Promise<string> {
  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey(
    "raw",
    enc.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const sig = await crypto.subtle.sign("HMAC", key, enc.encode(body));
  return "sha256=" + bufToHex(sig);
}

function bufToHex(buf: ArrayBuffer): string {
  const bytes = new Uint8Array(buf);
  let out = "";
  for (let i = 0; i < bytes.length; i++) {
    out += bytes[i].toString(16).padStart(2, "0");
  }
  return out;
}

async function safeReadText(r: Response): Promise<string> {
  try {
    const t = await r.text();
    return t.slice(0, 500);
  } catch {
    return "";
  }
}
