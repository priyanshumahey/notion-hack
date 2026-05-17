/**
 * Runtime + tracer-behavior smoke tests. Pure code paths only.
 *
 * Run with:  npx tsx scripts/smoke-runtime.ts
 *
 * Covers:
 *   - runtime/steps.ts: interpolateStep (state.x.y, auto-descent into
 *     .result, missing paths → "", input access, JSON.stringify for
 *     non-strings, headers/array substitution, multiple matches in one
 *     string).
 *   - runtime/steps.ts: executeStep happy paths for `delay` (real),
 *     `http` (mocked global fetch), `llm` (mocked global fetch + missing
 *     key path).
 *   - runtime/sendEvent.ts: eventNameMatches — exact, "*" wildcard,
 *     "prefix.*" (prefix exact AND descendant), non-match, empty pattern.
 *   - ingest/upsert.ts: aggregateTrace (spanCount/errorCount/totalTokens/
 *     costUsd/durationMs across mixed-kind spans) and extractLLM
 *     (provider hint, alt-token-key aliases, missing model).
 *   - client Tracer: nested spans share traceId + correct parentSpanId,
 *     thrown error → status="error" + errorMessage, setStatus override,
 *     recordLLM stamps kind=llm and the standard attributes.
 *   - client Transport: size-triggered flush, retry-once on transient
 *     fetch failure, onError fires only on persistent failure.
 */

import { interpolateStep } from "../src/runtime/steps.js";
import { executeStep } from "../src/runtime/steps.js";
import type { Step, RunState } from "../src/runtime/types.js";
import { eventNameMatches } from "../src/runtime/sendEvent.js";
import { aggregateTrace, extractLLM } from "../src/ingest/upsert.js";
import type { Span } from "../src/types.js";
import { Tracer } from "../../client/src/index.js";
import { Transport, SIGNATURE_HEADER } from "../../client/src/transport.js";

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

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/* -------------------------------------------------------------------------- */
/* 1. interpolateStep                                                          */
/* -------------------------------------------------------------------------- */
console.log("\nruntime/steps.ts · interpolateStep");

function mkState(steps: RunState["steps"], input: RunState["input"] = {}): RunState {
  return { steps, input };
}

{
  // Basic step-result substitution: auto-descends from step → result.
  const step: Step = {
    id: "post",
    type: "http",
    url: "https://api.example.com/${state.fetch.id}",
    method: "POST",
    body: { name: "${state.fetch.name}", count: "${state.fetch.count}" },
  };
  const state = mkState({
    fetch: { status: "ok", durationMs: 1, result: { id: "abc", name: "Alice", count: 7 } },
  });
  const out = interpolateStep(step, state) as typeof step;
  eq("url substituted from step result", out.url, "https://api.example.com/abc");
  eq("body string field substituted", (out.body as { name: string }).name, "Alice");
  // Non-strings come through as JSON.stringify so they survive into the
  // body intact — `count: "${...}"` becomes the string "7".
  eq("body numeric coerced to JSON string", (out.body as { count: string }).count, "7");
}

{
  // ${state.input.X} reaches into the run's input, not steps.
  const step: Step = {
    id: "log",
    type: "http",
    url: "https://hooks.example.com/${state.input.userId}",
    method: "POST",
    body: { email: "${state.input.email}" },
  };
  const state = mkState({}, { userId: "u_42", email: "alice@example.com" });
  const out = interpolateStep(step, state) as typeof step;
  eq("input.userId substituted", out.url, "https://hooks.example.com/u_42");
  eq("input.email substituted", (out.body as { email: string }).email, "alice@example.com");
}

{
  // Missing path → empty string.
  const step: Step = {
    id: "post",
    type: "http",
    url: "https://x/${state.missing.field}",
    method: "GET",
  };
  const out = interpolateStep(step, mkState({})) as typeof step;
  eq("missing path → empty string", out.url, "https://x/");
}

{
  // Multiple ${...} in one string.
  const step: Step = {
    id: "post",
    type: "http",
    url: "https://x/${state.a.x}/${state.b.y}?z=${state.input.z}",
    method: "GET",
  };
  const state = mkState(
    {
      a: { status: "ok", durationMs: 0, result: { x: "AX" } },
      b: { status: "ok", durationMs: 0, result: { y: "BY" } },
    },
    { z: "ZZ" },
  );
  const out = interpolateStep(step, state) as typeof step;
  eq("multiple substitutions in one string", out.url, "https://x/AX/BY?z=ZZ");
}

