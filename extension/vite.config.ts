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
  return {
    plugins: [react(), tailwindcss(), crx({ manifest })],
    define: {
      __OPENAI_KEY_BUILD__: JSON.stringify(openaiKey),
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
