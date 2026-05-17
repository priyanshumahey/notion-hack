// Real Notion Workflows tab. Lists rows from the Workflows DB (under the
// user's Notion Dance parent page) so they can see which workflows are
// currently auto-saving pages, paused, etc. SW proxies the Notion call.

import { useEffect, useRef, useState } from "react";
import { send } from "../../lib/messages";
import type { RecentWorkflow } from "../../lib/notion/types";

const LIMIT = 20;

export function WorkflowsView() {
  const [rows, setRows] = useState<RecentWorkflow[]>([]);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState<string | null>(null);
  const [bootstrapped, setBootstrapped] = useState<boolean | null>(null);
  const mountedRef = useRef(true);

  async function refresh() {
    setErr(null);
    setLoading(true);
    const [conn, wfs] = await Promise.all([
      send({ t: "notionGetConnection" }),
      send({ t: "notionListWorkflows", limit: LIMIT }),
    ]);
    if (!mountedRef.current) return;
    if (conn.t === "notionConnection") setBootstrapped(conn.bootstrapped);
    if (wfs.t === "notionWorkflows") {
      setRows(wfs.workflows);
    } else if (wfs.t === "error") {
      setErr(wfs.message);
    }
    setLoading(false);
  }

  useEffect(() => {
    mountedRef.current = true;
    refresh();
    return () => {
      mountedRef.current = false;
    };
  }, []);

  return (
    <div className="h-full flex flex-col">
      <div className="px-4 py-2 flex items-center justify-between text-xs text-slate-500 border-b border-slate-100">
        <span>
          {rows.length === 0 && !loading ? "0 workflows" : `${rows.length} workflows`}
          {err ? <span className="text-rose-600"> · {err}</span> : null}
        </span>
        <button
          onClick={refresh}
          disabled={loading}
          className="px-2 py-0.5 rounded border border-slate-200 hover:bg-slate-50 disabled:opacity-50"
        >
          {loading ? "…" : "refresh"}
        </button>
      </div>

      {bootstrapped === false && (
        <div className="px-4 py-3 text-xs text-amber-800 bg-amber-50 border-b border-amber-200">
          Connect Notion in Settings first.
        </div>
      )}

      <ul className="flex-1 overflow-auto divide-y divide-slate-100">
        {rows.length === 0 && !loading && bootstrapped !== false && (
          <li className="px-4 py-8 text-center text-slate-400 text-sm">
            No workflows yet — confirm a completion prompt to create one.
          </li>
        )}
        {rows.map((w) => (
          <WorkflowRow key={w.id} w={w} />
        ))}
      </ul>
    </div>
  );
}

function WorkflowRow({ w }: { w: RecentWorkflow }) {
  const rel = w.approvedAt ? relativeTime(w.approvedAt) : "";
  const abs = w.approvedAt
    ? new Date(w.approvedAt).toLocaleString(undefined, { hour12: false })
    : "";
  return (
    <li className="px-4 py-2 text-xs">
      <div className="flex items-baseline gap-2">
        <span className="text-slate-400 tabular-nums w-16 shrink-0" title={abs}>
          {rel}
        </span>
        <StatusBadge status={w.status} />
        <a
          href={w.url}
          target="_blank"
          rel="noreferrer noopener"
          className="truncate font-medium text-slate-800 hover:underline"
          title={w.name}
        >
          {w.name}
        </a>
        <RunModeBadge mode={w.runMode} />
      </div>
      <div className="ml-[72px] mt-0.5 flex items-center gap-2 text-slate-500 flex-wrap">
        {w.targetDatabaseName && (
          <span className="shrink-0">→ {w.targetDatabaseName}</span>
        )}
        {w.runCount > 0 && (
          <span className="shrink-0 text-[10px] text-slate-600">
            {w.runCount} run{w.runCount === 1 ? "" : "s"}
          </span>
        )}
        {w.sourceApps.length > 0 && (
          <span className="truncate text-slate-500 shrink-0" title={w.sourceApps.join(", ")}>
            from {w.sourceApps.slice(0, 2).join(", ")}
            {w.sourceApps.length > 2 ? ` +${w.sourceApps.length - 2}` : ""}
          </span>
        )}
      </div>
      {w.reasoning && (
        <div className="ml-[72px] mt-0.5 text-slate-500 line-clamp-2" title={w.reasoning}>
          {w.reasoning}
        </div>
      )}
    </li>
  );
}

const STATUS_COLORS: Record<string, string> = {
  active: "bg-emerald-100 text-emerald-800",
  paused: "bg-amber-100 text-amber-800",
  proposed: "bg-slate-100 text-slate-700",
  archived: "bg-slate-100 text-slate-500",
};

function StatusBadge({ status }: { status: string }) {
  const cls = STATUS_COLORS[status] ?? "bg-slate-200 text-slate-700";
  return (
    <span
      className={
        "px-1.5 py-0.5 rounded text-[10px] font-medium uppercase tracking-wide shrink-0 " +
        cls
      }
    >
      {status || "—"}
    </span>
  );
}

function RunModeBadge({ mode }: { mode: string }) {
  return (
    <span
      className="ml-auto shrink-0 px-1.5 py-0.5 rounded border border-slate-200 bg-slate-50 text-[10px] text-slate-600"
      title="run mode"
    >
      {mode || "ask"}
    </span>
  );
}

function relativeTime(ts: number): string {
  const diff = Date.now() - ts;
  if (diff < 0) return "now";
  const s = Math.floor(diff / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h`;
  const d = Math.floor(h / 24);
  return `${d}d`;
}