{
  // Headers + nested objects substitute.
  const step: Step = {
    id: "post",
    type: "http",
    url: "https://x",
    method: "POST",
    headers: { authorization: "Bearer ${state.input.token}" },
    body: { meta: { id: "${state.fetch.id}" } },
  };
  const state = mkState(
    { fetch: { status: "ok", durationMs: 0, result: { id: "T1" } } },
    { token: "tok_abc" },
  );
  const out = interpolateStep(step, state) as typeof step;
  eq("header substituted", out.headers?.authorization, "Bearer tok_abc");
  eq(
    "deep-nested body substituted",
    (out.body as { meta: { id: string } }).meta.id,
    "T1",
  );
}

{
  // Step output that is itself the entire object (no auto-descent past id).
  // `${state.fetch}` (no further path) should yield the JSON of the result.
  const step: Step = {
    id: "post",
    type: "http",
    url: "https://x?dump=${state.fetch}",
    method: "GET",
  };
  const state = mkState({
    fetch: { status: "ok", durationMs: 0, result: { a: 1, b: 2 } },
  });
  const out = interpolateStep(step, state) as typeof step;
  // After auto-descent, ${state.fetch} resolves to {a:1,b:2} → JSON.
  eq(
    "step-only ref serializes result object as JSON",
    out.url,
    'https://x?dump={"a":1,"b":2}',
  );
}

/* -------------------------------------------------------------------------- */
/* 2. executeStep                                                              */
/* -------------------------------------------------------------------------- */
console.log("\nruntime/steps.ts · executeStep");

const originalFetch = globalThis.fetch;
function installMockFetch(impl: typeof fetch): void {
  globalThis.fetch = impl;
}
function restoreFetch(): void {
  globalThis.fetch = originalFetch;
}

{
  // delay: real setTimeout, but tiny.
  const out = await executeStep(
    { id: "wait", type: "delay", ms: 10 },
    mkState({}),
    { runId: "r", traceId: "t", openaiKey: undefined },
  );
  eq("delay status=ok", out.status, "ok");
  ok("delay durationMs >= 10", (out.durationMs ?? 0) >= 10);
  eq("delay result.waited == 10", (out.result as { waited: number }).waited, 10);
}

{
  // delay clamps to ≤ 60 000 ms.
  const startedAt = Date.now();
  const out = await executeStep(
    { id: "wait", type: "delay", ms: 1_000_000 },
    mkState({}),
    { runId: "r", traceId: "t", openaiKey: undefined },
  );
  const elapsed = Date.now() - startedAt;
  ok("delay clamps very-large ms (returns quickly relative to ms)", elapsed < 61_000);
  eq("delay clamp result.waited == 60_000", (out.result as { waited: number }).waited, 60_000);
}

{
  // http 200 success path with interpolation through executeStep.
  let capturedUrl = "";
  let capturedBody: unknown = null;
  installMockFetch((async (input, init) => {
    capturedUrl = typeof input === "string" ? input : (input as URL).toString();
    capturedBody = init?.body ? JSON.parse(String(init.body)) : null;
    return new Response(JSON.stringify({ ok: true, id: "X" }), { status: 200 });
  }) as typeof fetch);
  try {
    const out = await executeStep(
      {
        id: "post",
        type: "http",
        url: "https://api/${state.input.uid}",
        method: "POST",
        body: { hi: "${state.input.greet}" },
      },
      mkState({}, { uid: "u_42", greet: "hello" }),
      { runId: "r", traceId: "t", openaiKey: undefined },
    );
    eq("http 200 status=ok", out.status, "ok");
    eq("http url interpolated", capturedUrl, "https://api/u_42");
    eq("http body interpolated", capturedBody, { hi: "hello" });
    eq(
      "http response body captured",
      (out.result as { body: string }).body,
      '{"ok":true,"id":"X"}',
    );
    eq("http response status captured", (out.result as { status: number }).status, 200);
  } finally {
    restoreFetch();
  }
}

{
  // http non-2xx flips to error but still captures the body.
  installMockFetch((async () => new Response("oops", { status: 503 })) as typeof fetch);
  try {
    const out = await executeStep(
      { id: "post", type: "http", url: "https://x", method: "GET" },
      mkState({}),
      { runId: "r", traceId: "t", openaiKey: undefined },
    );
    eq("http 503 status=error", out.status, "error");
    eq("http 503 error message includes status", out.error, "HTTP 503");
    eq(
      "http 503 result.body still captured",
      (out.result as { body: string }).body,
      "oops",
    );
  } finally {
    restoreFetch();
  }
}

