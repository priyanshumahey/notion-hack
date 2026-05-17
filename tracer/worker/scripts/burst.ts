#!/usr/bin/env node
/**
 * Fire-and-forget burst:
 *   - N hello-zen triggers
 *   - M user.signup events
 *   - All in parallel, no polling.
 *
 * Reports per-request HTTP status histogram. Watch for 429s.
 *
 * Env: SEND_EVENT_URL, TRIGGER_URL, INGEST_SECRET
 * Args: [hello_count=20] [signup_count=20]
 */
import crypto from "node:crypto";

const SEND_EVENT_URL = process.env.SEND_EVENT_URL!;
const TRIGGER_URL = process.env.TRIGGER_URL!;
const SECRET = process.env.INGEST_SECRET!;
if (!SEND_EVENT_URL || !TRIGGER_URL || !SECRET) {
  console.error("✗ require SEND_EVENT_URL, TRIGGER_URL, INGEST_SECRET");
  process.exit(1);
}

const HELLO_N = Number.parseInt(process.argv[2] ?? "20", 10);
const SIGNUP_N = Number.parseInt(process.argv[3] ?? "20", 10);

function sign(body: string): string {
  return (
    "sha256=" + crypto.createHmac("sha256", SECRET).update(body).digest("hex")
  );
}

async function post(
  url: string,
  body: Record<string, unknown>,
): Promise<{ status: number; ms: number }> {
  const json = JSON.stringify(body);
  const t0 = Date.now();
  const res = await fetch(url, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-tracer-signature": sign(json),
    },
    body: json,
  });
  return { status: res.status, ms: Date.now() - t0 };
}

const ts = Date.now();
const helloPromises = Array.from({ length: HELLO_N }, (_, i) =>
  post(TRIGGER_URL, {
    functionKey: "hello-zen",
    input: { i, ts },
  }),
);
const signupPromises = Array.from({ length: SIGNUP_N }, (_, i) =>
  post(SEND_EVENT_URL, {
    name: "user.signup",
    data: { email: `burst+${ts}+${i}@example.com`, plan: "pro" },
  }),
);

console.log(
  `firing ${HELLO_N} hello-zen + ${SIGNUP_N} user.signup = ${HELLO_N + SIGNUP_N} total…`,
);
const t0 = Date.now();
const all = await Promise.all([...helloPromises, ...signupPromises]);
const elapsed = Date.now() - t0;

const hist: Record<number, number> = {};
let totalMs = 0;
let maxMs = 0;
for (const r of all) {
  hist[r.status] = (hist[r.status] ?? 0) + 1;
  totalMs += r.ms;
  if (r.ms > maxMs) maxMs = r.ms;
}
console.log(`done in ${elapsed}ms (wall clock for all ${all.length} requests)`);
console.log(
  `  per-request: avg=${(totalMs / all.length).toFixed(0)}ms  max=${maxMs}ms`,
);
console.log(`  status histogram:`, hist);
if (hist[429]) console.log(`  ⚠ ${hist[429]} rate-limited (429)`);
const ok = (hist[200] ?? 0) + (hist[201] ?? 0) + (hist[202] ?? 0);
const fail = all.length - ok;
if (fail > 0) {
  console.log(`  ✗ ${fail} non-2xx responses`);
  process.exit(1);
}
console.log(`  ✓ all ${ok} requests accepted`);
