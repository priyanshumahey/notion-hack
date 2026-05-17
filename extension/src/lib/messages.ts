// Single typed channel for all chrome.runtime traffic. Every message that
// crosses content↔bg↔popup must be a Msg. Discriminated unions + a tiny
// wrapper buy us refactor safety without a heavyweight RPC framework.

import type { AppEvent, CompletionCandidate } from "./types";
import type {
  NotionDatabase,
  NotionPage,
  ParentPageHit,
  RecentObservation,
  RecentWorkflow,
  RecentRun,
  AgentPickRow,
  RecentJobLead,
} from "./notion/types";
import type { JobAgentStatus } from "../background/job-agent";

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
  // popup → bg : notion (mock for now)
  | { t: "notionListDatabases" }
  | { t: "notionGetDatabase"; id: string }
  | { t: "notionListPages"; databaseId: string; limit: number }
  | { t: "notionClearAll" }
  // popup → bg : real-notion connection (Phase 1)
  | { t: "notionGetConnection" }
  | { t: "notionSetToken"; token: string }
  | { t: "notionDisconnect" }
  | { t: "notionSearchParents"; query: string }
  | { t: "notionBootstrap"; parentPageId: string; parentPageTitle: string }
  | { t: "notionTestConnection" }
  | { t: "notionObservationStats" }
  | { t: "notionListObservations"; limit: number }
  | { t: "notionListWorkflows"; limit: number }
  | { t: "notionListRuns"; limit: number }
  // popup → bg : job agent (tracer-resident)
  | { t: "jobAgentStatus" }
  | { t: "jobAgentRun"; locationHint?: string }
  | { t: "jobAgentListLeads"; limit: number }
  | { t: "jobAgentListPicks"; limit: number }
  // popup → bg : settings / health
  | { t: "getKeyStatus" }
  | { t: "setOpenAiKey"; key: string }
  | { t: "testOpenAi" }
  | { t: "getAutoApply" }
  | { t: "setAutoApply"; enabled: boolean }
  | { t: "clearLocalData" }
  | { t: "ping" };

export type MsgResponse =
  | { t: "ok" }
  | { t: "recent"; events: AppEvent[] }
  | { t: "completions"; completions: CompletionCandidate[] }
  | { t: "completion"; completion: CompletionCandidate | null }
  | { t: "notionDatabases"; workspace: string; databases: NotionDatabase[] }
  | { t: "notionDatabase"; database: NotionDatabase | null }
  | { t: "notionPages"; pages: NotionPage[] }
  | {
      t: "notionConnection";
      hasToken: boolean;
      bootstrapped: boolean;
      workspaceName: string;
      parentPageId: string;
      parentPageTitle: string;
      observationsDbId: string;
      workflowsDbId: string;
      runsDbId: string;
      redactedToken: string;
    }
  | { t: "notionParents"; results: ParentPageHit[] }
  | {
      t: "notionBootstrapped";
      observationsDbId: string;
      workflowsDbId: string;
      runsDbId: string;
    }
  | { t: "notionObservationStats"; today: number; total: number; lastError?: string }
  | { t: "notionObservations"; observations: RecentObservation[] }
  | { t: "notionWorkflows"; workflows: RecentWorkflow[] }
  | { t: "notionRuns"; runs: RecentRun[] }
  | { t: "jobAgentStatus"; status: JobAgentStatus }
  | { t: "jobAgentLeads"; leads: RecentJobLead[] }
  | { t: "jobAgentPicks"; picks: AgentPickRow[] }
  | { t: "keyStatus"; hasKey: boolean; source: "stored" | "build" | "none"; redacted: string }
  | { t: "testResult"; ok: boolean; error?: string; detail?: string }
  | { t: "autoApply"; enabled: boolean }
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
