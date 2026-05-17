/**
 * Local smoke tests. No Notion calls — exercises the pure code paths.
 *
 * Run with:  npx tsx scripts/smoke.ts
 *
 * Covers:
 *   - pricing.ts: known/unknown models, date-suffix stripping, provider norm
 *   - ingest/parse.ts: OTel scopeSpans + flat spans, unix-nano/ms/ISO times,
 *     snake/camel keys, malformed spans skipped, numeric OTel status codes
 *   - ingest/verify.ts: HMAC pass / tamper-fail / wrong-secret
 *   - client end-to-end: Tracer → Transport → mocked fetch, request body
 *     parses correctly with parseBatch and signature verifies with
 *     verifyIngestSignature (the real worker code).
 */

import { costFor, normalizeProvider } from "../src/pricing.js";
import { parseBatch } from "../src/ingest/parse.js";
import {
  verifyIngestSignature,
  SIGNATURE_HEADER,
} from "../src/ingest/verify.js";
import { Tracer } from "../../client/src/index.js";

let passes = 0;
let fails = 0;
const failures: string[] = [];

function ok(name: string, cond: boolean, detail?: unknown): void {
  if (cond) {
    passes++;
    console.log(`  ✓ ${name}`);
  } else {
    fails++;
    const msg = detail !== undefined ? `${name} — ${JSON.stringify(detail)}` : name;
    failures.push(msg);
    console.log(`  ✗ ${msg}`);
  }
}

function eq<T>(name: string, actual: T, expected: T): void {
  ok(name, deepEqual(actual, expected), { actual, expected });
}

function close(name: string, actual: number, expected: number, tol = 1e-9): void {
  ok(name, Math.abs(actual - expected) < tol, { actual, expected, tol });
}

function deepEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (typeof a !== typeof b) return false;
  if (a == null || b == null) return false;
  if (Array.isArray(a) || Array.isArray(b)) {
    if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return false;
    return a.every((x, i) => deepEqual(x, b[i]));
  }
  if (typeof a === "object") {
    const ak = Object.keys(a as object).sort();
    const bk = Object.keys(b as object).sort();
    if (!deepEqual(ak, bk)) return false;
    return ak.every((k) =>
      deepEqual((a as Record<string, unknown>)[k], (b as Record<string, unknown>)[k]),
    );
  }
  return false;
}

/* -------------------------------------------------------------------------- */
/* 1. pricing                                                                  */
/* -------------------------------------------------------------------------- */
console.log("\npricing.ts");

{
  const r = costFor("gpt-4o-2024-08-06", 1_000_000, 1_000_000);
  ok("gpt-4o exact match known", r.known);
  close("gpt-4o cost = $12.50", r.usd, 12.5);
  eq("gpt-4o provider = openai", r.provider, "openai");
}
{
  const r = costFor("gpt-4o-mini", 1000, 500);
  // (1000 * 0.15 + 500 * 0.60) / 1e6 = (150 + 300)/1e6 = 0.00045
  close("gpt-4o-mini cost = $0.00045", r.usd, 0.00045);
}
{
  const r = costFor("claude-3-5-sonnet-20241022", 1_000_000, 1_000_000);
  ok("claude-3-5-sonnet date-stamped match", r.known);
  close("claude sonnet cost = $18.00", r.usd, 18.0);
  eq("claude provider = anthropic", r.provider, "anthropic");
}
{
  // Date-suffix that ISN'T in the table — strip should fall back to gpt-4o.
  const r = costFor("gpt-4o-2099-12-31", 1_000_000, 0);
  ok("date-suffix strip falls back to family", r.known);
  eq("stripped to gpt-4o", r.modelKey, "gpt-4o");
  close("stripped cost = $2.50", r.usd, 2.5);
}
{
  const r = costFor("totally-unknown-model-xyz", 100, 50);
  ok("unknown model -> known=false", !r.known);
  eq("unknown cost = 0", r.usd, 0);
}
{
  const r = costFor("", 100, 50);
  ok("empty model -> known=false", !r.known);
  eq("empty cost = 0", r.usd, 0);
}
{
  const r = costFor("gpt-4o", -50, -10);
  // Negative tokens clamp to 0
  eq("negative tokens clamped to 0 cost", r.usd, 0);
}

