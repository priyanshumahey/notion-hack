/**
 * Seed sample sandboxes + functions into the freshly-deployed worker.
 *
 *   npm run seed
 *
 * Requires the worker to have been deployed at least once (so the managed
 * databases exist) AND a `NOTION_API_TOKEN` env var that can write to them.
 *
 * Database IDs are resolved by title in the integration's accessible scope,
 * mirroring the worker's own resolver. You can short-circuit by setting
 * SANDBOXES_DB_ID / FUNCTIONS_DB_ID env vars.
 */

import { Client } from "@notionhq/client";

const NOTION_TOKEN = process.env.NOTION_API_TOKEN;
if (!NOTION_TOKEN) {
  console.error("✗ NOTION_API_TOKEN env var is required.");
  process.exit(1);
}
const notion = new Client({ auth: NOTION_TOKEN });

const TITLES = {
  sandboxes: "Functions · Sandboxes",
  functions: "Functions · Catalog",
} as const;
const ENV = {
  sandboxes: "SANDBOXES_DB_ID",
  functions: "FUNCTIONS_DB_ID",
} as const;

type DbKey = keyof typeof TITLES;

async function resolveDbId(key: DbKey): Promise<string> {
  const envVal = process.env[ENV[key]];
  if (envVal) return envVal;
  const res = await notion.search({
    query: TITLES[key],
    filter: { property: "object", value: "database" },
  });
  for (const r of res.results) {
    if (
      r.object === "database" &&
      "title" in r &&
      Array.isArray((r as { title: unknown[] }).title)
    ) {
      const title = (r as { title: Array<{ plain_text?: string }> }).title
        .map((t) => t.plain_text ?? "")
        .join("");
      if (title === TITLES[key]) return r.id;
    }
  }
  throw new Error(
    `Could not find database "${TITLES[key]}" — has the worker been deployed?`,
  );
}

async function findByPK(
  dbId: string,
  pkProp: string,
  pkValue: string,
): Promise<string | null> {
  const res = await notion.databases.query({
    database_id: dbId,
    filter: { property: pkProp, rich_text: { equals: pkValue } },
    page_size: 1,
  });
  return res.results[0]?.id ?? null;
}

async function upsertSandbox(
  dbId: string,
  key: string,
  data: {
    name: string;
    description: string;
    environment: "prod" | "staging" | "dev";
    allowedHosts: string;
    maxConcurrent: number;
    active: boolean;
  },
): Promise<string> {
  const existing = await findByPK(dbId, "Sandbox Key", key);
  const properties: Record<string, unknown> = {
    Name: { title: [{ type: "text", text: { content: data.name } }] },
    "Sandbox Key": { rich_text: [{ type: "text", text: { content: key } }] },
    Description: {
      rich_text: [{ type: "text", text: { content: data.description } }],
    },
    Environment: { select: { name: data.environment } },
    "Allowed Hosts": {
      rich_text: [{ type: "text", text: { content: data.allowedHosts } }],
    },
    "Max Concurrent Runs": { number: data.maxConcurrent },
    Active: { checkbox: data.active },
  };
  if (existing) {
    await notion.pages.update({ page_id: existing, properties: properties as never });
    return existing;
  }
  const r = await notion.pages.create({
    parent: { database_id: dbId },
    properties: properties as never,
  });
  return r.id;
}

async function upsertFunction(
  dbId: string,
  key: string,
  data: {
    name: string;
    description: string;
    sandboxPageId: string;
    trigger: "manual" | "webhook" | "schedule";
    definition: unknown;
    enabled: boolean;
  },
): Promise<string> {
  const existing = await findByPK(dbId, "Function Key", key);
  const properties: Record<string, unknown> = {
    Name: { title: [{ type: "text", text: { content: data.name } }] },
    "Function Key": {
      rich_text: [{ type: "text", text: { content: key } }],
    },
    Description: {
      rich_text: [{ type: "text", text: { content: data.description } }],
    },
    Sandbox: { relation: [{ id: data.sandboxPageId }] },
    Trigger: { select: { name: data.trigger } },
    Definition: {
      rich_text: [
        {
          type: "text",
          text: { content: JSON.stringify(data.definition) },
        },
      ],
    },
    Enabled: { checkbox: data.enabled },
  };
  if (existing) {
    await notion.pages.update({ page_id: existing, properties: properties as never });
    return existing;
  }
  const r = await notion.pages.create({
    parent: { database_id: dbId },
    properties: properties as never,
  });
  return r.id;
}

async function main(): Promise<void> {
  console.log("Resolving databases…");
  const sandboxesDb = await resolveDbId("sandboxes");
  const functionsDb = await resolveDbId("functions");
  console.log(`  Sandboxes : ${sandboxesDb}`);
  console.log(`  Functions : ${functionsDb}`);

  console.log("\nUpserting sandbox: dev-default");
  const sandbox = await upsertSandbox(sandboxesDb, "dev-default", {
    name: "Dev Default",
    description: "Default sandbox for development. Allows api.github.com + api.openai.com.",
    environment: "dev",
    allowedHosts: "api.github.com, api.openai.com",
    maxConcurrent: 4,
    active: true,
  });
  console.log(`  → ${sandbox}`);

  console.log("\nUpserting function: hello-zen");
  await upsertFunction(functionsDb, "hello-zen", {
    name: "Hello Zen",
    description:
      "Fetches a GitHub Zen quote and pauses briefly. Pure http + delay demo.",
    sandboxPageId: sandbox,
    trigger: "webhook",
    enabled: true,
    definition: {
      steps: [
        { id: "wait", type: "delay", ms: 250 },
        { id: "zen", type: "http", url: "https://api.github.com/zen", method: "GET" },
      ],
    },
  });
  console.log("  → done");

  console.log("\nUpserting function: pirate-zen (LLM)");
  await upsertFunction(functionsDb, "pirate-zen", {
    name: "Pirate Zen",
    description:
      "Fetches a Zen quote, then asks gpt-4o-mini to rewrite it in pirate speak. Requires OPENAI_API_KEY on the worker.",
    sandboxPageId: sandbox,
    trigger: "webhook",
    enabled: true,
    definition: {
      steps: [
        { id: "zen", type: "http", url: "https://api.github.com/zen", method: "GET" },
        {
          id: "rewrite",
          type: "llm",
          model: "gpt-4o-mini",
          system: "You are a friendly pirate.",
          prompt:
            "Rewrite this phrase in pirate speak in one short sentence: ${state.zen.body}",
          maxTokens: 80,
          temperature: 0.5,
        },
      ],
    },
  });
  console.log("  → done");

  console.log("\nAll seeds upserted.");
}

main().catch((err) => {
  console.error("seed failed:", err);
  process.exit(1);
});
