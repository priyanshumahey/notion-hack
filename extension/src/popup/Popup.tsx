import { useEffect, useState } from "react";
import { send } from "../lib/messages";
import { RecentView } from "./views/RecentView";
import { CompletionsView } from "./views/CompletionsView";
import { NotionView } from "./views/NotionView";
import { SettingsView } from "./views/SettingsView";

type Tab = "recent" | "completions" | "notion" | "settings";

interface Pulse {
  /** ms timestamp of latest completion candidate detection. */
  latestDetectedAt: number | null;
  /** Total completions in the last 24h. */
  count24h: number;
  /** Last meaningful candidate's DB name, if any. */
  latestDbName?: string;
  /** True if a judge call is plausibly in flight (a new candidate with no judgement yet). */
  thinking: boolean;
}

export function Popup() {
  const [tab, setTab] = useState<Tab>("recent");
  const [hasKey, setHasKey] = useState<boolean | null>(null);
  const [pulse, setPulse] = useState<Pulse>({
    latestDetectedAt: null,
    count24h: 0,
    thinking: false,
  });

  async function refreshKey() {
    const resp = await send({ t: "getKeyStatus" });
    if (resp.t === "keyStatus") setHasKey(resp.hasKey);
  }

  async function refreshPulse() {
    const resp = await send({ t: "getCompletions", limit: 100 });
    if (resp.t !== "completions") return;
    const now = Date.now();
    const cutoff = now - 24 * 60 * 60_000;
    const recent24 = resp.completions.filter((c) => c.detectedAt >= cutoff);
    const latest = resp.completions[0];
    const thinking =
      !!latest &&
      latest.judgement === null &&
      latest.error === null &&
      now - latest.detectedAt < 8_000;
    setPulse({
      latestDetectedAt: latest?.detectedAt ?? null,
      count24h: recent24.length,
      latestDbName:
        recent24.find((c) => c.judgement?.meaningful && c.judgement.proposal?.database.name)
          ?.judgement?.proposal?.database.name ?? undefined,
      thinking,
    });
  }

  useEffect(() => {
    refreshKey();
    refreshPulse();
    const id = window.setInterval(refreshPulse, 2000);
    return () => window.clearInterval(id);
  }, []);

  return (
    <div className="w-[460px] h-[560px] flex flex-col bg-white text-slate-900 font-sans">
      <header className="px-4 pt-3 pb-2 border-b border-slate-200">
        <div className="flex items-center justify-between">
          <h1 className="text-base font-semibold tracking-tight">Notion Hack</h1>
          <ActivityPulse pulse={pulse} hasKey={hasKey ?? false} />
        </div>
        <nav className="mt-2 flex gap-1 text-xs">
          {(["recent", "completions", "notion", "settings"] as Tab[]).map((t) => (
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
        {tab === "notion" && <NotionView />}
        {tab === "settings" && <SettingsView onChanged={refreshKey} />}
      </main>
    </div>
  );
}

function ActivityPulse({ pulse, hasKey }: { pulse: Pulse; hasKey: boolean }) {
  if (!hasKey) {
    return <span className="text-[10px] text-slate-400 uppercase tracking-wider">idle</span>;
  }
  const { latestDetectedAt, count24h, thinking } = pulse;
  const ageMs = latestDetectedAt ? Date.now() - latestDetectedAt : null;
  const fresh = ageMs !== null && ageMs < 15_000;
  const label = thinking
    ? "thinking…"
    : latestDetectedAt
      ? formatAge(ageMs!)
      : "watching";
  const dotColor = thinking
    ? "bg-amber-500 animate-pulse"
    : fresh
      ? "bg-emerald-500 animate-pulse"
      : "bg-emerald-400";
  return (
    <span
      className="flex items-center gap-1.5 text-[10px] text-slate-500 uppercase tracking-wider"
      title={`${count24h} candidates in the last 24h`}
    >
      <span className={"inline-block w-1.5 h-1.5 rounded-full " + dotColor} />
      {label}
      <span className="text-slate-400 normal-case tracking-normal">· {count24h}/24h</span>
    </span>
  );
}

function formatAge(ms: number): string {
  if (ms < 60_000) return `${Math.floor(ms / 1000)}s ago`;
  if (ms < 60 * 60_000) return `${Math.floor(ms / 60_000)}m ago`;
  if (ms < 24 * 60 * 60_000) return `${Math.floor(ms / 3_600_000)}h ago`;
  return `${Math.floor(ms / 86_400_000)}d ago`;
}