eq("normalizeProvider openai", normalizeProvider("OpenAI"), "openai");
eq("normalizeProvider claude->anthropic", normalizeProvider("Claude"), "anthropic");
eq("normalizeProvider gemini->google", normalizeProvider("Gemini"), "google");
eq("normalizeProvider vertex->google", normalizeProvider("vertex"), "google");
eq("normalizeProvider azure_openai->azure", normalizeProvider("azure_openai"), "azure");
eq("normalizeProvider undefined->other", normalizeProvider(undefined), "other");
eq("normalizeProvider null->other", normalizeProvider(null), "other");
eq("normalizeProvider unknown->other", normalizeProvider("cohere"), "other");

/* -------------------------------------------------------------------------- */
/* 2. parse                                                                    */
/* -------------------------------------------------------------------------- */
console.log("\ningest/parse.ts");

{
  // Tracer-native flat shape with ISO times + snake_case.
  const { batch, skipped } = parseBatch({
    resource: { "service.name": "demo" },
    session: { id: "s_1", user_id: "u_1", tags: ["dev"] },
    spans: [
      {
        trace_id: "t_abc",
        span_id: "sp_root",
        parent_span_id: null,
        name: "agent.run",
        kind: "internal",
        status: { code: "ok" },
        started_at: "2026-05-16T12:00:00.000Z",
        ended_at: "2026-05-16T12:00:01.500Z",
        attributes: { "user.id": "u_1" },
        events: [],
      },
    ],
  });
  eq("flat shape: 1 span parsed", batch.spans.length, 1);
  eq("flat shape: 0 skipped", skipped.length, 0);
  eq("flat shape: service from resource", batch.service, "demo");
  eq("flat shape: session id", batch.session?.id, "s_1");
  eq("flat shape: session userId", batch.session?.userId, "u_1");
  eq("flat shape: session tags", batch.session?.tags, ["dev"]);
  eq("flat shape: parentSpanId null", batch.spans[0]!.parentSpanId, null);
  eq("flat shape: status normalized", batch.spans[0]!.status, "ok");
  eq("flat shape: durationMs computed", batch.spans[0]!.durationMs, 1500);
}

{
  // OTel scopeSpans shape with unix-nano times + camelCase keys.
  const startNs = 1747432200000000000;
  const endNs = 1747432212500000000;
  const { batch, skipped } = parseBatch({
    resource: { "service.name": "otel-demo" },
    scopeSpans: [
      {
        spans: [
          {
            traceId: "t_xyz",
            spanId: "sp_1",
            parentSpanId: undefined,
            name: "agent.run",
            kind: "internal",
            status: { code: 1 }, // OTel numeric: 1 = ok
            startTimeUnixNano: startNs,
            endTimeUnixNano: endNs,
            attributes: {},
          },
          {
            traceId: "t_xyz",
            spanId: "sp_2",
            parentSpanId: "sp_1",
            name: "openai.chat",
            kind: "llm",
            status: { code: 2 }, // OTel numeric: 2 = error
            startTimeUnixNano: startNs + 1_000_000_000,
            endTimeUnixNano: startNs + 3_500_000_000,
            attributes: {
              "gen_ai.system": "openai",
              "gen_ai.request.model": "gpt-4o",
            },
          },
        ],
      },
    ],
  });
  eq("otel shape: 2 spans parsed", batch.spans.length, 2);
  eq("otel shape: 0 skipped", skipped.length, 0);
  eq("otel shape: numeric ok->ok", batch.spans[0]!.status, "ok");
  eq("otel shape: numeric 2->error", batch.spans[1]!.status, "error");
  eq("otel shape: kind=llm", batch.spans[1]!.kind, "llm");
  eq(
    "otel shape: nanos->ISO startedAt",
    batch.spans[0]!.startedAt,
    new Date(startNs / 1e6).toISOString(),
  );
  eq(
    "otel shape: parent on child span",
    batch.spans[1]!.parentSpanId,
    "sp_1",
  );
  eq("otel shape: durationMs sp1", batch.spans[0]!.durationMs, 12500);
}

{
  // Malformed spans get SKIPPED, not thrown.
  const { batch, skipped } = parseBatch({
    spans: [
      // missing trace_id
      { span_id: "sp_a", name: "x", started_at: "2026-05-16T12:00:00Z", ended_at: "2026-05-16T12:00:01Z" },
      // missing both times
      { trace_id: "t", span_id: "sp_b", name: "x" },
      // ok
      {
        trace_id: "t_ok",
        span_id: "sp_ok",
        name: "ok",
        started_at: "2026-05-16T12:00:00Z",
        ended_at: "2026-05-16T12:00:01Z",
      },
      // not even an object
      "garbage",
    ],
  });
  eq("malformed: 1 valid parsed", batch.spans.length, 1);
  eq("malformed: 3 skipped", skipped.length, 3);
  eq("malformed: valid span name", batch.spans[0]!.name, "ok");
}

