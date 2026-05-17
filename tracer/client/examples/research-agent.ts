/**
 * Real-world example: a multi-step research agent, fully traced.
 *
 * What it does:
 *   1. Takes a topic from argv (or a default).
 *   2. `step.plan`  — asks OpenAI for 3 specific sub-questions.
 *   3. For each sub-question, sequentially:
 *        `tool.wikipedia.search`  — public Wikipedia opensearch API.
 *        `tool.wikipedia.summary` — public Wikipedia REST summary.
 *   4. `step.synthesize` — asks OpenAI to produce a tight briefing
 *      that cites the sources.
 *
 * Every step is wrapped in `tracer.span` / `tracer.llm` / `tracer.tool`
 * so the whole tree (with nested parent/child relationships, costs, and
 * any errors) lands in Notion in real time.
 *
 * Usage:
 *
 *   export TRACER_URL=$(cd ../worker && ntn workers webhooks list | awk '/\tingest\t/ {print $3}')
 *   export TRACER_SECRET=<your INGEST_SECRET>
 *   export OPENAI_API_KEY=sk-...
 *   npx tsx examples/research-agent.ts "Why did Kodak fail as a company"
 *
 * Then in Notion, open the freshest row in `Tracer · Traces`. You'll see:
 *
 *   agent.research
 *   ├── step.plan                 (LLM)
 *   ├── step.research-one × 3
 *   │   ├── tool.wikipedia.search (tool)
 *   │   └── tool.wikipedia.summary (tool)
 *   └── step.synthesize           (LLM)
 *
 * Re-run the same command — the same trace ID is NOT reused (each run is
 * a new trace), but counts in the LLM Calls / Tool Calls projection DBs
 * grow predictably.
 *
 * Then ask Notion AI:
 *   "Use the getTrace tool to fetch trace <id> and tell me what
 *    Wikipedia articles the agent ended up reading."
 */

import { Tracer } from "../src/index.js";

const url = process.env.TRACER_URL;
const secret = process.env.TRACER_SECRET;
const openaiKey = process.env.OPENAI_API_KEY;
const model = process.env.OPENAI_MODEL ?? "gpt-4o-mini";

if (!url || !secret) {
  console.error(
    "Set TRACER_URL and TRACER_SECRET first.\n" +
      "  TRACER_URL: from `ntn workers webhooks list` (the `ingest` row)\n" +
      "  TRACER_SECRET: the INGEST_SECRET value you set on the worker",
  );
  process.exit(1);
}
if (!openaiKey) {
  console.error("Set OPENAI_API_KEY (the agent needs a real LLM to plan / synthesize).");
  process.exit(1);
}

const topic = process.argv.slice(2).join(" ") || "Why did Kodak fail as a company";
const userAgent = "notion-tracer-research-agent/0.1 (https://github.com/notion-hackathon)";

const tracer = new Tracer({
  url,
  secret,
  service: "research-agent",
  session: {
    id: `s_${Date.now()}`,
    user_id: "researcher",
    tags: ["research-agent", "demo"],
  },
  transport: {
    onError: (err) => console.error("tracer:", err.message),
  },
});

interface PlannedQuestion {
  question: string;
  search: string;
}

interface Finding {
  question: string;
  wikipediaTitle: string | null;
  wikipediaSummary: string | null;
}

