/**
 * Trigger a function run by POSTing to the worker's `triggerFunction` webhook.
 *
 *   FUNCTION_KEY=hello-zen npm run trigger
 *
 * Env:
 *   TRIGGER_URL    — full webhook URL (e.g. https://workers.notion.com/.../triggerFunction)
 *   INGEST_SECRET  — shared HMAC secret (same as the worker uses)
 *   FUNCTION_KEY   — which function to start (default: hello-zen)
 *   RUN_ID         — caller-supplied idempotency key (default: random)
 *   INPUT_JSON     — JSON string to pass as the function input (default: {})
 *
 * Note: the webhook returns void; runId is logged by the worker. To follow
 * the run, query the `Functions · Runs` Notion DB with the runId printed by
 * this script as the idempotency key.
 */

import crypto from "node:crypto";

const url = process.env.TRIGGER_URL;
const secret = process.env.INGEST_SECRET;
if (!url) {
  console.error("✗ TRIGGER_URL env var is required");
  process.exit(1);
}
if (!secret) {
  console.error("✗ INGEST_SECRET env var is required");
  process.exit(1);
}

const functionKey = process.env.FUNCTION_KEY ?? "hello-zen";
const runId =
  process.env.RUN_ID ??
  `run_${crypto.randomBytes(8).toString("hex")}`;
const input = JSON.parse(process.env.INPUT_JSON ?? "{}") as Record<string, unknown>;

const body = JSON.stringify({ functionKey, runId, input });
const sig = crypto.createHmac("sha256", secret).update(body).digest("hex");

console.log(`POST ${url}`);
console.log(`  functionKey=${functionKey}`);
console.log(`  runId=${runId}`);
console.log(`  input=${JSON.stringify(input)}`);

const res = await fetch(url, {
  method: "POST",
  headers: {
    "content-type": "application/json",
    "x-tracer-signature": `sha256=${sig}`,
  },
  body,
});
const text = await res.text();
console.log(`\n→ ${res.status} ${res.statusText}`);
if (text.trim()) console.log(text);

if (!res.ok) process.exit(1);
console.log(
  `\nRun queued. Open the "Functions · Runs" Notion DB and filter Run ID = ${runId} to watch it advance.`,
);
