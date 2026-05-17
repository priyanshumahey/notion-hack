// Single typed channel for all chrome.runtime traffic. Every message that
// crosses content↔bg↔popup must be a Msg. Discriminated unions + a tiny
// wrapper buy us refactor safety without a heavyweight RPC framework.

import type { AppEvent, CompletionCandidate } from "./types";
import type { NotionDatabase, NotionPage } from "./notion/types";
import type { HybridActionOverride } from "./types";

export type Msg =
  // content → bg
  | { t: "evt"; event: import("./types").RawEvent }
  | { t: "setCompletionStatus"; id: string; status: "dismissed" | "promoted" }
  // bg → content
  | {
      t: "completionPrompt";
      id: string;
      reason: CompletionCandidate["reason"];
      databaseName?: string;
      confidence?: number;
      triggerKind?: CompletionCandidate["trigger"]["kind"];
      site?: string;
      pageTitle?: string;
      targetLabel?: string;
      triggerNote?: string;
      reasoning?: string;
    }
  // popup → bg : events
  | { t: "getRecent"; limit: number }
  | { t: "clearAll" }
  // popup → bg : completions
  | { t: "getCompletions"; limit: number }
  | { t: "getCompletion"; id: string }
  | { t: "retryJudge"; id: string }
  | { t: "deleteCompletion"; id: string }
  | { t: "clearCompletions" }
  | { t: "applyCandidate"; id: string }
  | { t: "denyCandidate"; id: string }
  | { t: "setHybridAction"; id: string; action: HybridActionOverride }
  // popup → bg : notion (mock for now)
  | { t: "notionListDatabases" }
  | { t: "notionGetDatabase"; id: string }
  | { t: "notionListPages"; databaseId: string; limit: number }
  | { t: "notionClearAll" }
  // popup → bg : settings / health
  | { t: "getKeyStatus" }
  | { t: "setOpenAiKey"; key: string }
  | { t: "testOpenAi" }
  | { t: "ping" };

export type MsgResponse =
  | { t: "ok" }
  | { t: "recent"; events: AppEvent[] }
  | { t: "completions"; completions: CompletionCandidate[] }
  | { t: "completion"; completion: CompletionCandidate | null }
  | { t: "notionDatabases"; workspace: string; databases: NotionDatabase[] }
  | { t: "notionDatabase"; database: NotionDatabase | null }
  | { t: "notionPages"; pages: NotionPage[] }
  | { t: "keyStatus"; hasKey: boolean; source: "stored" | "build" | "none"; redacted: string }
  | { t: "testResult"; ok: boolean; error?: string }
  | { t: "pong"; at: number }
  | { t: "error"; message: string };

/** Fire-and-forget OR awaited send from any context. */
export function send<T extends Msg>(msg: T): Promise<MsgResponse> {
  return new Promise((resolve) => {
    try {
      chrome.runtime.sendMessage(msg, (resp: MsgResponse | undefined) => {
        if (chrome.runtime.lastError) {
          const m = chrome.runtime.lastError.message ?? "unknown";
          // "Extension context invalidated" fires in content scripts of
          // tabs that were open when the extension was reloaded. Once
          // this happens NO further sends from this script will work —
          // the page must be reloaded. Mark a flag so callers can stop
          // trying.
          if (m.toLowerCase().includes("context invalidated")) {
            (globalThis as { __nhDead?: boolean }).__nhDead = true;
          }
          resolve({ t: "error", message: m });
          return;
        }
        resolve(resp ?? { t: "ok" });
      });
    } catch (e) {
      const m = (e as Error).message;
      if (m.toLowerCase().includes("context invalidated")) {
        (globalThis as { __nhDead?: boolean }).__nhDead = true;
      }
      resolve({ t: "error", message: m });
    }
  });
}

/** True once `send` has seen an "Extension context invalidated" error. */
export function isDeadContext(): boolean {
  return !!(globalThis as { __nhDead?: boolean }).__nhDead;
}
