/**
 * Event-driven flow demo (Inngest/Trigger.dev-style).
 *
 * Pre-reqs:
 *   - Worker deployed; `seedFunctions` sync triggered so `welcome-flow`
 *     exists and is Enabled.
 *   - SEND_EVENT_URL / TRACER_SECRET set in the env.
 *
 * What this does:
 *
 *   1. Fires a `user.signup` event. The worker's stepper picks it up and
 *      creates a Functions · Runs row for `welcome-flow`.
 *   2. The run sleeps 5s, then `sendEvent`s `user.welcomed` from the
 *      worker, then parks on `step.waitForEvent("user.confirmed")`.
 *   3. We sleep 10s locally, then fire `user.confirmed`. The router wakes
 *      the parked run and it completes.
 *
 *   Watch progress in Notion: filter Functions · Runs by your run id, or
 *   tail `ntn workers runs list --plain` for stepper logs.
 */

import { sendEvent } from "../src/index.js";

const url = process.env.SEND_EVENT_URL;
const secret = process.env.TRACER_SECRET;
if (!url || !secret) {
  console.error("Set SEND_EVENT_URL and TRACER_SECRET to run this example.");
  process.exit(1);
}

const email = `demo+${Date.now()}@example.com`;

console.log(`→ user.signup    email=${email}`);
const a = await sendEvent({
  url,
  secret,
  name: "user.signup",
  data: { email, plan: "pro" },
});
console.log(`  accepted (HTTP ${a.status}) eventId=${a.eventId}`);

console.log(
  "  worker will: sleep 5s, sendEvent user.welcomed, then waitForEvent user.confirmed",
);
console.log("  (open Functions · Runs in Notion to watch the row advance)");

console.log("\nSleeping 10s locally before firing confirm…");
await new Promise((r) => setTimeout(r, 10_000));

console.log(`→ user.confirmed email=${email}`);
const b = await sendEvent({
  url,
  secret,
  name: "user.confirmed",
  data: { email },
});
console.log(`  accepted (HTTP ${b.status}) eventId=${b.eventId}`);

console.log(
  "\nWithin ~1 minute the run row should flip waiting → running → succeeded.",
);
