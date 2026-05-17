// Typed wrapper over chrome.storage.local for app settings.
//
// Resolution order for the OpenAI key when callers ask `getOpenAiKey()`:
//   1. chrome.storage.local.openaiKey (set via Settings UI) — wins
//   2. __OPENAI_KEY_BUILD__ injected by Vite from `.env` at build time
//   3. "" — features that require a key must refuse to run

const KEYS = {
  openaiKey: "openaiKey",
  autoApplyMaster: "autoApplyMaster",
  autoApplyByDb: "autoApplyByDb",
} as const;

export interface Settings {
  openaiKey: string;
}

/** Build-time fallback (from extension/.env via vite define). May be ""; never throws. */
function buildKey(): string {
  try {
    return typeof __OPENAI_KEY_BUILD__ === "string" ? __OPENAI_KEY_BUILD__ : "";
  } catch {
    return "";
  }
}

export async function getOpenAiKey(): Promise<string> {
  const r = await chrome.storage.local.get([KEYS.openaiKey]);
  const stored = (r[KEYS.openaiKey] as string | undefined) ?? "";
  return stored || buildKey();
}

export async function setOpenAiKey(key: string): Promise<void> {
  const trimmed = key.trim();
  if (trimmed) {
    await chrome.storage.local.set({ [KEYS.openaiKey]: trimmed });
  } else {
    await chrome.storage.local.remove([KEYS.openaiKey]);
  }
}

/** True iff there's any usable key (stored OR build-time). */
export async function hasOpenAiKey(): Promise<boolean> {
  return (await getOpenAiKey()).length > 0;
}

/** Tells the caller WHERE the active key came from, for the Settings UI. */
export async function describeKeySource(): Promise<"stored" | "build" | "none"> {
  const r = await chrome.storage.local.get([KEYS.openaiKey]);
  const stored = (r[KEYS.openaiKey] as string | undefined) ?? "";
  if (stored) return "stored";
  if (buildKey()) return "build";
  return "none";
}

/** Show only last 4 chars; never log full keys. */
export function redactKey(key: string): string {
  if (!key) return "";
  if (key.length <= 8) return "•".repeat(key.length);
  return `${key.slice(0, 3)}…${key.slice(-4)}`;
}

// ---- Auto-apply configuration ---------------------------------------------
//
// Two layers:
//   1. Master switch (global). When OFF, no flow ever auto-applies — every
//      meaningful candidate is surfaced as a prompt.
//   2. Per-DB toggle. When master is ON, each known DB has its own boolean.
//      Default if unset: TRUE — i.e. once a user has approved a candidate to
//      land in DB X, future judgements that route to X auto-apply. The user
//      can flip this OFF per DB to require manual approval for that flow.

export interface AutoApplyConfig {
  master: boolean;
  byDb: Record<string, boolean>;
}

export async function getAutoApplyConfig(): Promise<AutoApplyConfig> {
  const r = await chrome.storage.local.get([
    KEYS.autoApplyMaster,
    KEYS.autoApplyByDb,
  ]);
  const master =
    typeof r[KEYS.autoApplyMaster] === "boolean" ? (r[KEYS.autoApplyMaster] as boolean) : true;
  const byDb =
    r[KEYS.autoApplyByDb] && typeof r[KEYS.autoApplyByDb] === "object"
      ? (r[KEYS.autoApplyByDb] as Record<string, boolean>)
      : {};
  return { master, byDb };
}

export async function setAutoApplyMaster(enabled: boolean): Promise<void> {
  await chrome.storage.local.set({ [KEYS.autoApplyMaster]: !!enabled });
}

export async function setAutoApplyForDb(dbId: string, enabled: boolean): Promise<void> {
  const cfg = await getAutoApplyConfig();
  cfg.byDb[dbId] = !!enabled;
  await chrome.storage.local.set({ [KEYS.autoApplyByDb]: cfg.byDb });
}

/**
 * Resolve per-DB auto-apply. Returns false if master is off OR if the user
 * has explicitly disabled the flow for this DB. Unset = default ON.
 */
export async function isAutoApplyEnabledForDb(dbId: string): Promise<boolean> {
  const cfg = await getAutoApplyConfig();
  if (!cfg.master) return false;
  if (dbId in cfg.byDb) return cfg.byDb[dbId];
  return true;
}