{
  // Millisecond timestamps (some senders use this instead of nanos).
  const startMs = Date.parse("2026-05-16T12:00:00Z");
  const { batch } = parseBatch({
    spans: [
      {
        trace_id: "t",
        span_id: "sp",
        name: "x",
        startTimeUnixNano: startMs, // < 1e16, > 1e12 → treated as ms
        endTimeUnixNano: startMs + 750,
      },
    ],
  });
  eq("ms timestamps parsed", batch.spans[0]!.durationMs, 750);
}

{
  // Unknown kind falls back to "internal".
  const { batch } = parseBatch({
    spans: [
      {
        trace_id: "t",
        span_id: "sp",
        name: "x",
        kind: "bogus-kind",
        started_at: "2026-05-16T12:00:00Z",
        ended_at: "2026-05-16T12:00:01Z",
      },
    ],
  });
  eq("unknown kind -> internal", batch.spans[0]!.kind, "internal");
}

/* -------------------------------------------------------------------------- */
/* 3. verify                                                                   */
/* -------------------------------------------------------------------------- */
console.log("\ningest/verify.ts");

const SECRET = "test-secret-abc123";
process.env.INGEST_SECRET = SECRET;

import * as crypto from "node:crypto";
function sign(body: string, secret = SECRET): string {
  return (
    "sha256=" +
    crypto.createHmac("sha256", secret).update(body).digest("hex")
  );
}

{
  const body = '{"hello":"world"}';
  const sig = sign(body);
  let threw = false;
  try {
    verifyIngestSignature(body, { [SIGNATURE_HEADER]: sig });
  } catch {
    threw = true;
  }
  ok("valid signature passes", !threw);
}

{
  const body = '{"hello":"world"}';
  const sig = sign(body);
  let threw = false;
  try {
    verifyIngestSignature(body + "tampered", { [SIGNATURE_HEADER]: sig });
  } catch {
    threw = true;
  }
  ok("tampered body fails", threw);
}

{
  const body = '{"hello":"world"}';
  const sig = sign(body, "wrong-secret");
  let threw = false;
  try {
    verifyIngestSignature(body, { [SIGNATURE_HEADER]: sig });
  } catch {
    threw = true;
  }
  ok("wrong secret fails", threw);
}

{
  const body = "{}";
  let threw = false;
  try {
    verifyIngestSignature(body, {});
  } catch {
    threw = true;
  }
  ok("missing header fails", threw);
}

{
  const body = "{}";
  let threw = false;
  try {
    verifyIngestSignature(body, { [SIGNATURE_HEADER]: "md5=abc" });
  } catch {
    threw = true;
  }
  ok("wrong scheme fails", threw);
}

{
  // No INGEST_SECRET set → throws.
  delete process.env.INGEST_SECRET;
  let threw = false;
  try {
    verifyIngestSignature("{}", { [SIGNATURE_HEADER]: sign("{}") });
  } catch {
    threw = true;
  }
  ok("missing secret fails", threw);
  process.env.INGEST_SECRET = SECRET;
}

/* -------------------------------------------------------------------------- */
/* 4. End-to-end: Tracer → Transport → fetch → verify + parse                  */
/* -------------------------------------------------------------------------- */
console.log("\ne2e: client → worker pipeline (mocked fetch)");

interface CapturedRequest {
  url: string;
  body: string;
  signature: string;
}

const captured: CapturedRequest[] = [];

const mockFetch: typeof fetch = async (input, init) => {
  const url = typeof input === "string" ? input : (input as URL).toString();
  const body = String((init?.body as string | undefined) ?? "");
  const headers = (init?.headers ?? {}) as Record<string, string>;
  const signature = headers[SIGNATURE_HEADER] ?? "";
  captured.push({ url, body, signature });
  return new Response("", { status: 202 });
};

const tracer = new Tracer({
  url: "https://example.invalid/webhooks/ingest",
  secret: SECRET,
  service: "smoke-test",
  session: { id: "s_smoke", user_id: "u_smoke", tags: ["smoke"] },
  transport: {
    fetchImpl: mockFetch,
    maxBatchAgeMs: 50, // tighten so flush() runs quickly
    onError: (e) => console.error("transport onError:", e.message),
  },
});

