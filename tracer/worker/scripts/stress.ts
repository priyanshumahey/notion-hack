/**
 * Stress test for the workflow runtime — focused on real workflow-automation
 * patterns rather than synthetic hammering.
 *
 * Four scenarios, all asserted against Notion as the source of truth:
 *
 *   1. Throughput        — N parallel `hello-zen` triggers run end-to-end.
 *                          Verifies the stepper handles concurrent runs,
 *                          measures wall-clock + per-request ingress latency.
 *   2. Event fan-out     — N parallel `user.signup` events. Verifies every
 *                          event spawns exactly one `welcome-flow` run row.
 *                          Doesn't wait for the 30s durable sleep to finish.
 *   3. Idempotency       — Same `eventId` sent K times in parallel. Verifies
 *                          exactly ONE run row exists (`run_evt_<id>_welcome-flow`).
 *   4. No-listener event — One event with a name no function listens to.
 *                          Verifies zero runs spawn.
 *
 * Each scenario prints PASS/FAIL + timing. Exit code is non-zero on any fail.
 *
 * Env (typically loaded from .env.local):
 *   SEND_EVENT_URL   — sendEvent webhook URL
 *   TRIGGER_URL      — triggerFunction webhook URL
 *   INGEST_SECRET    — HMAC secret shared with the worker
 *   NOTION_API_TOKEN — for polling Functions · Runs
 *
 * Tune via env (all optional):
 *   STRESS_BURST     — runs per scenario, default 10
 *   STRESS_TIMEOUT_S — max wait for completion polling, default 120
 *   STRESS_SKIP_T1   — set to "1" to skip the long throughput phase
 *
 * Usage:
 *   set -a && source .env.local && set +a
 *   npx tsx scripts/stress.ts
 */

import crypto from "node:crypto";
import { setTimeout as sleep } from "node:timers/promises";
import { Client as NotionClient } from "@notionhq/client";

/* -------------------------------------------------------------------------- */
/* Setup                                                                       */
/* -------------------------------------------------------------------------- */

function req(name: string): string {
  const v = process.env[name];
  if (!v) {
    console.error(`✗ ${name} env var is required`);
    process.exit(1);
  }
  return v;
}

const SEND_EVENT_URL = req("SEND_EVENT_URL");
const TRIGGER_URL = req("TRIGGER_URL");
const SECRET = req("INGEST_SECRET");
const NOTION_TOKEN = req("NOTION_API_TOKEN");

const BURST = Number.parseInt(process.env.STRESS_BURST ?? "10", 10);
// Default 6m: stepper schedule=1m × MAX_RUNS_PER_TICK=5 × 2 steps in hello-zen
// → ~4m to drain 10 runs in worst case. Add buffer for cold start.
const TIMEOUT_S = Number.parseInt(process.env.STRESS_TIMEOUT_S ?? "360", 10);
const SKIP_T1 = process.env.STRESS_SKIP_T1 === "1";

const notion = new NotionClient({ auth: NOTION_TOKEN });

let passed = 0;
let failed = 0;
const failures: string[] = [];

function ok(name: string, cond: boolean, detail?: string): void {
  if (cond) {
    passed += 1;
    console.log(`  ✓ ${name}${detail ? ` — ${detail}` : ""}`);
  } else {
    failed += 1;
    failures.push(`${name}${detail ? ` — ${detail}` : ""}`);
    console.log(`  ✗ ${name}${detail ? ` — ${detail}` : ""}`);
  }
}

function hmac(body: string): string {
  return crypto.createHmac("sha256", SECRET).update(body).digest("hex");
}

interface PostResult {
  status: number;
  ok: boolean;
  latencyMs: number;
}

async function postSigned(url: string, body: object): Promise<PostResult> {
  const raw = JSON.stringify(body);
  const sig = hmac(raw);
  const t0 = performance.now();
  const res = await fetch(url, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-tracer-signature": `sha256=${sig}`,
    },
    body: raw,
  });
  // Drain body so the connection can be reused / closed cleanly.
  await res.arrayBuffer();
  return {
    status: res.status,
    ok: res.ok,
    latencyMs: Math.round(performance.now() - t0),
  };
}

function pct(arr: number[], p: number): number {
  if (arr.length === 0) return 0;
  const sorted = [...arr].sort((a, b) => a - b);
  const idx = Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length));
  return sorted[idx]!;
}