{
  // llm without OPENAI_API_KEY → structured error, no fetch issued.
  let fetched = false;
  installMockFetch((async () => {
    fetched = true;
    return new Response("", { status: 200 });
  }) as typeof fetch);
  try {
    const out = await executeStep(
      { id: "say", type: "llm", model: "gpt-4o-mini", prompt: "hi" },
      mkState({}),
      { runId: "r", traceId: "t", openaiKey: undefined },
    );
    eq("llm no key → status=error", out.status, "error");
    ok(
      "llm no key → error mentions OPENAI_API_KEY",
      typeof out.error === "string" && out.error.includes("OPENAI_API_KEY"),
    );
    ok("llm no key → did NOT call fetch", !fetched);
  } finally {
    restoreFetch();
  }
}

{
  // llm happy path with mocked OpenAI response.
  let capturedUrl = "";
  let capturedBody: { model?: string; messages?: Array<{ role: string; content: string }> } = {};
  installMockFetch((async (input, init) => {
    capturedUrl = typeof input === "string" ? input : (input as URL).toString();
    capturedBody = JSON.parse(String(init?.body ?? "{}"));
    return new Response(
      JSON.stringify({
        choices: [{ message: { content: "hello back" } }],
        usage: { prompt_tokens: 12, completion_tokens: 5 },
        model: "gpt-4o-mini-2024-07-18",
      }),
      { status: 200 },
    );
  }) as typeof fetch);
  try {
    const out = await executeStep(
      {
        id: "say",
        type: "llm",
        model: "gpt-4o-mini",
        system: "You are terse.",
        prompt: "Say hi to ${state.input.name}",
      },
      mkState({}, { name: "Alice" }),
      { runId: "r", traceId: "t", openaiKey: "sk-fake" },
    );
    eq("llm ok status", out.status, "ok");
    eq("llm endpoint", capturedUrl, "https://api.openai.com/v1/chat/completions");
    eq("llm body.model", capturedBody.model, "gpt-4o-mini");
    eq(
      "llm body has system + user with interpolation",
      capturedBody.messages,
      [
        { role: "system", content: "You are terse." },
        { role: "user", content: "Say hi to Alice" },
      ],
    );
    const result = out.result as {
      content: string;
      promptTokens: number;
      completionTokens: number;
      totalTokens: number;
    };
    eq("llm result.content", result.content, "hello back");
    eq("llm result.promptTokens", result.promptTokens, 12);
    eq("llm result.completionTokens", result.completionTokens, 5);
    eq("llm result.totalTokens", result.totalTokens, 17);
  } finally {
    restoreFetch();
  }
}

/* -------------------------------------------------------------------------- */
/* 3. eventNameMatches                                                         */
/* -------------------------------------------------------------------------- */
console.log("\nruntime/sendEvent.ts · eventNameMatches");

eq("exact match", eventNameMatches("user.signup", "user.signup"), true);
eq("different names don't match", eventNameMatches("user.signup", "user.deleted"), false);
eq("wildcard '*' matches anything", eventNameMatches("*", "anything.here"), true);
eq("'user.*' matches 'user.signup'", eventNameMatches("user.*", "user.signup"), true);
eq("'user.*' matches 'user.signup.confirmed'", eventNameMatches("user.*", "user.signup.confirmed"), true);
eq("'user.*' matches bare 'user'", eventNameMatches("user.*", "user"), true);
eq("'user.*' does NOT match 'userfoo.x'", eventNameMatches("user.*", "userfoo.x"), false);
eq("'user.*' does NOT match 'order.signup'", eventNameMatches("user.*", "order.signup"), false);
eq("empty pattern never matches", eventNameMatches("", "user.signup"), false);
// Wildcards only at suffix; mid-pattern `*` is treated literally (no match).
eq("mid-pattern '*' not supported", eventNameMatches("user.*.signup", "user.x.signup"), false);

/* -------------------------------------------------------------------------- */
/* 4. aggregateTrace + extractLLM                                              */
/* -------------------------------------------------------------------------- */
console.log("\ningest/upsert.ts · aggregateTrace + extractLLM");

function mkSpan(p: Partial<Span> & { spanId: string }): Span {
  return {
    traceId: "t_x",
    parentSpanId: null,
    name: "x",
    kind: "internal",
    status: "ok",
    startedAt: "2026-05-16T12:00:00.000Z",
    endedAt: "2026-05-16T12:00:01.000Z",
    durationMs: 1000,
    attributes: {},
    events: [],
    errorMessage: null,
    ...p,
  };
}

