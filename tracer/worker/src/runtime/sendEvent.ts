/**
 * `sendEvent` webhook — Inngest-style event ingress.
 *
 * POST { name: string, data?: object, id?: string, idempotencyKey?: string }
 * Headers: `x-tracer-signature: sha256=<hex>` HMAC over the raw body using
 *          `INGEST_SECRET` (shared with the `ingest` and `triggerFunction`
 *          webhooks).
 *
 * Effect:
 *   1. Verifies the signature.
 *   2. Validates the payload — `name` is required, `data` must be a plain
 *      object if supplied.
 *   3. Queries Functions · Catalog for every enabled function whose
 *      Trigger=event AND Event Name matches the incoming name (exact
 *      match or wildcard `*` / `prefix.*`).
 *   4. For each matched function, idempotently pages.create's a pending
 *      external row in Functions · Runs (`run_evt_<eventId>_<fnKey>` as PK).
 *      The stepper adopts these rows on its next tick — same path the
 *      manual `triggerFunction` webhook uses.
 *
 * No Functions · Events DB involved: events are ephemeral by design. If
 * you need to audit them, log via the trace pipeline (the root span we
 * emit per fanout includes the event id and event name as attributes).
 */

import { WebhookVerificationError } from "@notionhq/workers";
import type { Worker } from "@notionhq/workers";
import type { Client as NotionClient } from "@notionhq/client";

import { verifyIngestSignature } from "../ingest/verify.js";
import { upsertBatch } from "../ingest/upsert.js";
import type { IngestBatch, Span } from "../types.js";
import {
  findRowByPK,
  getRelation,
  getRichText,
  getTitle,
  randHex,
  resolveRuntimeDbId,
  safeStringify,
  truncate,
} from "./notion.js";

interface SendEventPayload {
  name?: string;
  data?: Record<string, unknown>;
  id?: string;
  idempotencyKey?: string;
}

interface MatchedFunction {
  pageId: string;
  functionKey: string;
  functionName: string;
  sandboxPageId: string | null;
}

