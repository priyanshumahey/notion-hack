import { useEffect, useState } from "react";
import { send } from "../lib/messages";
import { RecentView } from "./views/RecentView";
import { CompletionsView } from "./views/CompletionsView";
import { ConnectorsView } from "./views/ConnectorsView";
import { NotionView } from "./views/NotionView";
import { SettingsView } from "./views/SettingsView";

type Tab = "recent" | "completions" | "connectors" | "notion" | "settings";

export function Popup() {
  const [tab, setTab] = useState<Tab>("recent");
  const [hasKey, setHasKey] = useState<boolean | null>(null);

  async function refreshKey() {
    const resp = await send({ t: "getKeyStatus" });
    if (resp.t === "keyStatus") setHasKey(resp.hasKey);
  }

  useEffect(() => {
    refreshKey();
  }, []);

  return (
    <div className="w-[460px] h-[560px] flex flex-col bg-white text-slate-900 font-sans">
      <header className="px-4 pt-3 pb-2 border-b border-slate-200">
        <div className="flex items-center justify-between">
          <h1 className="text-base font-semibold tracking-tight">Notion Hack</h1>
          <span className="text-[10px] text-slate-400 uppercase tracking-wider">M0 · detect</span>
        </div>
        <nav className="mt-2 flex gap-1 text-xs">
          {(["recent", "completions", "connectors", "notion", "settings"] as Tab[]).map((t) => (
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

      <main className="flex-1 min-h-0 overflow-hidden">
        {tab === "recent" && <RecentView />}
        {tab === "completions" && (
          <CompletionsView
            hasKey={hasKey ?? false}
            onNeedKey={() => setTab("settings")}
            onOpenNotion={() => setTab("notion")}
          />
        )}
        {tab === "connectors" && (
          <ConnectorsView onOpenCompletions={() => setTab("completions")} />
        )}
        {tab === "notion" && <NotionView />}
        {tab === "settings" && <SettingsView onChanged={refreshKey} />}
      </main>
    </div>
  );
}
