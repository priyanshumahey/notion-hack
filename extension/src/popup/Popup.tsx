import { useEffect, useRef, useState } from "react";
import { send } from "../lib/messages";
import type { AppEvent } from "../lib/types";
import { makeLog } from "../lib/log";

const log = makeLog("popup");

type Tab = "recent" | "workflows" | "settings";
const REFRESH_MS = 1000;
const LIMIT = 100;

export function Popup() {
  const [tab, setTab] = useState<Tab>("recent");

  return (
    <div className="w-[420px] h-[520px] flex flex-col bg-white text-slate-900 font-sans">
      <header className="px-4 pt-3 pb-2 border-b border-slate-200">
        <div className="flex items-center justify-between">
          <h1 className="text-base font-semibold tracking-tight">Notion Hack</h1>
          <span className="text-[10px] text-slate-400 uppercase tracking-wider">M0 · capture</span>
        </div>
        <nav className="mt-2 flex gap-1 text-xs">
          {(["recent", "workflows", "settings"] as Tab[]).map((t) => (
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

      <main className="flex-1 min-h-0 overflow-hidden">
        {tab === "recent" && <RecentView />}
        {tab === "workflows" && <Placeholder label="Workflows (next milestone)" />}
        {tab === "settings" && <Placeholder label="Settings (next milestone)" />}
      </main>
    </div>
  );
}

function Placeholder({ label }: { label: string }) {
  return (
    <div className="h-full flex items-center justify-center text-slate-400 text-sm">
      {label}
    </div>
  );
}

function RecentView() {
  const [events, setEvents] = useState<AppEvent[]>([]);
  const [count, setCount] = useState<number>(0);
  const [err, setErr] = useState<string | null>(null);
  const timerRef = useRef<number | null>(null);

  async function refresh() {
    const resp = await send({ t: "getRecent", limit: LIMIT });
    if (resp.t === "recent") {
      setEvents(resp.events);
      setCount(resp.events.length);
      setErr(null);
    } else if (resp.t === "error") {
      setErr(resp.message);
    }
  }

  useEffect(() => {
    log("recent view mounted");
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
          showing {count} {err ? <span className="text-rose-600">· {err}</span> : null}
        </span>
        <div className="flex gap-2">
          <button
            onClick={refresh}
            className="px-2 py-0.5 rounded border border-slate-200 hover:bg-slate-50"
          >
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
    "—";

  const t = new Date(ev.ts);
  const time = t.toLocaleTimeString(undefined, { hour12: false });

  return (
    <li className="px-4 py-1.5 text-xs">
      <div className="flex items-baseline gap-2">
        <span className="text-slate-400 tabular-nums w-16 shrink-0">{time}</span>
        <KindBadge kind={ev.kind} />
        <span className="truncate font-medium text-slate-800" title={label}>
          {label}
        </span>
      </div>
      <div className="ml-[72px] mt-0.5 text-slate-500 truncate" title={ev.pageKey}>
        {ev.pageKey}
        {ev.meta && (ev.meta as { source?: string }).source ? (
          <span className="ml-1 text-slate-400">· {(ev.meta as { source?: string }).source}</span>
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