const briefing = await tracer.span(
  "agent.research",
  async (root) => {
    root.setAttribute("agent.topic", topic);
    root.setAttribute("agent.model", model);

    /* ---------------------------------------------------------------- */
    /* 1. Plan                                                           */
    /* ---------------------------------------------------------------- */
    const subQuestions = await tracer.llm("step.plan", async (s) => {
      const systemPrompt =
        "You are a research planner. Given the user's topic, output a JSON array of " +
        "EXACTLY 3 objects of the form { \"question\": <a specific sub-question>, \"search\": " +
        "<a short 2-5 word Wikipedia-style noun-phrase title to look up> }. " +
        "The `search` field MUST be a concise title, not a question. Reply with ONLY the JSON array.";
      const { content, usage } = await callOpenAI(openaiKey, model, [
        { role: "system", content: systemPrompt },
        { role: "user", content: topic },
      ]);
      s.recordLLM({
        provider: "openai",
        model,
        promptTokens: usage.promptTokens,
        completionTokens: usage.completionTokens,
        prompt: `system: ${systemPrompt}\nuser: ${topic}`,
        completion: content,
      });
      const qs = parseQuestionList(content);
      s.setAttribute("plan.questions", JSON.stringify(qs));
      s.setAttribute("plan.raw", content);
      if (qs.length === 0) {
        s.setStatus("error", "planner returned no parseable questions");
      }
      return qs;
    });

    console.log(`\n→ planned ${subQuestions.length} sub-question(s):`);
    subQuestions.forEach((q, i) =>
      console.log(`   ${i + 1}. ${q.question}  [search: "${q.search}"]`),
    );

    /* ---------------------------------------------------------------- */
    /* 2. Research each sub-question                                     */
    /* ---------------------------------------------------------------- */
    const findings: Finding[] = [];
    for (const [i, { question, search }] of subQuestions.entries()) {
      const finding = await tracer.span(
        "step.research-one",
        async (s) => {
          s.setAttribute("subquestion.index", i + 1);
          s.setAttribute("subquestion.text", question);
          s.setAttribute("subquestion.search", search);

          const title = await tracer.tool("tool.wikipedia.search", async (t) => {
            t.setAttribute("tool.name", "wikipedia.search");
            t.setAttribute("tool.args", JSON.stringify({ query: search }));
            const found = await wikiSearch(search);
            t.setAttribute("tool.result", JSON.stringify(found ?? null));
            if (!found) t.setStatus("error", "no results from Wikipedia");
            return found;
          });

          const summary = title
            ? await tracer.tool("tool.wikipedia.summary", async (t) => {
                t.setAttribute("tool.name", "wikipedia.summary");
                t.setAttribute("tool.args", JSON.stringify({ title }));
                const text = await wikiSummary(title);
                t.setAttribute(
                  "tool.result",
                  JSON.stringify(text?.slice(0, 600) ?? null),
                );
                if (!text) t.setStatus("error", "no summary returned");
                return text;
              })
            : null;

          return {
            question,
            wikipediaTitle: title,
            wikipediaSummary: summary,
          };
        },
      );
      findings.push(finding);
      console.log(
        `→ Q${i + 1} ("${search}") → ${finding.wikipediaTitle ?? "(no source)"} ` +
          `${finding.wikipediaSummary ? "✓" : "✗"}`,
      );
    }

    /* ---------------------------------------------------------------- */
    /* 3. Synthesize                                                     */
    /* ---------------------------------------------------------------- */
    const answer = await tracer.llm("step.synthesize", async (s) => {
      const sources = findings
        .map((f, i) => {
          const head = `[${i + 1}] Q: ${f.question}\n    Source: ${
            f.wikipediaTitle ?? "(no Wikipedia article found)"
          }`;
          const body = f.wikipediaSummary
            ? `    ${f.wikipediaSummary.replace(/\n+/g, " ").slice(0, 1200)}`
            : "    (no information available)";
          return `${head}\n${body}`;
        })
        .join("\n\n");

      const systemPrompt =
        "You produce a tight 4-6 sentence briefing for the user's topic from the supplied " +
        "sources. Cite source numbers like [1], [2]. If a source is empty, work around it. " +
        "Plain prose only — no headings, no bullets.";
      const userPrompt = `Topic: ${topic}\n\nSources:\n${sources}`;

      const { content, usage } = await callOpenAI(openaiKey, model, [
        { role: "system", content: systemPrompt },
        { role: "user", content: userPrompt },
      ]);
      s.recordLLM({
        provider: "openai",
        model,
        promptTokens: usage.promptTokens,
        completionTokens: usage.completionTokens,
        prompt: `system: ${systemPrompt}\nuser: ${userPrompt}`,
        completion: content,
      });
      s.setAttribute("synth.sources_used", findings.filter((f) => f.wikipediaSummary).length);
      return content;
    });

    root.setAttribute("agent.sources_used", findings.filter((f) => f.wikipediaSummary).length);
    return answer;
  },
  { kind: "agent" },
);

await tracer.shutdown();

