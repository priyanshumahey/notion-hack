/**
 * `triggerFunction` webhook.
 *
 * POST { functionKey: string, input?: object, runId?: string }
 * Headers: `x-tracer-signature: sha256=<hex>` HMAC over the raw body using
 *          `INGEST_SECRET` (same shared secret as the ingest webhook).
 *
 * Effect:
 *   1. Looks up the function row by `Function Key`.
 *   2. Creates a row in `Functions · Runs` with Status=pending, Step Cursor=0,
 *      Input=JSON, State={ input, steps:{}, rootSpanId }.
 *   3. Emits a root span (`function.run.<key>`) into the existing Tracer ·
 *      Spans tree so the run is observable immediately, even before the first
 *      stepper tick.
 *
 * The webhook capability returns `void`, so callers should supply their own
 * `runId` to retry-safely identify the row they just triggered. The trigger
 * payload, generated runId (when omitted), and traceId are logged for offline
 * correlation.
 */

import { WebhookVerificationError } from "@notionhq/workers";
import type { Worker } from "@notionhq/workers";
import { verifyIngestSignature } from "../ingest/verify.js";
import { upsertBatch } from "../ingest/upsert.js";
import type { Span, IngestBatch } from "../types.js";
import {
  findRowByPK,
  getRichText,
  getRelation,
  getTitle,
  randHex,
  resolveRuntimeDbId,
  safeStringify,
  truncate,
} from "./notion.js";

interface TriggerPayload {
  functionKey?: string;
  input?: Record<string, unknown>;
  /** Optional caller-supplied id for retry-safe triggers. */
  runId?: string;
}

export function registerTriggerWebhook(worker: Worker): void {
  worker.webhook("triggerFunction", {
    title: "Trigger Function",
    description:
      "Start a new run for a Functions · Catalog entry. POST { functionKey, input } " +
      "signed with HMAC-SHA256 over the raw body using INGEST_SECRET.",
    execute: async (events, ctx) => {
      for (const evt of events) {
        try {
          verifyIngestSignature(evt.rawBody, evt.headers);
        } catch (err) {
          if (err instanceof WebhookVerificationError) throw err;
          throw new WebhookVerificationError(err);
        }

        const body = evt.body as TriggerPayload;
        const functionKey = body.functionKey?.trim();
        if (!functionKey) {
          console.warn(
            `triggerFunction[${evt.deliveryId}]: missing functionKey`,
          );
          continue;
        }

        const functionsDb = await resolveRuntimeDbId(ctx.notion, "functions");
        const runsDb = await resolveRuntimeDbId(ctx.notion, "functionRuns");
        if (!functionsDb || !runsDb) {
          console.warn(
            `triggerFunction[${evt.deliveryId}]: runtime DBs not yet provisioned`,
          );
          continue;
        }

        const fnRow = await findRowByPK(
          ctx.notion,
          functionsDb,
          "Function Key",
          functionKey,
        );
        if (!fnRow) {
          console.warn(
            `triggerFunction[${evt.deliveryId}]: no function with key ${functionKey}`,
          );
          continue;
        }

        const fnName = getTitle(fnRow.properties, "Name") || functionKey;
        const sandboxIds = getRelation(fnRow.properties, "Sandbox");
        const sandboxPageId = sandboxIds[0] ?? null;

        // Idempotency: if the caller passed a runId and a row exists, skip.
        const runId = body.runId ?? `run_${randHex(8)}`;
        const existing = await findRowByPK(
          ctx.notion,
          runsDb,
          "Run ID",
          runId,
        );
        if (existing) {
          console.log(
            `triggerFunction[${evt.deliveryId}]: duplicate run ${runId} (returning existing)`,
          );
          continue;
        }

        const traceId = randHex(16); // 32 hex chars
        const rootSpanId = randHex(8);
        const input = body.input ?? {};
        const initialState = { input, steps: {}, rootSpanId };
        const now = new Date().toISOString();

        const properties: Record<string, unknown> = {
          Name: {
            title: [{ type: "text", text: { content: runId } }],
          },
          "Run ID": {
            rich_text: [{ type: "text", text: { content: runId } }],
          },
          Function: { relation: [{ id: fnRow.pageId }] },
          ...(sandboxPageId
            ? { Sandbox: { relation: [{ id: sandboxPageId }] } }
            : {}),
          "Trace ID": {
            rich_text: [{ type: "text", text: { content: traceId } }],
          },
          Status: { select: { name: "pending" } },
          "Step Cursor": { number: 0 },
          Attempt: { number: 0 },
          Input: {
            rich_text: [
              {
                type: "text",
                text: { content: truncate(safeStringify(input)) },
              },
            ],
          },
          "Run State": {
            rich_text: [
              {
                type: "text",
                text: { content: truncate(safeStringify(initialState)) },
              },
            ],
          },
          "Started At": { date: { start: now } },
        };

        await ctx.notion.pages.create({
          parent: { database_id: runsDb },
          properties: properties as never,
        });

        // Emit the root span so the trace is visible immediately.
        const rootSpan: Span = {
          traceId,
          spanId: rootSpanId,
          parentSpanId: null,
          name: `function.run.${functionKey}`,
          kind: "agent",
          status: "ok",
          startedAt: now,
          endedAt: now,
          durationMs: 0,
          attributes: {
            "function.key": functionKey,
            "function.run_id": runId,
            "function.name": fnName,
          },
          events: [],
          errorMessage: null,
        };
        const batch: IngestBatch = {
          resource: { source: "function-runtime" },
          service: "function-runtime",
          session: { id: `fn:${functionKey}`, tags: ["runtime"] },
          spans: [rootSpan],
        };
        try {
          await upsertBatch(ctx.notion, batch);
        } catch (err) {
          // Don't fail the trigger if the trace DBs aren't ready yet.
          console.warn(
            "[triggerFunction] root-span emission failed:",
            err instanceof Error ? err.message : err,
          );
        }

        console.log(
          `triggerFunction[${evt.deliveryId}]: queued runId=${runId} traceId=${traceId} fn=${functionKey}`,
        );
      }
    },
  });
}
