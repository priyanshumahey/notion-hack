/**
 * Send an event to the worker's `sendEvent` webhook.
 *
 *   EVENT_NAME=user.signup INPUT_JSON='{"email":"x@y.com"}' npm run send-event
 *
 * Env:
 *   SEND_EVENT_URL  — full webhook URL (e.g. https://workers.notion.com/.../sendEvent)
 *   INGEST_SECRET   — shared HMAC secret (same as the worker uses)
 *   EVENT_NAME      — event name to send (default: `demo.ping`)
 *   EVENT_ID        — caller-supplied id (default: random `evt_<hex>`)
 *   IDEMPOTENCY_KEY — optional dedup key
 *   INPUT_JSON      — JSON object for `data` (default: {})
 */

import crypto from "node:crypto";

const url = process.env.SEND_EVENT_URL;
const secret = process.env.INGEST_SECRET;
if (!url) {
  console.error("✗ SEND_EVENT_URL env var is required");
  process.exit(1);
}
if (!secret) {
  console.error("✗ INGEST_SECRET env var is required");
  process.exit(1);
}

const name = process.env.EVENT_NAME ?? "demo.ping";
const id =
  process.env.EVENT_ID ?? `evt_${crypto.randomBytes(6).toString("hex")}`;
const data = JSON.parse(process.env.INPUT_JSON ?? "{}") as Record<
  string,
  unknown
>;
const idempotencyKey = process.env.IDEMPOTENCY_KEY;

const body = JSON.stringify({
  id,
  name,
  data,
  ...(idempotencyKey ? { idempotencyKey } : {}),
});
const sig = crypto.createHmac("sha256", secret).update(body).digest("hex");

console.log(`POST ${url}`);
console.log(`  name=${name}`);
console.log(`  id=${id}`);
console.log(`  data=${JSON.stringify(data)}`);
if (idempotencyKey) console.log(`  idempotencyKey=${idempotencyKey}`);

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
  `\nEvent queued. Watch Functions · Events for archive, ` +
    `Functions · Runs for fan-out (event id ${id}).`,
);