{
  // Mixed trace: 1 internal, 1 llm (known model), 1 errored tool, 1 llm (unknown model).
  const spans: Span[] = [
    mkSpan({
      spanId: "s1",
      name: "agent.run",
      kind: "internal",
      startedAt: "2026-05-16T12:00:00.000Z",
      endedAt: "2026-05-16T12:00:10.000Z",
    }),
    mkSpan({
      spanId: "s2",
      name: "openai.chat",
      kind: "llm",
      attributes: {
        "gen_ai.system": "openai",
        "gen_ai.request.model": "gpt-4o-mini",
        "gen_ai.usage.prompt_tokens": 1000,
        "gen_ai.usage.completion_tokens": 500,
      },
      startedAt: "2026-05-16T12:00:01.000Z",
      endedAt: "2026-05-16T12:00:03.000Z",
    }),
    mkSpan({
      spanId: "s3",
      name: "tool.search",
      kind: "tool",
      status: "error",
      errorMessage: "boom",
      startedAt: "2026-05-16T12:00:03.000Z",
      endedAt: "2026-05-16T12:00:04.000Z",
    }),
    mkSpan({
      spanId: "s4",
      name: "custom.llm",
      kind: "llm",
      attributes: {
        "gen_ai.request.model": "totally-unknown",
        "gen_ai.usage.prompt_tokens": 100,
        "gen_ai.usage.completion_tokens": 50,
      },
      startedAt: "2026-05-16T12:00:04.000Z",
      endedAt: "2026-05-16T12:00:05.000Z",
    }),
  ];
  const m = aggregateTrace(spans);
  eq("spanCount = 4", m.spanCount, 4);
  eq("errorCount = 1", m.errorCount, 1);
  // 1000 + 500 + 100 + 50 = 1650 (unknown-pricing model still contributes tokens).
  eq("totalTokens = 1650", m.totalTokens, 1650);
  // Only the known model contributes cost: (1000*0.15 + 500*0.60)/1e6 = 0.00045.
  close("costUsd from gpt-4o-mini = $0.00045", m.costUsd, 0.00045);
  eq("startedAt = earliest", m.startedAt, "2026-05-16T12:00:00.000Z");
  eq("endedAt = latest", m.endedAt, "2026-05-16T12:00:10.000Z");
  eq("durationMs = 10_000", m.durationMs, 10_000);
}

{
  // extractLLM: alt token attribute keys (input_tokens / output_tokens used
  // by Anthropic-style SDKs) and provider hint that determines provider tag.
  const span = mkSpan({
    spanId: "s_anth",
    kind: "llm",
    attributes: {
      "gen_ai.system": "anthropic",
      "gen_ai.request.model": "claude-3-5-sonnet-20241022",
      "gen_ai.usage.input_tokens": 200,
      "gen_ai.usage.output_tokens": 100,
      "gen_ai.prompt": "p",
      "gen_ai.completion": "c",
    },
  });
  const llm = extractLLM(span);
  eq("extractLLM provider=anthropic", llm.provider, "anthropic");
  eq("extractLLM model preserved", llm.model, "claude-3-5-sonnet-20241022");
  eq("extractLLM input_tokens read", llm.promptTokens, 200);
  eq("extractLLM output_tokens read", llm.completionTokens, 100);
  eq("extractLLM totalTokens summed", llm.totalTokens, 300);
  eq("extractLLM prompt captured", llm.prompt, "p");
  eq("extractLLM completion captured", llm.completion, "c");
  ok("extractLLM cost known for claude-3-5-sonnet", llm.cost.known);
}

{
  // extractLLM: no model + no tokens → safe defaults, unknown pricing.
  const span = mkSpan({ spanId: "s_blank", kind: "llm", attributes: {} });
  const llm = extractLLM(span);
  eq("extractLLM no model → empty", llm.model, "");
  eq("extractLLM no tokens → 0", llm.totalTokens, 0);
  ok("extractLLM blank → cost unknown", !llm.cost.known);
}

{
  // extractLLM: response.model fallback when request.model is absent.
  const span = mkSpan({
    spanId: "s_resp",
    kind: "llm",
    attributes: {
      "gen_ai.response.model": "gpt-4o",
      "gen_ai.usage.prompt_tokens": 1000,
      "gen_ai.usage.completion_tokens": 1000,
    },
  });
  const llm = extractLLM(span);
  eq("extractLLM falls back to response.model", llm.model, "gpt-4o");
  // (1000 * 2.50 + 1000 * 10.00) / 1e6 = 0.0125
  close("extractLLM cost from response.model", llm.cost.usd, 0.0125);
}

