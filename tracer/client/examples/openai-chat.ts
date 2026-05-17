/**
 * Phase 1 example: trace a real OpenAI chat completion (or a local mock).
 *
 * Usage:
 *   TRACER_URL=... TRACER_SECRET=... [OPENAI_API_KEY=sk-...] npx tsx examples/openai-chat.ts
 *
 * Behaviour:
 *   - If OPENAI_API_KEY is set, makes a real request to `chat/completions`
 *     with `gpt-4o-mini` and records the actual prompt/completion + token
 *     usage on the span.
 *   - Otherwise, fakes a completion locally so you can still demonstrate the
 *     pipeline without spending money.
 *
 * Expected outcome in Notion (after the worker has been deployed and granted
 * access to the databases):
 *   - 1 Sessions row (this run's session id).
 *   - 1 Traces row with a non-zero Total Tokens / Cost (USD).
 *   - 4 Spans rows (agent.run, step.plan, openai.chat, step.act).
 *   - 1 LLM Calls row with model/tokens/cost populated.
 *   - 1 Tool Calls row for step.act.
 *
 * Run the same command a second time — counts in Notion should NOT change
 * (rows are upserted by Span ID / Event ID).
 */

import { Tracer } from "../src/index.js";

const url = process.env.TRACER_URL;
const secret = process.env.TRACER_SECRET;
const openaiKey = process.env.OPENAI_API_KEY;
const model = process.env.OPENAI_MODEL ?? "gpt-4o-mini";

if (!url || !secret) {
  console.error(
    "Set TRACER_URL and TRACER_SECRET. Get the URL from `ntn workers webhooks list`.",
  );
  process.exit(1);
}

const tracer = new Tracer({
  url,
  secret,
  service: "openai-chat-demo",
  session: {
    id: `s_${Date.now()}`,
    user_id: "demo-user",
    tags: ["dev", "phase1"],
  },
  transport: {
    onError: (err) => console.error("tracer transport error:", err.message),
  },
});

await tracer.span("agent.run", async (root) => {
  root.setAttribute("user.id", "demo-user");
  root.setAttribute("agent.version", "openai-chat-0.1");

  await tracer.span("step.plan", async (s) => {
    s.setAttribute("plan.depth", 1);
    s.addEvent("plan.start");
    await sleep(20);
    s.addEvent("plan.done");
  });

  await tracer.llm("openai.chat", async (s) => {
    const prompt = "In one sentence, what is observability?";

    const { completion, usage } = openaiKey
      ? await callOpenAI(openaiKey, model, prompt)
      : await fakeOpenAI(prompt);

    s.recordLLM({
      provider: "openai",
      model,
      promptTokens: usage.promptTokens,
      completionTokens: usage.completionTokens,
      prompt,
      completion,
    });
  });

  await tracer.tool("step.act", async (s) => {
    s.setAttribute("tool.name", "format-answer");
    s.setAttribute("tool.args", JSON.stringify({ style: "concise" }));
    await sleep(15);
    s.setAttribute("tool.result", JSON.stringify({ accepted: true }));
    s.setStatus("ok");
  });
});

await tracer.shutdown();
console.log("ok — flushed spans to", url);
console.log("re-run this script to verify idempotency (row counts should not change).");

/* -------------------------------------------------------------------------- */

interface LLMResult {
  completion: string;
  usage: { promptTokens: number; completionTokens: number };
}

async function callOpenAI(
  apiKey: string,
  model: string,
  prompt: string,
): Promise<LLMResult> {
  const res = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      model,
      messages: [{ role: "user", content: prompt }],
    }),
  });
  if (!res.ok) {
    throw new Error(`OpenAI ${res.status}: ${await res.text()}`);
  }
  const json = (await res.json()) as {
    choices: Array<{ message: { content: string } }>;
    usage: { prompt_tokens: number; completion_tokens: number };
  };
  return {
    completion: json.choices[0]?.message.content ?? "",
    usage: {
      promptTokens: json.usage.prompt_tokens,
      completionTokens: json.usage.completion_tokens,
    },
  };
}

async function fakeOpenAI(prompt: string): Promise<LLMResult> {
  await sleep(80);
  return {
    completion:
      "Observability is the ability to infer a system's internal state from the signals it emits — logs, metrics, and traces.",
    // Plausible token counts so cost reports a small but non-zero number.
    usage: {
      promptTokens: Math.round(12 + prompt.length / 10),
      completionTokens: 28,
    },
  };
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
