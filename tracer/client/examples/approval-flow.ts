/**
 * Approval workflow demo (event-driven waitForEvent).
 *
 * Pre-reqs:
 *   - Worker deployed (post wakes-DB change).
 *   - `seedFunctions` triggered so `approval-flow` exists and is Enabled.
 *   - SEND_EVENT_URL / TRACER_SECRET set in the env.
 *
 * What this does:
 *
 *   1. Fires `approval.requested` with a freshly-minted requestId. The
 *      worker fans out → creates a Functions · Runs row for
 *      `approval-flow` → it sleeps 250ms → parks on
 *      `step.waitForEvent("approval.decided")` filtered by requestId.
 *
 *   2. Sleeps locally ~10s so the human can watch the run flip to
 *      `waiting` in Notion.
 *
 *   3. Fires `approval.decided` with the SAME requestId. The stepper
 *      matches the wake against the parked run, advances past the
 *      waitForEvent step, and runs the final LLM step that drafts an
 *      audit-log line.
 *
 *   4. Result: the Functions · Runs row flips waiting → running →
 *      succeeded, with the LLM's audit line in its Output cell.
 */

import { execFileSync } from "node:child_process";

import { sendEvent } from "../src/index.js";

const url = process.env.SEND_EVENT_URL;
const secret = process.env.TRACER_SECRET;
if (!url || !secret) {
  console.error("Set SEND_EVENT_URL and TRACER_SECRET to run this example.");
  process.exit(1);
}

/** Best-effort manual stepper kick. Avoids the inherent race between
 *  the second event arriving and the parked run being marked `waiting`
 *  by the continuous-schedule stepper tick. Silently noops if `ntn`
 *  isn't on PATH (so this demo still works in CI). */
function kickStepper(): void {
  try {
    execFileSync("ntn", ["workers", "sync", "trigger", "functionStepper"], {
      stdio: "ignore",
      env: { ...process.env, NOTION_API_TOKEN: "" },
    });
  } catch {
    // ignore — manual kick is an optimization, not a requirement.
  }
}

async function sleep(ms: number): Promise<void> {
  await new Promise((r) => setTimeout(r, ms));
}

const requestId = `req_${Date.now().toString(36)}`;

console.log(`→ approval.requested  requestId=${requestId}`);
const a = await sendEvent({
  url,
  secret,
  name: "approval.requested",
  data: {
    requestId,
    requester: "alice@acme.com",
    amount: 5000,
    purpose: "Q4 offsite venue deposit",
  },
});
console.log(`  accepted (HTTP ${a.status}) eventId=${a.eventId}`);
console.log(
  "  open Functions · Runs in Notion — within a few seconds you'll see\n" +
    "  an approval-flow row appear with status=waiting, parked on the\n" +
    `  approval.decided event filtered by requestId=${requestId}`,
);

// Park the run before firing the decision. Each stepper tick advances
// the run by one step:
//   tick 1: pending → sleeping(250ms)
//   tick 2: sleeping → waiting (parked on approval.decided)
// We kick the stepper a few times with short delays to drive both
// transitions, then fire the second event.
console.log("\nDriving the stepper to park the run on waitForEvent…");
for (let i = 0; i < 4; i += 1) {
  await sleep(3_000);
  kickStepper();
}

console.log(`→ approval.decided    requestId=${requestId} decision=approved`);
const b = await sendEvent({
  url,
  secret,
  name: "approval.decided",
  data: {
    requestId,
    decision: "approved",
    decidedBy: "bob@acme.com",
    reason: "Within Q4 discretionary budget",
  },
});
console.log(`  accepted (HTTP ${b.status}) eventId=${b.eventId}`);

// Drive the wake forward: sendEvent has stamped the wake event into
// the parked row's Run State; we now need the stepper to consume it
// and run the final LLM step.
console.log("\nDriving the stepper to consume the wake and run the LLM step…");
for (let i = 0; i < 4; i += 1) {
  await sleep(3_000);
  kickStepper();
}

console.log(
  "\nWithin ~30 seconds the run row should flip waiting → running → succeeded.",
);
console.log(
  "The Output cell will contain a one-line LLM-generated audit summary.",
);
