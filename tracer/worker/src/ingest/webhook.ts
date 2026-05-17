/**
 * Ingest webhook capability.
 *
 * One HTTP endpoint that accepts HMAC-signed JSON span batches (OTLP-shaped
 * but permissive), parses them, and upserts into the Traces + Spans Notion
 * databases. Tolerates partial bad spans by skipping with a structured warning.
 *
 * Auth model: HMAC-SHA256 over the raw body, key = process.env.INGEST_SECRET.
 * Verification failures throw WebhookVerificationError; after 5 in a row
 * Notion disables the webhook until redeploy.
 *
 * Webhook context.notion is NOT auto-authenticated, so we require
 * NOTION_API_TOKEN to be set as an env var (an internal integration token
 * with access to the worker's managed databases). The runtime injects that
 * into context.notion automatically.
 */

import type { Worker } from "@notionhq/workers";
import { verifyIngestSignature } from "./verify.js";
import { parseBatch } from "./parse.js";
import { upsertBatch } from "./upsert.js";

export function registerIngestWebhook(worker: Worker) {
  worker.webhook("ingest", {
    title: "Tracer Ingest",
    description:
      "HMAC-signed span batch ingest. POST OTLP/JSON-shaped payloads from your agent.",
    execute: async (events, { notion }) => {
      for (const event of events) {
        verifyIngestSignature(event.rawBody, event.headers);

        let body: Record<string, unknown>;
        try {
          body = JSON.parse(event.rawBody) as Record<string, unknown>;
        } catch {
          console.error(
            `ingest[${event.deliveryId}]: malformed JSON, dropping`,
          );
          continue;
        }

        const { batch, skipped } = parseBatch(body);
        if (skipped.length > 0) {
          console.warn(
            `ingest[${event.deliveryId}]: skipped ${skipped.length} malformed span(s):`,
            skipped.slice(0, 3).map((s) => s.reason),
          );
        }
        if (batch.spans.length === 0) {
          console.warn(
            `ingest[${event.deliveryId}]: no valid spans in batch (service=${batch.service})`,
          );
          continue;
        }

        const result = await upsertBatch(notion, batch);
        console.log(
          `ingest[${event.deliveryId}]: service=${batch.service} traces=${result.tracesTouched} spans=${result.spansTouched} (created=${result.spansCreated}, updated=${result.spansUpdated})`,
        );
      }
    },
  });
}