console.log("\n=== BRIEFING ===\n");
console.log(briefing);
console.log("\n----");
console.log("Spans flushed. Open Notion · Tracer · Traces (newest row) to see the trace tree.");
console.log("In a Notion AI chat with the worker's tools enabled, try:");
console.log("  > Use the getTrace tool to find the most recent research-agent run");
console.log("  > and tell me which Wikipedia articles it consulted.\n");

/* ========================================================================== */
/* helpers                                                                     */
/* ========================================================================== */

interface OpenAIResult {
  content: string;
  usage: { promptTokens: number; completionTokens: number };
}

async function callOpenAI(
  apiKey: string,
  modelName: string,
  messages: Array<{ role: "system" | "user"; content: string }>,
): Promise<OpenAIResult> {
  const res = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({ model: modelName, messages, temperature: 0.2 }),
  });
  if (!res.ok) {
    throw new Error(`OpenAI ${res.status}: ${await res.text()}`);
  }
  const json = (await res.json()) as {
    choices: Array<{ message: { content: string } }>;
    usage: { prompt_tokens: number; completion_tokens: number };
  };
  return {
    content: json.choices[0]?.message.content ?? "",
    usage: {
      promptTokens: json.usage.prompt_tokens,
      completionTokens: json.usage.completion_tokens,
    },
  };
}

function parseQuestionList(raw: string): PlannedQuestion[] {
  const trimmed = raw.trim().replace(/^```(?:json)?\s*/, "").replace(/\s*```$/, "");
  try {
    const parsed = JSON.parse(trimmed) as unknown;
    if (Array.isArray(parsed)) {
      const out: PlannedQuestion[] = [];
      for (const item of parsed) {
        if (typeof item === "string") {
          out.push({ question: item, search: deriveSearch(item) });
        } else if (item && typeof item === "object") {
          const o = item as { question?: unknown; search?: unknown };
          const question = typeof o.question === "string" ? o.question : "";
          const search =
            typeof o.search === "string" && o.search.length > 0
              ? o.search
              : deriveSearch(question);
          if (question) out.push({ question, search });
        }
      }
      return out;
    }
  } catch {
    /* fall through */
  }
  // Fallback: split on newlines and strip numbering / bullets.
  return raw
    .split(/\n+/)
    .map((line) => line.replace(/^\s*(?:[-*]|\d+[.)])\s*/, "").trim())
    .filter((line) => line.endsWith("?") && line.length > 5)
    .slice(0, 3)
    .map((question) => ({ question, search: deriveSearch(question) }));
}

/**
 * Heuristic fallback when the model gives us a bare question with no
 * paired search term. Strip stopwords + question words, keep the first
 * 4 meaningful tokens.
 */
function deriveSearch(question: string): string {
  const stop = new Set([
    "what", "why", "how", "did", "does", "do", "was", "were", "is", "are",
    "the", "a", "an", "of", "in", "on", "to", "for", "and", "or", "with",
    "that", "this", "as", "its", "it", "by", "from", "about",
  ]);
  return question
    .toLowerCase()
    .replace(/[?.,;:!]/g, "")
    .split(/\s+/)
    .filter((w) => w && !stop.has(w))
    .slice(0, 4)
    .join(" ");
}

async function wikiSearch(query: string): Promise<string | null> {
  // Use `list=search` (full-text article search), not `opensearch` which is
  // title-only and misses descriptive multi-word queries.
  const u = new URL("https://en.wikipedia.org/w/api.php");
  u.searchParams.set("action", "query");
  u.searchParams.set("list", "search");
  u.searchParams.set("srsearch", query);
  u.searchParams.set("srlimit", "1");
  u.searchParams.set("format", "json");
  u.searchParams.set("origin", "*");
  const res = await fetch(u, { headers: { "User-Agent": userAgent } });
  if (!res.ok) return null;
  const json = (await res.json()) as {
    query?: { search?: Array<{ title?: string }> };
  };
  return json.query?.search?.[0]?.title ?? null;
}

async function wikiSummary(title: string): Promise<string | null> {
  const u = `https://en.wikipedia.org/api/rest_v1/page/summary/${encodeURIComponent(
    title.replace(/\s+/g, "_"),
  )}`;
  const res = await fetch(u, { headers: { "User-Agent": userAgent } });
  if (!res.ok) return null;
  const json = (await res.json()) as { extract?: string };
  return json.extract?.trim() ?? null;
}