/* -------------------------------------------------------------------------- */
/* 5. Tracer behavior                                                          */
/* -------------------------------------------------------------------------- */
console.log("\nclient · Tracer behavior");

interface CapturedReq {
  body: string;
  signature: string;
}

function makeCapturingTracer(opts?: {
  fail?: (attempt: number) => boolean;
  maxBatchSize?: number;
  maxBatchAgeMs?: number;
  onError?: (e: Error) => void;
}): { tracer: Tracer; captured: CapturedReq[]; attempts: { count: number } } {
  const captured: CapturedReq[] = [];
  const attempts = { count: 0 };
  const mockFetch: typeof fetch = async (_input, init) => {
    attempts.count++;
    const body = String((init?.body as string | undefined) ?? "");
    const headers = (init?.headers ?? {}) as Record<string, string>;
    if (opts?.fail?.(attempts.count)) {
      throw new Error(`mock fetch failure attempt=${attempts.count}`);
    }
    captured.push({ body, signature: headers[SIGNATURE_HEADER] ?? "" });
    return new Response("", { status: 202 });
  };
  const tracer = new Tracer({
    url: "https://example.invalid/ingest",
    secret: "test-secret-runtime",
    service: "smoke-runtime",
    session: { id: "s_smoke_rt" },
    transport: {
      fetchImpl: mockFetch,
      maxBatchAgeMs: opts?.maxBatchAgeMs ?? 50,
      maxBatchSize: opts?.maxBatchSize ?? 100,
      onError: opts?.onError,
    },
  });
  return { tracer, captured, attempts };
}

interface WireSpan {
  trace_id: string;
  span_id: string;
  parent_span_id: string | null;
  name: string;
  kind: string;
  status: string;
  error_message: string | null;
  attributes: Record<string, unknown>;
}

function spansFromBatch(body: string): WireSpan[] {
  return (JSON.parse(body) as { spans: WireSpan[] }).spans;
}

{
  // Nested spans: child inherits traceId + sets parent_span_id correctly.
  const { tracer, captured } = makeCapturingTracer();
  await tracer.span("agent.run", async () => {
    await tracer.span("step.plan", async () => {
      await tracer.span("step.inner", async () => {
        await sleep(1);
      });
    });
  });
  await tracer.shutdown();
  eq("nested: 1 batch", captured.length, 1);
  const spans = spansFromBatch(captured[0]!.body);
  eq("nested: 3 spans", spans.length, 3);

  const byName = new Map(spans.map((s) => [s.name, s] as const));
  const root = byName.get("agent.run")!;
  const plan = byName.get("step.plan")!;
  const inner = byName.get("step.inner")!;

  const traceId = root.trace_id;
  ok("nested: all spans share traceId", spans.every((s) => s.trace_id === traceId));
  eq("nested: root has no parent", root.parent_span_id, null);
  eq("nested: plan's parent is root", plan.parent_span_id, root.span_id);
  eq("nested: inner's parent is plan", inner.parent_span_id, plan.span_id);
}

{
  // Thrown error inside a span → status="error", error_message set, parent
  // span still emits as well (we don't crash the trace on a child throw).
  const { tracer, captured } = makeCapturingTracer();
  let threwOut = false;
  try {
    await tracer.span("agent.run", async () => {
      await tracer.span("step.bad", async () => {
        throw new Error("kaboom");
      });
    });
  } catch (e) {
    threwOut = (e as Error).message === "kaboom";
  }
  await tracer.shutdown();
  ok("error: caller still sees the original throw", threwOut);
  const spans = spansFromBatch(captured[0]!.body);
  const byName = new Map(spans.map((s) => [s.name, s] as const));
  const bad = byName.get("step.bad")!;
  const root = byName.get("agent.run")!;
  eq("error: child span status=error", bad.status, "error");
  eq("error: child span error_message", bad.error_message, "kaboom");
  // Parent re-throws → parent ALSO records error with the same message.
  eq("error: parent span status=error", root.status, "error");
  eq("error: parent span error_message bubbled", root.error_message, "kaboom");
}

{
  // setStatus("error", "...") explicitly should win over the default "ok".
  const { tracer, captured } = makeCapturingTracer();
  await tracer.span("agent.run", async (s) => {
    s.setStatus("error", "explicit-fail");
  });
  await tracer.shutdown();
  const span = spansFromBatch(captured[0]!.body)[0]!;
  eq("setStatus error wins", span.status, "error");
  eq("setStatus error_message wins", span.error_message, "explicit-fail");
}

