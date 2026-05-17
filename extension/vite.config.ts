import { defineConfig, loadEnv } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { crx } from "@crxjs/vite-plugin";
import manifest from "./manifest.config";

// `process` is provided by Node at build time; we avoid pulling in @types/node
// just for this single use by declaring the slice we need.
declare const process: { cwd(): string };

// Build-time injection of secrets from extension/.env. Runtime override
// (chrome.storage.local) takes precedence at request time — see lib/settings.ts.
// .env IS gitignored at the repo root; do not commit dist/ either.
export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), "");
  // Accept either OPENAI_KEY or OPENAI_API_KEY from .env.
  const openaiKey = env.OPENAI_KEY || env.OPENAI_API_KEY || "";
  // Notion defaults — let a freshly-built install run without re-entering
  // the token / parent / DB ids every time. Storage still wins at runtime.
  const notionToken = env.NOTION_TOKEN || "";
  const notionParentPageId = env.NOTION_PARENT_PAGE_ID || "";
  const notionParentPageTitle = env.NOTION_PARENT_PAGE_TITLE || "";
  const notionWorkspaceName = env.NOTION_WORKSPACE_NAME || "";
  const notionObservationsDbId = env.NOTION_OBSERVATIONS_DB_ID || "";
  const notionWorkflowsDbId = env.NOTION_WORKFLOWS_DB_ID || "";
  const notionRunsDbId = env.NOTION_RUNS_DB_ID || "";
  // Job-agent integration: Exa search + the deployed tracer worker.
  const exaKey = env.EXA_KEY || "";
  const tracerTriggerUrl = env.TRACER_TRIGGER_URL || "";
  const tracerIngestSecret = env.TRACER_INGEST_SECRET || "";
  return {
    plugins: [react(), tailwindcss(), crx({ manifest })],
    define: {
      __OPENAI_KEY_BUILD__: JSON.stringify(openaiKey),
      __NOTION_TOKEN_BUILD__: JSON.stringify(notionToken),
      __NOTION_PARENT_PAGE_ID_BUILD__: JSON.stringify(notionParentPageId),
      __NOTION_PARENT_PAGE_TITLE_BUILD__: JSON.stringify(notionParentPageTitle),
      __NOTION_WORKSPACE_NAME_BUILD__: JSON.stringify(notionWorkspaceName),
      __NOTION_OBSERVATIONS_DB_ID_BUILD__: JSON.stringify(notionObservationsDbId),
      __NOTION_WORKFLOWS_DB_ID_BUILD__: JSON.stringify(notionWorkflowsDbId),
      __NOTION_RUNS_DB_ID_BUILD__: JSON.stringify(notionRunsDbId),
      __EXA_KEY_BUILD__: JSON.stringify(exaKey),
      __TRACER_TRIGGER_URL_BUILD__: JSON.stringify(tracerTriggerUrl),
      __TRACER_INGEST_SECRET_BUILD__: JSON.stringify(tracerIngestSecret),
    },
    server: {
      port: 5173,
      strictPort: true,
      hmr: { port: 5173 },
    },
    build: {
      outDir: "dist",
      emptyOutDir: true,
    },
  };
});
