/**
 * Tracer worker — entry point.
 *
 * Registers capabilities for the smallest viable trace product plus the
 * workflow runtime layer ("Inngest-style background functions live in Notion"):
 *   - 9 managed Notion databases:
 *       Tracer · Sessions / Traces / Spans / LLM Calls / Tool Calls / Events
 *       Functions · Sandboxes / Catalog / Runs
 *   - 3 webhooks:
 *       `ingest`          — signed OTLP-JSON span batches
 *       `triggerFunction` — start a run for a catalogued function by key
 *       `sendEvent`       — fire an event; every enabled function whose
 *                           Trigger=event and Event Name matches gets a
 *                           new pending run in Functions · Runs
 *   - 1 sync:
 *       `functionStepper` — every minute, advance each live run by one
 *                           step (with wake/timeout handling for sleeping
 *                           and waiting runs)
 *   - 1 tool:
 *       `getTrace` — read-only; returns trace + ordered span tree
 *
 * See ../../PLAN.md for the full phased roadmap.
 */

import { Worker } from "@notionhq/workers";

import { declareDatabases } from "./databases.js";
import { registerOwnerSyncs } from "./owners.js";
import { registerSeedSyncs } from "./seed-syncs.js";
import { registerIngestWebhook } from "./ingest/webhook.js";
import { registerGetTrace } from "./tools/getTrace.js";
import { registerTriggerWebhook } from "./runtime/trigger.js";
import { registerSendEventWebhook } from "./runtime/sendEvent.js";
import { registerStepperSync } from "./runtime/stepper.js";

const worker = new Worker();
export default worker;

// Order matters: declare schemas first so capabilities that read DBs by title
// have something to find on first deploy.
const dbs = declareDatabases(worker);

// Attach no-op owner syncs so every managed DB gets provisioned on deploy.
registerOwnerSyncs(worker, dbs);
// Seed syncs own sandboxes + functions DBs; trigger manually to populate.
registerSeedSyncs(worker, dbs);

registerIngestWebhook(worker);
registerGetTrace(worker);
registerTriggerWebhook(worker);
registerSendEventWebhook(worker);
registerStepperSync(worker, { functionRunsDb: dbs.functionRuns });
