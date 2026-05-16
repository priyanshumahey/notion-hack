import { useEffect, useRef, useState } from "react";
import { send } from "../../lib/messages";
import type { AppEvent } from "../../lib/types";

const REFRESH_MS = 1000;
const LIMIT = 100;

export function RecentView() {
  const [events, setEvents] = useState<AppEvent[]>([]);
  const [err, setErr] = useState<string | null>(null);
  const timerRef = useRef<number | null>(null);

  async function refresh() {
    const resp = await send({ t: "getRecent", limit: LIMIT });
    if (resp.t === "recent") {
      setEvents(resp.events);
      setErr(null);
    } else if (resp.t === "error") {
      setErr(resp.message);
    }
  }

  useEffect(() => {
    refresh();
    timerRef.current = window.setInterval(refresh, REFRESH_MS);
    return () => {
      if (timerRef.current) window.clearInterval(timerRef.current);
    };
  }, []);

  async function clearAll() {
    if (!confirm("Clear all captured events?")) return;
    await send({ t: "clearAll" });
    refresh();
  }

  return (
    <div className="h-full flex flex-col">
      <div className="px-4 py-2 flex items-center justify-between text-xs text-slate-500 border-b border-slate-100">
        <span>
          {events.length} events {err ? <span className="text-rose-600">· {err}</span> : null}
        </span>
        <div className="flex gap-2">
          <button onClick={refresh} className="px-2 py-0.5 rounded border border-slate-200 hover:bg-slate-50">
            refresh
          </button>
          <button
            onClick={clearAll}
            className="px-2 py-0.5 rounded border border-rose-200 text-rose-700 hover:bg-rose-50"
          >
            clear
          </button>
        </div>
      </div>
      <ul className="flex-1 overflow-auto divide-y divide-slate-100">
        {events.length === 0 && (
          <li className="px-4 py-8 text-center text-slate-400 text-sm">
            No events yet — interact with any web page.
          </li>
        )}
        {events.map((ev) => (
          <EventRow key={ev.id} ev={ev} />
        ))}
      </ul>
    </div>
  );
}

function EventRow({ ev }: { ev: AppEvent }) {
  const fp = ev.fingerprint;
  const label =
    fp?.accessibleName ||
    fp?.text ||
    fp?.testid ||
    fp?.hrefPattern ||
    (fp?.role ? `<${fp.role}>` : null) ||
    (fp?.tag ? `<${fp.tag}>` : null) ||
    (ev.kind === "page-dwell" ? ev.pageContext?.title || "(dwell)" : null) ||
    "—";

  const t = new Date(ev.ts);
  const time = t.toLocaleTimeString(undefined, { hour12: false });

  const dwell = ev.kind === "page-dwell" ? (ev.meta as Record<string, unknown> | undefined) : undefined;

  return (
    <li className="px-4 py-1.5 text-xs">
      <div className="flex items-baseline gap-2">
        <span className="text-slate-400 tabular-nums w-16 shrink-0">{time}</span>
        <KindBadge kind={ev.kind} />
        <span className="truncate font-medium text-slate-800" title={label}>
          {label}
        </span>
        {ev.pageContext && (
          <span
            className="text-slate-400 shrink-0"
            title={`page context captured · ${ev.pageContext.headings.length} headings · ${ev.pageContext.jsonLd.length} JSON-LD blocks`}
          >
            📄
          </span>
        )}
        {ev.formContext && (
          <span
            className="text-slate-400 shrink-0"
            title={`form context: ${ev.formContext.fields.length} fields`}
          >
            📝
          </span>
        )}
      </div>
      <div className="ml-[72px] mt-0.5 text-slate-500 truncate" title={ev.pageKey}>
        {ev.pageKey}
        {ev.meta && (ev.meta as { source?: string }).source ? (
          <span className="ml-1 text-slate-400">· {(ev.meta as { source?: string }).source}</span>
        ) : null}
        {dwell ? (
          <span className="ml-1 text-slate-400">
            · {Math.round(Number(dwell.foregroundMs) / 1000)}s fg
            {Number(dwell.maxScrollPct) > 0 ? ` · scroll ${dwell.maxScrollPct}%` : ""}
            {Number(dwell.interactionCount) > 0 ? ` · ${dwell.interactionCount} acts` : ""}
            {dwell.reason ? ` · ${dwell.reason}` : ""}
          </span>
        ) : null}
      </div>
    </li>
  );
}

function KindBadge({ kind }: { kind: AppEvent["kind"] }) {
  const color: Record<AppEvent["kind"], string> = {
    nav: "bg-sky-100 text-sky-800",
    click: "bg-violet-100 text-violet-800",
    submit: "bg-emerald-100 text-emerald-800",
    "input-edited": "bg-amber-100 text-amber-800",
    "key-shortcut": "bg-slate-200 text-slate-700",
    "page-dwell": "bg-teal-100 text-teal-800",
  };
  return (
    <span
      className={
        "px-1.5 py-0.5 rounded text-[10px] font-medium uppercase tracking-wide shrink-0 " +
        color[kind]
      }
    >
      {kind}
    </span>
  );
}
