// Job Agent tab. One-click button kicks off the tracer-resident
// `job-prospector` function, then renders live progress + the resulting Job
// Leads as they're written.
//
// Phases:
//   collecting     → reading recent ATS visits from local IDB
//   bootstrapping  → ensuring Agent Picks + Job Leads DBs exist
//   triggering     → HMAC-signed POST to the worker webhook
//   waiting        → polling Agent Picks for the row with our Run ID
//                    (1 step/min on the worker × 4 steps ≈ 4 min)
//   promoting      → fanning leads JSON out into Job Leads rows
//   done | error   → terminal

import { useEffect, useRef, useState } from "react";
import { send } from "../../lib/messages";
import type { JobAgentStatus, JobAgentPhase } from "../../background/job-agent";
import type { RecentJobLead } from "../../lib/notion/types";

const LEADS_LIMIT = 25;

const PHASE_LABEL: Record<JobAgentPhase, string> = {
  idle: "Idle",
  collecting: "Collecting recent visits",
  bootstrapping: "Bootstrapping DBs",
  triggering: "Triggering worker",
  waiting: "Worker running (≈4 min)",
  promoting: "Writing Job Leads",
  done: "Done",
  error: "Error",
};

const ACTIVE_PHASES: ReadonlyArray<JobAgentPhase> = [
  "collecting",
  "bootstrapping",
  "triggering",
  "waiting",
  "promoting",
];

export function JobAgentView() {
  const [status, setStatus] = useState<JobAgentStatus | null>(null);
  const [leads, setLeads] = useState<RecentJobLead[]>([]);
  const [location, setLocation] = useState<string>("remote");
  const [loading, setLoading] = useState(true);
  const [running, setRunning] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const mountedRef = useRef(true);

  async function refresh() {
    const [s, l] = await Promise.all([
      send({ t: "jobAgentStatus" }),
      send({ t: "jobAgentListLeads", limit: LEADS_LIMIT }),
    ]);
    if (!mountedRef.current) return;
    if (s.t === "jobAgentStatus") setStatus(s.status);
    if (l.t === "jobAgentLeads") setLeads(l.leads);
    setLoading(false);
  }

  async function kickOff() {
    setErr(null);
    setRunning(true);
    try {
      const r = await send({ t: "jobAgentRun", locationHint: location });
      if (r.t === "jobAgentStatus") setStatus(r.status);
      else if (r.t === "error") setErr(r.message);
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setRunning(false);
    }
  }

  useEffect(() => {
    mountedRef.current = true;
    refresh();
    return () => {
      mountedRef.current = false;
    };
  }, []);

  // Poll while a run is in flight. 5s is responsive enough — the work spans
  // minutes, so we don't need sub-second updates.
  useEffect(() => {
    if (!status || !ACTIVE_PHASES.includes(status.phase)) return;
    const t = setInterval(refresh, 5000);
    return () => clearInterval(t);
  }, [status?.phase]);

  const active = status ? ACTIVE_PHASES.includes(status.phase) : false;

  return (
    <div className="h-full flex flex-col">
      {/* Hero / run controls */}
      <div className="px-4 py-3 border-b border-slate-100 bg-slate-50">
        <div className="flex items-center justify-between gap-2">
          <div>
            <h2 className="text-sm font-semibold text-slate-900">Find more jobs</h2>
            <p className="text-[11px] text-slate-500 mt-0.5 leading-snug">
              Runs a 4-step agent in the tracer worker: query → search → parse → persist.
              Takes ~4 minutes (1 step/min).
            </p>
          </div>
          <button
            onClick={kickOff}
            disabled={active || running || loading}
            className={
              "shrink-0 px-3 py-1.5 rounded-md text-xs font-medium transition-colors " +
              (active || running
                ? "bg-slate-200 text-slate-500 cursor-not-allowed"
                : "bg-slate-900 text-white hover:bg-slate-800")
            }
          >
            {active ? "Running…" : "Run agent"}
          </button>
        </div>
        <div className="mt-2 flex items-center gap-2">
          <label className="text-[11px] text-slate-500 shrink-0">Location:</label>
          <input
            type="text"
            value={location}
            onChange={(e) => setLocation(e.target.value)}
            placeholder="remote / san francisco / ny"
            className="flex-1 px-2 py-1 text-xs border border-slate-200 rounded bg-white text-slate-800 focus:outline-none focus:ring-1 focus:ring-slate-400"
            disabled={active || running}
          />
        </div>
      </div>

      {/* Status strip */}
      {status && status.phase !== "idle" && (
        <StatusStrip status={status} />
      )}

      {err && (
        <div className="px-4 py-2 bg-rose-50 border-b border-rose-200 text-xs text-rose-800">
          {err}
        </div>
      )}

      {/* Leads list */}
      <div className="px-4 py-2 flex items-center justify-between text-xs text-slate-500 border-b border-slate-100">
        <span>
          {leads.length === 0 ? "0 leads" : `${leads.length} job leads`}
        </span>
        <button
          onClick={refresh}
          disabled={loading}
          className="px-2 py-0.5 rounded border border-slate-200 hover:bg-slate-50 disabled:opacity-50"
        >
          {loading ? "…" : "refresh"}
        </button>
      </div>

      <ul className="flex-1 overflow-auto divide-y divide-slate-100">
        {leads.length === 0 && !loading && (
          <li className="px-4 py-8 text-center text-slate-400 text-sm">
            No job leads yet — click <span className="font-medium">Run agent</span> after visiting a few job pages.
          </li>
        )}
        {leads.map((l) => (
          <LeadRow key={l.id} l={l} />
        ))}
      </ul>
    </div>
  );
}