{
  // recordLLM stamps kind=llm and the gen_ai.* attributes.
  const { tracer, captured } = makeCapturingTracer();
  await tracer.span("openai.chat", async (s) => {
    s.recordLLM({
      provider: "openai",
      model: "gpt-4o-mini",
      promptTokens: 33,
      completionTokens: 4,
      prompt: "hi",
      completion: "ok",
    });
  });
  await tracer.shutdown();
  const span = spansFromBatch(captured[0]!.body)[0]!;
  eq("recordLLM: kind=llm", span.kind, "llm");
  eq("recordLLM: provider attribute", span.attributes["gen_ai.system"], "openai");
  eq(
    "recordLLM: model attribute",
    span.attributes["gen_ai.request.model"],
    "gpt-4o-mini",
  );
  eq(
    "recordLLM: prompt_tokens attribute",
    span.attributes["gen_ai.usage.prompt_tokens"],
    33,
  );
  eq(
    "recordLLM: completion_tokens attribute",
    span.attributes["gen_ai.usage.completion_tokens"],
    4,
  );
}

/* -------------------------------------------------------------------------- */
/* 6. Transport batching / retry / onError                                     */
/* -------------------------------------------------------------------------- */
console.log("\nclient · Transport batching + retry");

{
  // Size-triggered flush: maxBatchSize=2 → emitting 3 spans fans into 2 sends.
  const captured: CapturedReq[] = [];
  const fetchImpl: typeof fetch = async (_u, init) => {
    captured.push({
      body: String((init?.body as string | undefined) ?? ""),
      signature: "ignored",
    });
    return new Response("", { status: 202 });
  };
  const t = new Transport({
    url: "https://x",
    secret: "k",
    service: "svc",
    session: null,
    maxBatchSize: 2,
    maxBatchAgeMs: 10_000, // long enough to ensure size flush fires first
    fetchImpl,
  });
  const base = {
    trace_id: "t",
    parent_span_id: null,
    name: "x",
    kind: "internal" as const,
    status: "ok" as const,
    started_at: "2026-05-16T12:00:00Z",
    ended_at: "2026-05-16T12:00:01Z",
    attributes: {},
    events: [],
    error_message: null,
  };
  t.enqueue({ ...base, span_id: "s1" });
  t.enqueue({ ...base, span_id: "s2" }); // triggers size flush
  t.enqueue({ ...base, span_id: "s3" });
  await t.flush();
  eq("size-flush + manual flush → 2 batches", captured.length, 2);
  const firstSpans = (JSON.parse(captured[0]!.body) as { spans: Array<{ span_id: string }> }).spans;
  const secondSpans = (JSON.parse(captured[1]!.body) as { spans: Array<{ span_id: string }> }).spans;
  eq("first batch has 2 spans", firstSpans.length, 2);
  eq("second batch has 1 span", secondSpans.length, 1);
  eq(
    "first batch ids",
    firstSpans.map((s) => s.span_id).sort(),
    ["s1", "s2"],
  );
  eq("second batch ids", secondSpans.map((s) => s.span_id), ["s3"]);
}

{
  // Retry once: first attempt throws, second succeeds → onError NOT called.
  let onErrorCalls = 0;
  const { tracer, captured, attempts } = makeCapturingTracer({
    fail: (n) => n === 1,
    onError: () => onErrorCalls++,
  });
  await tracer.span("agent.run", async () => {});
  await tracer.shutdown();
  eq("retry: 2 fetch attempts (one fail, one success)", attempts.count, 2);
  eq("retry: 1 captured payload (the successful one)", captured.length, 1);
  eq("retry: onError not called on eventual success", onErrorCalls, 0);
}

{
  // Persistent failure: both attempts throw → onError called once with the
  // surfaced error, no batch captured.
  const errors: Error[] = [];
  const { tracer, captured, attempts } = makeCapturingTracer({
    fail: () => true,
    onError: (e) => errors.push(e),
  });
  await tracer.span("agent.run", async () => {});
  await tracer.shutdown();
  eq("persistent: 2 attempts total", attempts.count, 2);
  eq("persistent: 0 successful batches", captured.length, 0);
  eq("persistent: onError fired once", errors.length, 1);
  ok(
    "persistent: error surfaces mock failure",
    errors[0]!.message.includes("mock fetch failure"),
  );
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