function latencyLine(latencies: number[]): string {
  return (
    `min=${Math.min(...latencies)}ms ` +
    `p50=${pct(latencies, 50)}ms ` +
    `p95=${pct(latencies, 95)}ms ` +
    `max=${Math.max(...latencies)}ms`
  );
}

/* -------------------------------------------------------------------------- */
/* Notion DB discovery + polling                                               */
/* -------------------------------------------------------------------------- */

const dbCache = new Map<string, string>();

async function discoverDb(title: string): Promise<string> {
  if (dbCache.has(title)) return dbCache.get(title)!;
  // Search by the prefix before "·" — Notion's search struggles with the dot.
  const prefix = title.split("·")[0]!.trim();
  const res = await notion.search({
    query: prefix,
    filter: { property: "object", value: "database" },
    page_size: 50,
  });
  for (const r of res.results) {
    if (r.object !== "database") continue;
    const t =
      "title" in r
        ? r.title.map((x: { plain_text?: string }) => x.plain_text ?? "").join("")
        : "";
    if (t.trim() === title) {
      dbCache.set(title, r.id);
      return r.id;
    }
  }
  throw new Error(`Notion DB not found: ${title}`);
}

interface RunRow {
  runId: string;
  status: string;
  cursor: number | null;
  startedAt: string | null;
  endedAt: string | null;
}

function rtOf(props: Record<string, unknown>, key: string): string {
  const p = props[key] as { rich_text?: Array<{ plain_text?: string }> } | undefined;
  return (p?.rich_text ?? []).map((x) => x.plain_text ?? "").join("");
}
function selOf(props: Record<string, unknown>, key: string): string {
  const p = props[key] as { select?: { name?: string } } | undefined;
  return p?.select?.name ?? "";
}
function numOf(
  props: Record<string, unknown>,
  key: string,
): number | null {
  const p = props[key] as { number?: number | null } | undefined;
  return p?.number ?? null;
}
function dateOf(
  props: Record<string, unknown>,
  key: string,
): string | null {
  const p = props[key] as { date?: { start?: string } | null } | undefined;
  return p?.date?.start ?? null;
}

/** Returns ALL rows matching any of the given Run IDs (no JS-level dedup,
 *  because rows with duplicate Run IDs are themselves the bug we're testing
 *  for). */
async function fetchRunsByIds(
  runsDb: string,
  runIds: string[],
): Promise<RunRow[]> {
  const out: RunRow[] = [];
  const CHUNK = 90; // Notion `or` filter cap
  for (let i = 0; i < runIds.length; i += CHUNK) {
    const slice = runIds.slice(i, i + CHUNK);
    let cursor: string | undefined;
    do {
      const res = await notion.databases.query({
        database_id: runsDb,
        start_cursor: cursor,
        page_size: 100,
        filter: {
          or: slice.map((rid) => ({
            property: "Run ID",
            rich_text: { equals: rid },
          })),
        },
      });
      for (const row of res.results) {
        if (!("properties" in row)) continue;
        const props = row.properties as Record<string, unknown>;
        const rid = rtOf(props, "Run ID");
        if (!rid) continue;
        out.push({
          runId: rid,
          status: selOf(props, "Status"),
          cursor: numOf(props, "Step Cursor"),
          startedAt: dateOf(props, "Started At"),
          endedAt: dateOf(props, "Ended At"),
        });
      }
      cursor = res.has_more ? res.next_cursor ?? undefined : undefined;
    } while (cursor);
  }
  return out;
}

/** Unique Run IDs covered by the returned rows. */
function uniqueIds(rows: RunRow[]): Set<string> {
  return new Set(rows.map((r) => r.runId));
}

async function pollUntil(
  predicate: () => Promise<boolean>,
  timeoutS: number,
  intervalMs = 1500,
): Promise<boolean> {
  const deadline = Date.now() + timeoutS * 1000;
  while (Date.now() < deadline) {
    if (await predicate()) return true;
    await sleep(intervalMs);
  }
  return false;
}

const TERMINAL = new Set(["succeeded", "failed", "cancelled"]);

function summarizeStatus(rows: RunRow[]): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const r of rows) {
    counts[r.status] = (counts[r.status] ?? 0) + 1;
  }
  return counts;
}

/* -------------------------------------------------------------------------- */
/* Test runner                                                                 */
/* -------------------------------------------------------------------------- */