function StatusStrip({ status }: { status: JobAgentStatus }) {
  const isActive = ACTIVE_PHASES.includes(status.phase);
  const bg =
    status.phase === "error"
      ? "bg-rose-50 border-rose-200 text-rose-800"
      : status.phase === "done"
        ? "bg-emerald-50 border-emerald-200 text-emerald-900"
        : "bg-sky-50 border-sky-200 text-sky-900";
  const elapsed = status.startedAt
    ? Math.floor((Date.now() - status.startedAt) / 1000)
    : 0;
  return (
    <div className={"px-4 py-2 border-b text-xs " + bg}>
      <div className="flex items-center gap-2">
        {isActive && <Spinner />}
        <span className="font-medium">{PHASE_LABEL[status.phase]}</span>
        <span className="opacity-70">·</span>
        <span className="truncate flex-1">{status.message}</span>
        {isActive && elapsed > 0 && (
          <span className="tabular-nums opacity-60 shrink-0">
            {formatElapsed(elapsed)}
          </span>
        )}
      </div>
      {status.error && (
        <div className="mt-1 ml-5 text-rose-700 break-all">{status.error}</div>
      )}
      {status.query && status.phase !== "error" && (
        <div className="mt-1 ml-5 italic opacity-80 truncate" title={status.query}>
          “{status.query}”
        </div>
      )}
    </div>
  );
}

function LeadRow({ l }: { l: RecentJobLead }) {
  const href = l.sourceUrl || l.url;
  return (
    <li className="px-4 py-2 text-xs">
      <div className="flex items-baseline gap-2">
        <SourceBadge source={l.source} />
        <a
          href={href}
          target="_blank"
          rel="noreferrer noopener"
          className="truncate font-medium text-slate-800 hover:underline flex-1"
          title={l.title}
        >
          {l.title}
        </a>
        {typeof l.score === "number" && l.score > 0 && (
          <ScoreBadge score={l.score} />
        )}
      </div>
      <div className="ml-[52px] mt-0.5 flex items-center gap-2 text-slate-500 flex-wrap">
        {l.company && <span className="shrink-0">{l.company}</span>}
        <StatusBadge status={l.status} />
        {l.foundAt > 0 && (
          <span className="text-slate-400 tabular-nums">
            {relativeTime(l.foundAt)}
          </span>
        )}
        {l.url && (
          <a
            href={l.url}
            target="_blank"
            rel="noreferrer noopener"
            className="ml-auto text-sky-700 hover:underline shrink-0"
          >
            notion ↗
          </a>
        )}
      </div>
    </li>
  );
}

const SOURCE_COLORS: Record<string, string> = {
  agent: "bg-purple-100 text-purple-800",
  visited: "bg-sky-100 text-sky-800",
};

function SourceBadge({ source }: { source: string }) {
  const cls = SOURCE_COLORS[source] ?? "bg-slate-200 text-slate-700";
  return (
    <span
      className={
        "px-1.5 py-0.5 rounded text-[10px] font-medium uppercase tracking-wide shrink-0 w-12 text-center " +
        cls
      }
    >
      {source || "—"}
    </span>
  );
}

const LEAD_STATUS_COLORS: Record<string, string> = {
  new: "bg-slate-100 text-slate-700",
  reviewed: "bg-sky-100 text-sky-800",
  applied: "bg-emerald-100 text-emerald-800",
  archived: "bg-slate-100 text-slate-400",
};

function StatusBadge({ status }: { status: string }) {
  const cls = LEAD_STATUS_COLORS[status] ?? "bg-slate-100 text-slate-600";
  return (
    <span
      className={
        "px-1.5 py-0.5 rounded text-[10px] font-medium uppercase tracking-wide " +
        cls
      }
    >
      {status || "new"}
    </span>
  );
}

function ScoreBadge({ score }: { score: number }) {
  const cls =
    score >= 80
      ? "bg-emerald-50 text-emerald-700 border-emerald-200"
      : score >= 50
        ? "bg-amber-50 text-amber-700 border-amber-200"
        : "bg-slate-50 text-slate-600 border-slate-200";
  return (
    <span
      className={
        "ml-auto shrink-0 px-1.5 py-0.5 rounded border text-[10px] tabular-nums " +
        cls
      }
      title="LLM confidence (0-100)"
    >
      {score}
    </span>
  );
}

function Spinner() {
  return (
    <span
      className="inline-block w-3 h-3 border-2 border-slate-300 border-t-slate-700 rounded-full animate-spin shrink-0"
      aria-hidden
    />
  );
}

function formatElapsed(s: number): string {
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  const rem = s % 60;
  return `${m}m${rem.toString().padStart(2, "0")}s`;
}

function relativeTime(ts: number): string {
  const diff = Date.now() - ts;
  if (diff < 0) return "now";
  const sec = Math.floor(diff / 1000);
  if (sec < 60) return `${sec}s`;
  const m = Math.floor(sec / 60);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h`;
  const d = Math.floor(h / 24);
  return `${d}d`;
}
