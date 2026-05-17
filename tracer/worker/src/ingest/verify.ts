/**
 * HMAC-SHA256 verification for ingest webhook requests.
 *
 * Header: X-Tracer-Signature: sha256=<hex>
 * Key:    process.env.INGEST_SECRET
 * Body:   the request's raw body string
 *
 * Throws WebhookVerificationError so Notion records a verification failure
 * (and after 5 consecutive failures, disables the webhook until redeploy).
 */

import * as crypto from "node:crypto";
import { WebhookVerificationError } from "@notionhq/workers";

export const SIGNATURE_HEADER = "x-tracer-signature";

export function verifyIngestSignature(
  rawBody: string,
  headers: Record<string, string>,
): void {
  const secret = process.env.INGEST_SECRET;
  if (!secret) {
    throw new WebhookVerificationError("INGEST_SECRET not configured");
  }

  const provided = headers[SIGNATURE_HEADER];
  if (!provided?.startsWith("sha256=")) {
    throw new WebhookVerificationError("Missing or malformed signature");
  }

  const expected = `sha256=${crypto
    .createHmac("sha256", secret)
    .update(rawBody)
    .digest("hex")}`;

  if (provided.length !== expected.length) {
    throw new WebhookVerificationError("Signature mismatch");
  }

  if (
    !crypto.timingSafeEqual(Buffer.from(provided), Buffer.from(expected))
  ) {
    throw new WebhookVerificationError("Signature mismatch");
  }
}
