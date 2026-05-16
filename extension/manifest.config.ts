import { defineManifest } from "@crxjs/vite-plugin";
import pkg from "./package.json" with { type: "json" };

export default defineManifest({
  manifest_version: 3,
  name: "Notion Hack",
  description: "Basic React + Tailwind Chrome extension.",
  version: pkg.version,
  action: {
    default_popup: "src/popup/index.html",
    default_title: "Notion Hack",
  },
  background: {
    service_worker: "src/background/index.ts",
    type: "module",
  },
  content_scripts: [
    {
      matches: ["<all_urls>"],
      js: ["src/content/index.ts"],
      run_at: "document_start",
      all_frames: true,
    },
  ],
  permissions: ["storage", "tabs", "webNavigation", "activeTab", "scripting"],
  host_permissions: ["<all_urls>"],
});
