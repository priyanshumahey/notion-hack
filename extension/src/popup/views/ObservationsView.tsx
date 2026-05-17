// Real Notion Observations tab. Shows the most recent rows from the user's
// Observations DB so they can verify the ingest pipeline without flipping
// over to Notion. Hits the SW which proxies to api.notion.com — keep page
// sizes small (default 10) to stay under quota.

import { useEffect, useRef, useState } from "react";
import { send } from "../../lib/messages";
import type { RecentObservation } from "../../lib/notion/types";

const LIMIT = 10;

export function ObservationsView() {
  const [rows, setRows] = useState<RecentObservation[]>([]);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState<string | null>(null);
  const [bootstrapped, setBootstrapped] = useState<boolean | null>(null);
  const mountedRef = useRef(true);

  async function refresh() {
    setErr(null);
    setLoading(true);
    const [conn, obs] = await Promise.all([
      send({ t: "notionGetConnection" }),
      send({ t: "notionListObservations", limit: LIMIT }),
    ]);
    if (!mountedRef.current) return;
    if (conn.t === "notionConnection") setBootstrapped(conn.bootstrapped);
    if (obs.t === "notionObservations") {
      setRows(obs.observations);
    } else if (obs.t === "error") {
      setErr(obs.message);
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
          {rows.length === 0 && !loading
            ? "0 observations"
            : `last ${rows.length}`}
          {err ? <span className="text-rose-600"> · {err}</span> : null}
        </span>
        <div className="flex gap-2">
          <button
            onClick={refresh}
            disabled={loading}
            className="px-2 py-0.5 rounded border border-slate-200 hover:bg-slate-50 disabled:opacity-50"
          >
            {loading ? "…" : "refresh"}
          </button>
        </div>
      </div>

      {bootstrapped === false && (
        <div className="px-4 py-3 text-xs text-amber-800 bg-amber-50 border-b border-amber-200">
          Connect Notion in Settings first.
        </div>
      )}

      <ul className="flex-1 overflow-auto divide-y divide-slate-100">
        {rows.length === 0 && !loading && bootstrapped !== false && (
          <li className="px-4 py-8 text-center text-slate-400 text-sm">
            No observations yet — dwell 15s+ on a real article page to capture one.
          </li>
        )}
        {rows.map((o) => (
          <ObservationRow key={o.id} o={o} />
        ))}
      </ul>
    </div>
  );
}

function ObservationRow({ o }: { o: RecentObservation }) {
  const rel = o.capturedAt ? relativeTime(o.capturedAt) : "";
  const abs = o.capturedAt
    ? new Date(o.capturedAt).toLocaleString(undefined, { hour12: false })
    : "";
  return (
    <li className="px-4 py-2 text-xs">
      <div className="flex items-baseline gap-2">
        <span
          className="text-slate-400 tabular-nums w-16 shrink-0"
          title={abs}
        >
          {rel}
        </span>
        <TriggerBadge kind={o.triggerKind} />
        <a
          href={o.url}
          target="_blank"
          rel="noreferrer noopener"
          className="truncate font-medium text-slate-800 hover:underline"
          title={o.name}
        >
          {o.name}
        </a>
        {typeof o.confidence === "number" && (
          <ConfidenceBadge value={o.confidence} />
        )}
      </div>
      <div className="ml-[72px] mt-0.5 flex items-center gap-2 text-slate-500">
        {o.host && (
          <span className="text-slate-500 shrink-0">{o.host}</span>
        )}
        {o.pageType && (
          <span className="px-1.5 py-0.5 rounded bg-slate-100 text-[10px] text-slate-700 shrink-0">
            {o.pageType}
          </span>
        )}
        {o.sourceUrl && (
          <a
            href={o.sourceUrl}
            target="_blank"
            rel="noreferrer noopener"
            className="truncate text-sky-700 hover:underline"
            title={o.sourceUrl}
          >
            source ↗
          </a>
        )}
      </div>
    </li>
  );
}

const TRIGGER_COLORS: Record<string, string> = {
  "form-submit": "bg-emerald-100 text-emerald-800",
  "terminal-nav": "bg-violet-100 text-violet-800",
  "content-dwell": "bg-teal-100 text-teal-800",
  repetition: "bg-amber-100 text-amber-800",
  "action-click": "bg-sky-100 text-sky-800",
  "rich-page": "bg-pink-100 text-pink-800",
};

function TriggerBadge({ kind }: { kind: string }) {
  const cls = TRIGGER_COLORS[kind] ?? "bg-slate-200 text-slate-700";
  return (
    <span
      className={
        "px-1.5 py-0.5 rounded text-[10px] font-medium uppercase tracking-wide shrink-0 " +
        cls
      }
    >
      {kind || "—"}
    </span>
  );
}

function ConfidenceBadge({ value }: { value: number }) {
  // 0..1 → color band. 0.85+ green, 0.6+ slate, <0.6 amber.
  const cls =
    value >= 0.85
      ? "bg-emerald-50 text-emerald-700 border-emerald-200"
      : value >= 0.6
        ? "bg-slate-50 text-slate-700 border-slate-200"
        : "bg-amber-50 text-amber-700 border-amber-200";
  return (
    <span
      className={
        "ml-auto shrink-0 px-1.5 py-0.5 rounded border text-[10px] tabular-nums " +
        cls
      }
      title="local confidence (0..1)"
    >
      {value.toFixed(2)}
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
