import { useEffect, useRef, useState } from "react";
import { send } from "../../lib/messages";
import type { NotionDatabase, NotionPage, NotionPropertyValue } from "../../lib/notion/types";

const REFRESH_MS = 2000;
const PAGES_LIMIT = 200;

type View =
  | { kind: "list" }
  | { kind: "detail"; databaseId: string };

export function NotionView() {
  const [view, setView] = useState<View>({ kind: "list" });
  const [workspace, setWorkspace] = useState<string>("Mock Notion");
  const [databases, setDatabases] = useState<NotionDatabase[]>([]);
  const [autoMaster, setAutoMaster] = useState<boolean>(true);
  const [autoByDb, setAutoByDb] = useState<Record<string, boolean>>({});
  const timerRef = useRef<number | null>(null);

  async function refreshList() {
    const [dbResp, cfgResp] = await Promise.all([
      send({ t: "notionListDatabases" }),
      send({ t: "getAutoApplyConfig" }),
    ]);
    if (dbResp.t === "notionDatabases") {
      setDatabases(dbResp.databases);
      setWorkspace(dbResp.workspace);
    }
    if (cfgResp.t === "autoApplyConfig") {
      setAutoMaster(cfgResp.master);
      setAutoByDb(cfgResp.byDb);
    }
  }

  useEffect(() => {
    refreshList();
    timerRef.current = window.setInterval(refreshList, REFRESH_MS);
    return () => {
      if (timerRef.current) window.clearInterval(timerRef.current);
    };
  }, []);

  async function clearAll() {
    if (!confirm("Wipe all mock Notion databases and pages?")) return;
    await send({ t: "notionClearAll" });
    setView({ kind: "list" });
    refreshList();
  }

  async function toggleDbAuto(dbId: string, next: boolean) {
    setAutoByDb((prev) => ({ ...prev, [dbId]: next }));
    await send({ t: "setAutoApplyForDb", dbId, enabled: next });
  }

  /** Resolve effective auto-apply for a DB: master AND (explicit value OR default true). */
  function autoFor(dbId: string): boolean {
    if (!autoMaster) return false;
    if (dbId in autoByDb) return autoByDb[dbId];
    return true;
  }

  return (
    <div className="h-full flex flex-col">
      <div className="px-4 py-2 flex items-center justify-between text-xs text-slate-500 border-b border-slate-100">
        <div className="flex items-center gap-2">
          {view.kind === "detail" && (
            <button
              onClick={() => setView({ kind: "list" })}
              className="px-1.5 py-0.5 rounded border border-slate-200 hover:bg-slate-50"
              title="back"
            >
              ←
            </button>
          )}
          <span>
            <span className="font-medium text-slate-700">{workspace}</span> ·{" "}
            {databases.length} database{databases.length === 1 ? "" : "s"}
          </span>
        </div>
        <div className="flex gap-2">
          <button onClick={refreshList} className="px-2 py-0.5 rounded border border-slate-200 hover:bg-slate-50">
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

      {view.kind === "list" ? (
        <DatabaseList
          databases={databases}
          autoMaster={autoMaster}
          autoFor={autoFor}
          onToggleAuto={toggleDbAuto}
          onOpen={(id) => setView({ kind: "detail", databaseId: id })}
        />
      ) : (
        <DatabaseDetail
          databaseId={view.databaseId}
          databases={databases}
          onBack={() => setView({ kind: "list" })}
        />
      )}
    </div>
  );
}

function DatabaseList({
  databases,
  autoMaster,
  autoFor,
  onToggleAuto,
  onOpen,
}: {
  databases: NotionDatabase[];
  autoMaster: boolean;
  autoFor: (dbId: string) => boolean;
  onToggleAuto: (dbId: string, next: boolean) => void;
  onOpen: (id: string) => void;
}) {
  if (databases.length === 0) {
    return (
      <div className="flex-1 flex items-center justify-center p-6 text-center text-sm text-slate-400">
        No mock Notion databases yet. Apply a candidate from the Completions tab to create one.
      </div>
    );
  }
  return (
    <ul className="flex-1 overflow-auto divide-y divide-slate-100">
      {databases.map((db) => {
        const auto = autoFor(db.id);
        return (
          <li key={db.id} className="flex items-stretch">
            <button
              onClick={() => onOpen(db.id)}
              className="flex-1 text-left px-4 py-2.5 hover:bg-slate-50 min-w-0"
            >
              <div className="flex items-baseline gap-2">
                <span className="font-medium text-slate-800 text-sm truncate">{db.name}</span>
                <span className="text-[10px] text-slate-400 tabular-nums shrink-0">
                  {db.rowCount} row{db.rowCount === 1 ? "" : "s"}
                </span>
              </div>
              {db.description && (
                <p className="mt-0.5 text-[11px] text-slate-600 line-clamp-2">{db.description}</p>
              )}
              <div className="mt-1 flex flex-wrap gap-1">
                {db.properties.map((p) => (
                  <span
                    key={p.name}
                    className="px-1.5 py-0.5 rounded bg-slate-100 text-[10px] text-slate-700"
                    title={p.type}
                  >
                    {p.name}
                    <span className="text-slate-400 ml-1">{p.type}</span>
                  </span>
                ))}
              </div>
            </button>
            <div className="shrink-0 flex items-center pr-3">
              <AutoToggle
                enabled={auto}
                disabled={!autoMaster}
                title={
                  !autoMaster
                    ? "Auto-save is OFF globally. Re-enable in Settings."
                    : auto
                      ? "Auto-save ON — matching items skip the prompt and write directly to this DB."
                      : "Auto-save OFF — matching items require manual approval."
                }
                onChange={(next) => onToggleAuto(db.id, next)}
              />
            </div>
          </li>
        );
      })}
    </ul>
  );
}

