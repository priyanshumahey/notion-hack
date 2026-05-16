// Typed wrapper over chrome.storage.local for app settings.
//
// Resolution order for the OpenAI key when callers ask `getOpenAiKey()`:
//   1. chrome.storage.local.openaiKey (set via Settings UI) — wins
//   2. __OPENAI_KEY_BUILD__ injected by Vite from `.env` at build time
//   3. "" — features that require a key must refuse to run

const KEYS = {
  openaiKey: "openaiKey",
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