async function main(): Promise<void> {
  console.log("=== Tracer Stress Test ===");
  console.log(`  burst size:       ${BURST}`);
  console.log(`  poll timeout:     ${TIMEOUT_S}s`);
  console.log(`  skip throughput:  ${SKIP_T1 ? "yes" : "no"}`);

  console.log("\n→ discovering Notion DBs…");
  const runsDb = await discoverDb("Functions · Runs");
  console.log(`  Functions · Runs = ${runsDb}`);

  const runStamp = `stress_${Date.now()}`;

  /* ---------------------------------------------------------------------- */
  /* Scenario 1: throughput — N parallel hello-zen triggers                 */
  /* ---------------------------------------------------------------------- */
  if (!SKIP_T1) {
    console.log(`\n[1/4] Throughput: hello-zen × ${BURST} parallel triggers`);
    const triggerIds = Array.from(
      { length: BURST },
      (_, i) => `run_${runStamp}_h${i}`,
    );
    const t0 = performance.now();
    const responses = await Promise.all(
      triggerIds.map((rid) =>
        postSigned(TRIGGER_URL, {
          functionKey: "hello-zen",
          runId: rid,
          input: { burst: runStamp, idx: rid },
        }),
      ),
    );
    const submitMs = Math.round(performance.now() - t0);
    const accepted = responses.filter((r) => r.ok).length;
    const latencies = responses.map((r) => r.latencyMs);
    ok(
      `webhooks accepted ${accepted}/${BURST}`,
      accepted === BURST,
      `total=${submitMs}ms, ${latencyLine(latencies)}`,
    );

    const allDone = await pollUntil(async () => {
      const rows = await fetchRunsByIds(runsDb, triggerIds);
      const ids = uniqueIds(rows);
      if (ids.size < BURST) return false;
      for (const r of rows) {
        if (!TERMINAL.has(r.status)) return false;
      }
      return true;
    }, TIMEOUT_S);

    const finalRows = await fetchRunsByIds(runsDb, triggerIds);
    const e2eMs = Math.round(performance.now() - t0);
    const counts = summarizeStatus(finalRows);
    const succeeded = counts["succeeded"] ?? 0;
    ok(
      `all ${BURST} runs reached succeeded`,
      succeeded === BURST,
      `e2e=${e2eMs}ms, statuses=${JSON.stringify(counts)}`,
    );
    if (!allDone) {
      ok(
        "throughput phase finished before timeout",
        false,
        `${TIMEOUT_S}s timeout hit, still=${JSON.stringify(counts)}`,
      );
    } else {
      const throughput = ((succeeded / e2eMs) * 1000).toFixed(2);
      console.log(`  ↳ throughput ≈ ${throughput} runs/sec`);
    }
  } else {
    console.log("\n[1/4] Throughput phase SKIPPED (STRESS_SKIP_T1=1)");
  }

  /* ---------------------------------------------------------------------- */
  /* Scenario 2: event fan-out — N parallel user.signup events              */
  /* ---------------------------------------------------------------------- */
  console.log(
    `\n[2/4] Event fan-out: user.signup × ${BURST} parallel events`,
  );
  const eventIds = Array.from(
    { length: BURST },
    (_, i) => `evt_${runStamp}_s${i}`,
  );
  const expectedRunIds = eventIds.map((eid) => `run_evt_${eid}_welcome-flow`);

  const t1 = performance.now();
  const evResponses = await Promise.all(
    eventIds.map((eid) =>
      postSigned(SEND_EVENT_URL, {
        id: eid,
        name: "user.signup",
        data: { email: `${eid}@example.com`, burst: runStamp },
      }),
    ),
  );
  const evSubmitMs = Math.round(performance.now() - t1);
  const evAccepted = evResponses.filter((r) => r.ok).length;
  const evLatencies = evResponses.map((r) => r.latencyMs);
  ok(
    `event webhooks accepted ${evAccepted}/${BURST}`,
    evAccepted === BURST,
    `total=${evSubmitMs}ms, ${latencyLine(evLatencies)}`,
  );

  // Poll until all N distinct welcome-flow runs exist (status doesn't matter
  // — we just care that the fan-out materialized rows in Notion).
  const fanoutSettled = await pollUntil(async () => {
    const rows = await fetchRunsByIds(runsDb, expectedRunIds);
    return uniqueIds(rows).size >= BURST;
  }, 30);
  const fanoutRows = await fetchRunsByIds(runsDb, expectedRunIds);
  const fanoutUnique = uniqueIds(fanoutRows);
  ok(
    `${BURST} distinct welcome-flow run rows materialized`,
    fanoutUnique.size === BURST,
    `unique=${fanoutUnique.size}, total rows=${fanoutRows.length}, statuses=${JSON.stringify(summarizeStatus(fanoutRows))}`,
  );
  // Each unique Run ID should appear exactly once (no concurrent-create dupes).
  const fanoutDupes = fanoutRows.length - fanoutUnique.size;
  ok(
    `fan-out created no duplicate rows (race-free)`,
    fanoutDupes === 0,
    `dupes=${fanoutDupes}`,
  );
  if (!fanoutSettled) {
    ok(
      "fan-out materialization finished before timeout",
      false,
      "30s timeout hit",
    );
  }
  // Quick health check: every row should at least have a Status set.
  const blanks = fanoutRows.filter((r) => !r.status).length;
  ok(`every fanned-out row has a Status`, blanks === 0, `blanks=${blanks}`);

  /* ---------------------------------------------------------------------- */
  /* Scenario 3: idempotency — same eventId sent K times in parallel        */
  /* ---------------------------------------------------------------------- */
  const IDEM_K = Number.parseInt(process.env.STRESS_IDEM_K ?? "16", 10);
  const idemId = `evt_${runStamp}_idem`;
  const idemRunId = `run_evt_${idemId}_welcome-flow`;
  console.log(
    `\n[3/4] Idempotency: same eventId × ${IDEM_K} parallel submits`,
  );
  const idemPayload = {
    id: idemId,
    name: "user.signup",
    data: { email: "idem@example.com", burst: runStamp },
  };
  const idemResponses = await Promise.all(
    Array.from({ length: IDEM_K }, () =>
      postSigned(SEND_EVENT_URL, idemPayload),
    ),
  );
  const idemAccepted = idemResponses.filter((r) => r.ok).length;
  ok(
    `idempotent submits accepted ${idemAccepted}/${IDEM_K}`,
    idemAccepted === IDEM_K,
  );

  // Give the worker a moment to settle any race between concurrent fan-outs.
  await sleep(3500);

  // Count ALL rows matching the synthesized Run ID PK — there should be
  // exactly one. (Don't dedup in JS; that would hide the race.)
  const idemRows = await fetchRunsByIds(runsDb, [idemRunId]);
  ok(
    `exactly 1 row with Run ID = run_evt_<id>_welcome-flow`,
    idemRows.length === 1,
    `got=${idemRows.length} rows, ${uniqueIds(idemRows).size} distinct Run IDs`,
  );

  // Belt-and-braces: query by Source Event ID — same expectation.
  const bySourceEvt = await notion.databases.query({
    database_id: runsDb,
    filter: {
      property: "Source Event ID",
      rich_text: { equals: idemId },
    },
    page_size: 25,
  });
  ok(
    `Source Event ID search returns exactly 1 row`,
    bySourceEvt.results.length === 1,
    `got=${bySourceEvt.results.length}`,
  );

  /* ---------------------------------------------------------------------- */
  /* Scenario 4: no-listener event — should spawn 0 runs                    */
  /* ---------------------------------------------------------------------- */
  console.log(`\n[4/4] No-listener event: stress.no_listener × 1`);
  const noiseId = `evt_${runStamp}_noise`;
  const noiseRes = await postSigned(SEND_EVENT_URL, {
    id: noiseId,
    name: "stress.no_listener",
    data: { burst: runStamp },
  });
  ok(`event accepted`, noiseRes.ok, `status=${noiseRes.status}`);
  await sleep(3000);
  const noiseRuns = await notion.databases.query({
    database_id: runsDb,
    filter: {
      property: "Source Event ID",
      rich_text: { equals: noiseId },
    },
    page_size: 5,
  });
  ok(
    `no runs spawned for unmatched event`,
    noiseRuns.results.length === 0,
    `got=${noiseRuns.results.length}`,
  );

  /* ---------------------------------------------------------------------- */
  /* Summary                                                                 */
  /* ---------------------------------------------------------------------- */
  console.log(`\n=== Summary ===`);
  console.log(`  ${passed} passed, ${failed} failed`);
  if (failures.length) {
    console.log(`\nFailures:`);
    for (const f of failures) console.log(`  - ${f}`);
  }
  console.log(
    `\nTip: run \`python3 scripts/inspect_runs.py\` to inspect the rows ` +
      `this test created (filter by Run ID prefix \`${runStamp}\` ` +
      `or Source Event ID prefix \`evt_${runStamp}\`).`,
  );
  process.exit(failed === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error("stress test crashed:", err);
  process.exit(2);
});