export function registerSendEventWebhook(worker: Worker): void {
  worker.webhook("sendEvent", {
    title: "Send Event",
    description:
      "Fire an Inngest-style event. POST { name, data?, id?, idempotencyKey? } " +
      "signed with HMAC-SHA256 over the raw body using INGEST_SECRET. Every " +
      "enabled function whose Trigger=event and Event Name matches will get " +
      "a new pending run in Functions · Runs.",
    execute: async (events, ctx) => {
      for (const evt of events) {
        try {
          verifyIngestSignature(evt.rawBody, evt.headers);
        } catch (err) {
          if (err instanceof WebhookVerificationError) throw err;
          throw new WebhookVerificationError(err);
        }

        const body = evt.body as SendEventPayload;
        const name = body.name?.trim();
        if (!name) {
          console.warn(`sendEvent[${evt.deliveryId}]: missing name`);
          continue;
        }
        if (
          body.data !== undefined &&
          (body.data === null ||
            typeof body.data !== "object" ||
            Array.isArray(body.data))
        ) {
          console.warn(
            `sendEvent[${evt.deliveryId}]: data must be a plain object`,
          );
          continue;
        }

        const functionsDb = await resolveRuntimeDbId(ctx.notion, "functions");
        const runsDb = await resolveRuntimeDbId(ctx.notion, "functionRuns");
        if (!functionsDb || !runsDb) {
          console.warn(
            `sendEvent[${evt.deliveryId}]: runtime DBs not yet provisioned`,
          );
          continue;
        }

        const eventId = body.id ?? `evt_${randHex(8)}`;
        const data = body.data ?? {};

        // Durable wake delivery via the Tracer · Events DB. We write a
        // `signal`-typed event row per incoming event regardless of whether
        // any function listens for it — the stepper consumes signal rows
        // during its tick to advance any parked `waitForEvent` run.
        //
        // We use `pages.create` (which works for managed DBs from a
        // webhook handler) rather than `pages.update` on the parked run
        // row directly (which is blocked by the framework's managed-
        // property protection on Run State / Wake At). Decoupling event
        // arrival from run parking also eliminates the race condition
        // where the event arrives before the run reaches `waiting`
        // state — the signal row just waits in the DB until the stepper
        // sees both.
        //
        // We co-opt Tracer · Events (rather than declaring a dedicated
        // wakes DB) because Notion only auto-shares managed DBs with
        // the worker integration after a sync that actively writes to
        // them runs — and a freshly-declared wakes DB with a no-op
        // owner sync is invisible to `notion.search()` at runtime.
        // Tracer · Events is already shared because the ingest webhook
        // writes to it, so we get a working DB for free.
        const eventsDb = await resolveRuntimeDbId(ctx.notion, "events");
        if (eventsDb) {
          try {
            const wakeId = `wake_${eventId}_${randHex(4)}`;
            const nowIso = new Date().toISOString();
            await ctx.notion.pages.create({
              parent: { database_id: eventsDb },
              properties: {
                Name: {
                  title: [{ type: "text", text: { content: wakeId } }],
                },
                "Event ID": {
                  rich_text: [{ type: "text", text: { content: wakeId } }],
                },
                Type: { select: { name: "signal" } },
                Severity: { select: { name: "info" } },
                Category: {
                  rich_text: [{ type: "text", text: { content: name } }],
                },
                Summary: {
                  rich_text: [{ type: "text", text: { content: eventId } }],
                },
                Detail: {
                  rich_text: [
                    {
                      type: "text",
                      text: { content: truncate(safeStringify(data)) },
                    },
                  ],
                },
                At: { date: { start: nowIso } },
              } as never,
            });
            console.log(
              `sendEvent[${evt.deliveryId}]: wrote wake signal ${wakeId} for event=${name}`,
            );
          } catch (err) {
            console.warn(
              `sendEvent[${evt.deliveryId}]: failed to write wake signal: ` +
                (err instanceof Error ? err.message : err),
            );
          }
        } else {
          console.warn(
            `sendEvent[${evt.deliveryId}]: events DB not resolvable — ` +
              `parked waitForEvent runs will not wake until timeout`,
          );
        }

        const matches = await findMatchingFunctions(
          ctx.notion,
          functionsDb,
          name,
        );
        console.log(
          `sendEvent[${evt.deliveryId}]: event=${name} id=${eventId} ` +
            `matched ${matches.length} function(s): ` +
            `[${matches.map((m) => m.functionKey).join(",")}]`,
        );

        let fannedOut = 0;
        for (const match of matches) {
          const runId = body.idempotencyKey
            ? `run_evt_${body.idempotencyKey}_${match.functionKey}`
            : `run_evt_${eventId}_${match.functionKey}`;

          const existing = await findRowByPK(
            ctx.notion,
            runsDb,
            "Run ID",
            runId,
          );
          if (existing) {
            console.log(
              `sendEvent[${evt.deliveryId}]: duplicate runId=${runId}, skipping`,
            );
            continue;
          }

          const traceId = randHex(16);
          const rootSpanId = randHex(8);
          const input = {
            event: { name, id: eventId, data },
            data,
          };
          const initialState = {
            input,
            steps: {},
            rootSpanId,
            sourceEventId: eventId,
          };
          const now = new Date().toISOString();

          const properties: Record<string, unknown> = {
            Name: {
              title: [{ type: "text", text: { content: runId } }],
            },
            "Run ID": {
              rich_text: [{ type: "text", text: { content: runId } }],
            },
            Function: { relation: [{ id: match.pageId }] },
            ...(match.sandboxPageId
              ? { Sandbox: { relation: [{ id: match.sandboxPageId }] } }
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
            "Source Event ID": {
              rich_text: [{ type: "text", text: { content: eventId } }],
            },
            "Started At": { date: { start: now } },
          };

          await ctx.notion.pages.create({
            parent: { database_id: runsDb },
            properties: properties as never,
          });

          // Emit the root span so the trace is queryable right away.
          const rootSpan: Span = {
            traceId,
            spanId: rootSpanId,
            parentSpanId: null,
            name: `function.run.${match.functionKey}`,
            kind: "agent",
            status: "ok",
            startedAt: now,
            endedAt: now,
            durationMs: 0,
            attributes: {
              "function.key": match.functionKey,
              "function.run_id": runId,
              "function.name": match.functionName,
              "event.name": name,
              "event.id": eventId,
            },
            events: [],
            errorMessage: null,
          };
          const batch: IngestBatch = {
            resource: { source: "function-runtime" },
            service: "function-runtime",
            session: { id: `fn:${match.functionKey}`, tags: ["runtime"] },
            spans: [rootSpan],
          };
          try {
            await upsertBatch(ctx.notion, batch);
          } catch (err) {
            console.warn(
              `[sendEvent] root-span emission failed for ${runId}: ` +
                (err instanceof Error ? err.message : err),
            );
          }

          fannedOut += 1;
          console.log(
            `sendEvent[${evt.deliveryId}]: fanned out ${name} → ${match.functionKey} ` +
              `runId=${runId} traceId=${traceId}`,
          );
        }

        if (fannedOut === 0) {
          console.log(
            `sendEvent[${evt.deliveryId}]: event=${name} id=${eventId} ` +
              `no fan-out (no enabled event-trigger function matched)`,
          );
        }
      }
    },
  });
}

/**
 * Query Functions · Catalog for every enabled row where Trigger=event and
 * Event Name matches `eventName` (exact or `prefix.*` / `*` wildcard).
 *
 * Notion's filter doesn't support pattern matching, so we filter
 * server-side on Trigger+Enabled and locally on Event Name.
 */
async function findMatchingFunctions(
  notion: NotionClient,
  functionsDb: string,
  eventName: string,
): Promise<MatchedFunction[]> {
  const out: MatchedFunction[] = [];
  let cursor: string | undefined;
  do {
    const res = await notion.databases.query({
      database_id: functionsDb,
      start_cursor: cursor,
      filter: {
        and: [
          { property: "Trigger", select: { equals: "event" } },
          { property: "Enabled", checkbox: { equals: true } },
        ],
      },
      page_size: 100,
    });
    for (const row of res.results) {
      if (!("properties" in row)) continue;
      const props = (row as { properties: Record<string, unknown> }).properties;
      const declared = getRichText(props, "Event Name").trim();
      if (!eventNameMatches(declared, eventName)) continue;
      out.push({
        pageId: row.id,
        functionKey: getRichText(props, "Function Key"),
        functionName: getTitle(props, "Name"),
        sandboxPageId: getRelation(props, "Sandbox")[0] ?? null,
      });
    }
    cursor = res.has_more ? res.next_cursor ?? undefined : undefined;
  } while (cursor);
  return out;
}

export function eventNameMatches(pattern: string, name: string): boolean {
  if (!pattern) return false;
  if (pattern === "*" || pattern === name) return true;
  if (pattern.endsWith(".*")) {
    const prefix = pattern.slice(0, -2);
    return name === prefix || name.startsWith(`${prefix}.`);
  }
  return false;
}