await tracer.span("agent.run", async (root) => {
  root.setAttribute("user.id", "u_smoke");
  await tracer.span("step.plan", async (s) => {
    s.addEvent("plan.start");
    await sleep(5);
  });
  await tracer.llm("openai.chat", async (s) => {
    s.recordLLM({
      provider: "openai",
      model: "gpt-4o-mini",
      promptTokens: 100,
      completionTokens: 50,
      prompt: "hello",
      completion: "world",
    });
    await sleep(5);
  });
  await tracer.tool("step.act", async (s) => {
    s.setAttribute("tool.name", "noop");
    await sleep(5);
  });
});

await tracer.shutdown();

eq("e2e: 1 batch sent", captured.length, 1);
const req = captured[0]!;
ok("e2e: url matches", req.url === "https://example.invalid/webhooks/ingest");
ok("e2e: signature header present", req.signature.startsWith("sha256="));

// 4a. verify the actual signature with the worker's real verifier.
{
  let threw = false;
  try {
    verifyIngestSignature(req.body, { [SIGNATURE_HEADER]: req.signature });
  } catch (e) {
    threw = true;
    console.error("verify error:", (e as Error).message);
  }
  ok("e2e: signature verifies with real worker code", !threw);
}

// 4b. parse the body and inspect.
{
  const payload = JSON.parse(req.body) as Record<string, unknown>;
  const { batch, skipped } = parseBatch(payload);
  eq("e2e: 4 spans parsed", batch.spans.length, 4);
  eq("e2e: 0 skipped", skipped.length, 0);

  // The 4 spans, in emit order: step.plan, openai.chat, step.act, agent.run
  // (children flush before parents because we emit on exit).
  const byName = new Map(batch.spans.map((s) => [s.name, s] as const));
  ok("e2e: agent.run present", byName.has("agent.run"));
  ok("e2e: step.plan present", byName.has("step.plan"));
  ok("e2e: openai.chat present", byName.has("openai.chat"));
  ok("e2e: step.act present", byName.has("step.act"));

  const root = byName.get("agent.run")!;
  const plan = byName.get("step.plan")!;
  const llm = byName.get("openai.chat")!;
  const tool = byName.get("step.act")!;

  // All share the same trace.
  const traceId = root.traceId;
  ok("e2e: all spans same trace", batch.spans.every((s) => s.traceId === traceId));

  // Parent/child wiring.
  eq("e2e: root has no parent", root.parentSpanId, null);
  eq("e2e: plan parents to root", plan.parentSpanId, root.spanId);
  eq("e2e: llm parents to root", llm.parentSpanId, root.spanId);
  eq("e2e: tool parents to root", tool.parentSpanId, root.spanId);

  // Kinds.
  eq("e2e: agent.run kind=internal", root.kind, "internal");
  eq("e2e: openai.chat kind=llm", llm.kind, "llm");
  eq("e2e: step.act kind=tool", tool.kind, "tool");

  // LLM attribute mapping from recordLLM.
  eq("e2e: gen_ai.system=openai", llm.attributes["gen_ai.system"], "openai");
  eq(
    "e2e: gen_ai.request.model=gpt-4o-mini",
    llm.attributes["gen_ai.request.model"],
    "gpt-4o-mini",
  );
  eq(
    "e2e: gen_ai.usage.prompt_tokens=100",
    llm.attributes["gen_ai.usage.prompt_tokens"],
    100,
  );
  eq(
    "e2e: gen_ai.usage.completion_tokens=50",
    llm.attributes["gen_ai.usage.completion_tokens"],
    50,
  );

  // Cost computation against the same model.
  const cost = costFor(
    String(llm.attributes["gen_ai.request.model"]),
    Number(llm.attributes["gen_ai.usage.prompt_tokens"]),
    Number(llm.attributes["gen_ai.usage.completion_tokens"]),
  );
  ok("e2e: cost known", cost.known);
  close("e2e: cost = (100*0.15 + 50*0.6)/1e6 = $0.000045", cost.usd, 0.000045);
}

// 4c. tamper the captured body and verify the signature now fails.
{
  let threw = false;
  try {
    verifyIngestSignature(req.body + "x", { [SIGNATURE_HEADER]: req.signature });
  } catch {
    threw = true;
  }
  ok("e2e: tampered body fails verify", threw);
}

/* -------------------------------------------------------------------------- */
/* Summary                                                                     */
/* -------------------------------------------------------------------------- */
console.log(`\n${passes} passed, ${fails} failed`);
if (fails > 0) {
  console.log("\nFailures:");
  for (const f of failures) console.log(`  - ${f}`);
  process.exit(1);
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
