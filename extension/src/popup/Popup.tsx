import { useEffect, useState } from "react";
import { send } from "../lib/messages";
import { RecentView } from "./views/RecentView";
import { CompletionsView } from "./views/CompletionsView";
import { ObservationsView } from "./views/ObservationsView";
import { WorkflowsView } from "./views/WorkflowsView";
import { RunsView } from "./views/RunsView";
import { JobAgentView } from "./views/JobAgentView";
import { SettingsView } from "./views/SettingsView";

type Tab =
  | "recent"
  | "observations"
  | "completions"
  | "workflows"
  | "runs"
  | "jobs"
  | "settings";

interface NotionStatus {
  hasToken: boolean;
  bootstrapped: boolean;
  observationsDbId: string;
  today: number;
  lastError?: string;
}

export function Popup() {
  const [tab, setTab] = useState<Tab>("recent");
  const [hasKey, setHasKey] = useState<boolean | null>(null);
  const [notion, setNotion] = useState<NotionStatus | null>(null);

  async function refreshKey() {
    const resp = await send({ t: "getKeyStatus" });
    if (resp.t === "keyStatus") setHasKey(resp.hasKey);
  }

  async function refreshNotion() {
    const [conn, stats] = await Promise.all([
      send({ t: "notionGetConnection" }),
      send({ t: "notionObservationStats" }),
    ]);
    if (conn.t !== "notionConnection") return;
    const s: NotionStatus = {
      hasToken: conn.hasToken,
      bootstrapped: conn.bootstrapped,
      observationsDbId: conn.observationsDbId,
      today: 0,
    };
    if (stats.t === "notionObservationStats") {
      s.today = stats.today;
      s.lastError = stats.lastError;
    }
    setNotion(s);
  }

  useEffect(() => {
    refreshKey();
    refreshNotion();
    // If the user opened the popup by clicking a desktop notification, the
    // service worker stashed a routing intent — pick it up once and clear.
    (async () => {
      try {
        const r = await chrome.storage.local.get(["popupIntent"]);
        const intent = r.popupIntent as
          | { tab?: Tab; candidateId?: string; at?: number }
          | undefined;
        if (intent?.tab && Date.now() - (intent.at ?? 0) < 5 * 60_000) {
          setTab(intent.tab);
        }
        if (intent) await chrome.storage.local.remove(["popupIntent"]);
      } catch {
        /* non-fatal */
      }
    })();
  }, []);

  // Re-pull notion status whenever the user re-opens the popup; tab switches
  // also re-pull so the "X today" banner stays fresh after a long session.
  useEffect(() => {
    refreshNotion();
  }, [tab]);

  const observationsUrl = notion?.observationsDbId
    ? `https://www.notion.so/${notion.observationsDbId.replace(/-/g, "")}`
    : "";

  return (
    <div className="w-[460px] h-[560px] flex flex-col bg-white text-slate-900 font-sans">
      <header className="px-4 pt-3 pb-2 border-b border-slate-200">
        <div className="flex items-center justify-between">
          <h1 className="text-base font-semibold tracking-tight">Notion Hack</h1>
          <span className="text-[10px] text-slate-400 uppercase tracking-wider">M1 · observe</span>
        </div>
        <nav className="mt-2 flex gap-1 text-xs">
          {(
            [
              "recent",
              "observations",
              "completions",
              "workflows",
              "runs",
              "jobs",
              "settings",
            ] as Tab[]
          ).map((t) => (
            <button
              key={t}
              onClick={() => setTab(t)}
              className={
                "px-2 py-1 rounded-md transition-colors " +
                (tab === t
                  ? "bg-slate-900 text-white"
                  : "text-slate-600 hover:bg-slate-100")
              }
            >
              {t}
            </button>
          ))}
        </nav>
      </header>

      {hasKey === false && tab !== "settings" && (
        <div className="px-4 py-2 bg-rose-50 border-b border-rose-200 text-xs text-rose-800 flex items-center justify-between">
          <span>OpenAI key required for completion detection.</span>
          <button
            onClick={() => setTab("settings")}
            className="px-2 py-0.5 rounded border border-rose-300 hover:bg-rose-100"
          >
            open settings
          </button>
        </div>
      )}

      {hasKey !== false && notion && !notion.bootstrapped && tab !== "settings" && (
        <div className="px-4 py-2 bg-amber-50 border-b border-amber-200 text-xs text-amber-900 flex items-center justify-between">
          <span>
            {notion.hasToken
              ? "Notion token saved — pick a parent page to start logging Observations."
              : "Connect Notion to start logging Observations."}
          </span>
          <button
            onClick={() => setTab("settings")}
            className="px-2 py-0.5 rounded border border-amber-300 hover:bg-amber-100"
          >
            open settings
          </button>
        </div>
      )}

      {notion?.bootstrapped && tab !== "settings" && (
        <div className="px-4 py-1.5 bg-emerald-50 border-b border-emerald-200 text-[11px] text-emerald-900 flex items-center justify-between">
          <span>
            {notion.today === 0
              ? "Logging observations to Notion."
              : `${notion.today} observation${notion.today === 1 ? "" : "s"} logged today.`}
          </span>
          {observationsUrl && (
            <a
              href={observationsUrl}
              target="_blank"
              rel="noreferrer"
              className="underline hover:text-emerald-700"
            >
              view in Notion ↗
            </a>
          )}
        </div>
      )}

      <main className="flex-1 min-h-0 overflow-hidden">
        {tab === "recent" && <RecentView />}
        {tab === "observations" && <ObservationsView />}
        {tab === "completions" && (
          <CompletionsView
            hasKey={hasKey ?? false}
            onNeedKey={() => setTab("settings")}
            onOpenNotion={() => setTab("runs")}
          />
        )}
        {tab === "workflows" && <WorkflowsView />}
        {tab === "runs" && <RunsView />}
        {tab === "jobs" && <JobAgentView />}
        {tab === "settings" && (
          <SettingsView
            onChanged={() => {
              refreshKey();
              refreshNotion();
            }}
          />
        )}
      </main>
    </div>
  );
}
