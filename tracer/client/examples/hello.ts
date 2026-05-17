/**
 * Phase 0 smoke test for the Tracer client.
 *
 * Usage:
 *   TRACER_URL="https://www.notion.so/webhooks/worker/.../ingest" \
 *   TRACER_SECRET="<the INGEST_SECRET you set on the worker>" \
 *   npx tsx examples/hello.ts
 *
 * Expected outcome: a single Trace row with three child Spans appears in the
 * Tracer · Traces / Tracer · Spans Notion databases.
 */

import { Tracer } from "../src/index.js";

const url = process.env.TRACER_URL;
const secret = process.env.TRACER_SECRET;

if (!url || !secret) {
  console.error(
    "Set TRACER_URL and TRACER_SECRET. Get the URL from `ntn workers webhooks list`.",
  );
  process.exit(1);
}

const tracer = new Tracer({
  url,
  secret,
  service: "hello-agent",
  session: { id: `s_${Date.now()}`, user_id: "demo-user", tags: ["dev"] },
  transport: {
    onError: (err) => console.error("tracer transport error:", err.message),
  },
});

await tracer.span("agent.run", async (root) => {
  root.setAttribute("user.id", "demo-user");
  root.setAttribute("agent.version", "hello-0.1");

  await tracer.span("step.plan", async (s) => {
    s.setAttribute("plan.depth", 2);
    s.addEvent("plan.start");
    await sleep(50);
    s.addEvent("plan.done");
  });

  await tracer.llm("openai.chat", async (s) => {
    s.recordLLM({
      provider: "openai",
      model: "gpt-4o-mini",
      promptTokens: 124,
      completionTokens: 38,
      prompt: "Summarise the previous step.",
      completion: "Step planned; proceeding to act.",
    });
    await sleep(120);
  });

  await tracer.tool("step.act", async (s) => {
    s.setAttribute("tool.name", "noop");
    await sleep(40);
    s.setStatus("ok");
  });
});

await tracer.shutdown();
console.log("ok — flushed spans to", url);

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