function AutoToggle({
  enabled,
  disabled,
  title,
  onChange,
}: {
  enabled: boolean;
  disabled?: boolean;
  title?: string;
  onChange: (next: boolean) => void;
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={enabled}
      disabled={disabled}
      onClick={(e) => {
        e.stopPropagation();
        if (!disabled) onChange(!enabled);
      }}
      title={title}
      className={
        "flex items-center gap-1.5 px-2 py-1 rounded-md border text-[10px] uppercase tracking-wide font-medium transition " +
        (disabled
          ? "border-slate-200 text-slate-400 bg-slate-50 cursor-not-allowed"
          : enabled
            ? "border-emerald-300 bg-emerald-50 text-emerald-800 hover:bg-emerald-100"
            : "border-slate-300 bg-white text-slate-500 hover:bg-slate-50")
      }
    >
      <span
        className={
          "inline-block w-2 h-2 rounded-full " +
          (disabled ? "bg-slate-300" : enabled ? "bg-emerald-500" : "bg-slate-300")
        }
      />
      auto {enabled ? "on" : "off"}
    </button>
  );
}

function DatabaseDetail({
  databaseId,
  databases,
  onBack,
}: {
  databaseId: string;
  databases: NotionDatabase[];
  onBack: () => void;
}) {
  const db = databases.find((d) => d.id === databaseId);
  const [pages, setPages] = useState<NotionPage[]>([]);
  const timerRef = useRef<number | null>(null);

  async function refresh() {
    const resp = await send({ t: "notionListPages", databaseId, limit: PAGES_LIMIT });
    if (resp.t === "notionPages") setPages(resp.pages);
  }

  useEffect(() => {
    refresh();
    timerRef.current = window.setInterval(refresh, REFRESH_MS);
    return () => {
      if (timerRef.current) window.clearInterval(timerRef.current);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [databaseId]);

  if (!db) {
    return (
      <div className="flex-1 flex items-center justify-center p-6 text-center text-sm text-slate-400">
        <div>
          <p className="mb-2">Database not found.</p>
          <button
            onClick={onBack}
            className="px-3 py-1 rounded border border-slate-200 hover:bg-slate-50 text-xs"
          >
            back
          </button>
        </div>
      </div>
    );
  }

  // Sort columns: title first, then in declared order.
  const cols = [...db.properties].sort((a, b) => {
    if (a.type === "title" && b.type !== "title") return -1;
    if (b.type === "title" && a.type !== "title") return 1;
    return 0;
  });

  return (
    <div className="flex-1 flex flex-col overflow-hidden">
      <div className="px-4 pt-2 pb-1 border-b border-slate-100">
        <h2 className="font-medium text-slate-800 text-sm">{db.name}</h2>
        {db.description && (
          <p className="mt-0.5 text-[11px] text-slate-600">{db.description}</p>
        )}
        <p className="mt-1 text-[10px] text-slate-400">
          {pages.length} row{pages.length === 1 ? "" : "s"} · created{" "}
          {new Date(db.createdAt).toLocaleString(undefined, { hour12: false })}
        </p>
      </div>
      <div className="flex-1 overflow-auto">
        {pages.length === 0 ? (
          <div className="p-6 text-center text-sm text-slate-400">No rows yet.</div>
        ) : (
          <table className="w-full text-[11px]">
            <thead className="sticky top-0 bg-white border-b border-slate-200 z-10">
              <tr>
                {cols.map((p) => (
                  <th
                    key={p.name}
                    className="text-left font-medium text-slate-600 px-2 py-1.5 whitespace-nowrap"
                  >
                    {p.name}
                    <span className="text-slate-400 ml-1 font-normal">{p.type}</span>
                  </th>
                ))}
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {pages.map((page) => (
                <tr key={page.id} className="hover:bg-slate-50 align-top">
                  {cols.map((p) => (
                    <td key={p.name} className="px-2 py-1 text-slate-700 max-w-[280px]">
                      <CellValue value={page.properties[p.name]} />
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
}

function CellValue({ value }: { value: NotionPropertyValue | undefined }) {
  if (!value) return <span className="text-slate-300">—</span>;
  switch (value.type) {
    case "title":
      return <span className="font-medium text-slate-800 break-words">{value.value}</span>;
    case "rich_text":
      return <span className="break-words">{value.value}</span>;
    case "url":
      return (
        <a
          href={value.value}
          target="_blank"
          rel="noreferrer noopener"
          className="text-sky-700 hover:underline break-all"
        >
          {value.value}
        </a>
      );
    case "date":
      return (
        <span className="tabular-nums text-slate-600">
          {new Date(value.value).toLocaleString(undefined, { hour12: false })}
        </span>
      );
    case "select":
      return (
        <span className="px-1.5 py-0.5 rounded bg-slate-100 text-slate-700">{value.value}</span>
      );
    case "multi_select":
      return (
        <span className="flex flex-wrap gap-1">
          {value.value.map((v, i) => (
            <span key={i} className="px-1.5 py-0.5 rounded bg-slate-100 text-slate-700">
              {v}
            </span>
          ))}
        </span>
      );
    case "number":
      return <span className="tabular-nums text-slate-700">{value.value}</span>;
  }
}
