// Real Notion Runs tab. One row per attempt to apply a workflow — confirmed
// (user clicked yes), auto (cluster-approved), dismissed (user clicked no),
// or failed (exception during the apply call). SW proxies the Notion list.

import { useEffect, useRef, useState } from "react";
import { send } from "../../lib/messages";
import type { RecentRun } from "../../lib/notion/types";

const LIMIT = 20;

export function RunsView() {
  const [rows, setRows] = useState<RecentRun[]>([]);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState<string | null>(null);
  const [bootstrapped, setBootstrapped] = useState<boolean | null>(null);
  const mountedRef = useRef(true);

  async function refresh() {
    setErr(null);
    setLoading(true);
    const [conn, runs] = await Promise.all([
      send({ t: "notionGetConnection" }),
      send({ t: "notionListRuns", limit: LIMIT }),
    ]);
    if (!mountedRef.current) return;
    if (conn.t === "notionConnection") setBootstrapped(conn.bootstrapped);
    if (runs.t === "notionRuns") {
      setRows(runs.runs);
    } else if (runs.t === "error") {
      setErr(runs.message);
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
          {rows.length === 0 && !loading ? "0 runs" : `${rows.length} runs`}
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
            No runs yet — confirm a completion prompt to create one.
          </li>
        )}
        {rows.map((r) => (
          <RunRow key={r.id} r={r} />
        ))}
      </ul>
    </div>
  );
}

function RunRow({ r }: { r: RecentRun }) {
  const rel = r.triggeredAt ? relativeTime(r.triggeredAt) : "";
  const abs = r.triggeredAt
    ? new Date(r.triggeredAt).toLocaleString(undefined, { hour12: false })
    : "";
  return (
    <li className="px-4 py-2 text-xs">
      <div className="flex items-baseline gap-2">
        <span className="text-slate-400 tabular-nums w-16 shrink-0" title={abs}>
          {rel}
        </span>
        <StatusBadge status={r.status} />
        <a
          href={r.url}
          target="_blank"
          rel="noreferrer noopener"
          className="truncate font-medium text-slate-800 hover:underline"
          title={r.workflowName || r.name}
        >
          {r.workflowName || r.name}
        </a>
        {typeof r.latencyMs === "number" && (
          <LatencyBadge ms={r.latencyMs} />
        )}
      </div>
      <div className="ml-[72px] mt-0.5 flex items-center gap-2 text-slate-500 flex-wrap">
        {r.createdPageUrl && (
          <a
            href={r.createdPageUrl}
            target="_blank"
            rel="noreferrer noopener"
            className="truncate text-emerald-700 hover:underline shrink-0"
            title={r.createdPageUrl}
          >
            created page ↗
          </a>
        )}
        {r.pageUrl && (
          <a
            href={r.pageUrl}
            target="_blank"
            rel="noreferrer noopener"
            className="truncate text-sky-700 hover:underline shrink-0"
            title={r.pageUrl}
          >
            source ↗
          </a>
        )}
      </div>
      {r.error && (
        <div className="ml-[72px] mt-0.5 text-rose-700 line-clamp-2" title={r.error}>
          {r.error}
        </div>
      )}
    </li>
  );
}

const STATUS_COLORS: Record<string, string> = {
  confirmed: "bg-emerald-100 text-emerald-800",
  auto: "bg-sky-100 text-sky-800",
  proposed: "bg-slate-100 text-slate-700",
  dismissed: "bg-slate-100 text-slate-500",
  failed: "bg-rose-100 text-rose-800",
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

function LatencyBadge({ ms }: { ms: number }) {
  const cls =
    ms < 1500
      ? "bg-slate-50 text-slate-600 border-slate-200"
      : ms < 4000
        ? "bg-amber-50 text-amber-700 border-amber-200"
        : "bg-rose-50 text-rose-700 border-rose-200";
  return (
    <span
      className={
        "ml-auto shrink-0 px-1.5 py-0.5 rounded border text-[10px] tabular-nums " +
        cls
      }
      title="round-trip latency to Notion"
    >
      {(ms / 1000).toFixed(2)}s
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
