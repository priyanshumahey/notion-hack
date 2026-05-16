// Single typed channel for all chrome.runtime traffic. Every message that
// crosses content↔bg↔popup must be a Msg. Discriminated unions + a tiny
// wrapper buy us refactor safety without a heavyweight RPC framework.

import type { AppEvent, CompletionCandidate } from "./types";

export type Msg =
  // content → bg
  | { t: "evt"; event: import("./types").RawEvent }
  // popup → bg : events
  | { t: "getRecent"; limit: number }
  | { t: "clearAll" }
  // popup → bg : completions
  | { t: "getCompletions"; limit: number }
  | { t: "getCompletion"; id: string }
  | { t: "retryJudge"; id: string }
  | { t: "deleteCompletion"; id: string }
  | { t: "clearCompletions" }
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
          // Background may be cold or page may be unprivileged. Don't throw.
          resolve({ t: "error", message: chrome.runtime.lastError.message ?? "unknown" });
          return;
        }
        resolve(resp ?? { t: "ok" });
      });
    } catch (e) {
      resolve({ t: "error", message: (e as Error).message });
    }
  });
}
