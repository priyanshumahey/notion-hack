import { useEffect, useState } from "react";
import { send } from "../../lib/messages";
import type { NotionDatabase } from "../../lib/notion/types";

interface Props {
  onChanged: () => void;
}

type KeyStatus = {
  hasKey: boolean;
  source: "stored" | "build" | "none";
  redacted: string;
};

export function SettingsView({ onChanged }: Props) {
  const [status, setStatus] = useState<KeyStatus | null>(null);
  const [input, setInput] = useState<string>("");
  const [showInput, setShowInput] = useState<boolean>(false);
  const [testing, setTesting] = useState<boolean>(false);
  const [testResult, setTestResult] = useState<{ ok: boolean; error?: string } | null>(null);
  const [saving, setSaving] = useState<boolean>(false);
  const [autoMaster, setAutoMaster] = useState<boolean>(true);
  const [autoByDb, setAutoByDb] = useState<Record<string, boolean>>({});
  const [databases, setDatabases] = useState<NotionDatabase[]>([]);

  async function loadStatus() {
    const resp = await send({ t: "getKeyStatus" });
    if (resp.t === "keyStatus") {
      setStatus({ hasKey: resp.hasKey, source: resp.source, redacted: resp.redacted });
    }
  }

  async function loadAuto() {
    const [cfg, dbs] = await Promise.all([
      send({ t: "getAutoApplyConfig" }),
      send({ t: "notionListDatabases" }),
    ]);
    if (cfg.t === "autoApplyConfig") {
      setAutoMaster(cfg.master);
      setAutoByDb(cfg.byDb);
    }
    if (dbs.t === "notionDatabases") setDatabases(dbs.databases);
  }

  useEffect(() => {
    loadStatus();
    loadAuto();
  }, []);

  async function save() {
    setSaving(true);
    await send({ t: "setOpenAiKey", key: input });
    setInput("");
    setShowInput(false);
    setSaving(false);
    await loadStatus();
    onChanged();
  }

  async function clearKey() {
    if (!confirm("Clear the stored OpenAI key? Build-time fallback (if any) will be used.")) return;
    await send({ t: "setOpenAiKey", key: "" });
    await loadStatus();
    onChanged();
  }

  async function test() {
    setTesting(true);
    setTestResult(null);
    const resp = await send({ t: "testOpenAi" });
    if (resp.t === "testResult") setTestResult({ ok: resp.ok, error: resp.error });
    setTesting(false);
  }

  async function toggleMaster(next: boolean) {
    setAutoMaster(next);
    await send({ t: "setAutoApplyMaster", enabled: next });
  }

  async function toggleDb(dbId: string, next: boolean) {
    setAutoByDb((prev) => ({ ...prev, [dbId]: next }));
    await send({ t: "setAutoApplyForDb", dbId, enabled: next });
  }

  function autoFor(dbId: string): boolean {
    if (!autoMaster) return false;
    if (dbId in autoByDb) return autoByDb[dbId];
    return true;
  }

  return (
    <div className="h-full overflow-auto p-4 space-y-5 text-sm">
      <section>
        <h2 className="text-xs uppercase tracking-wide text-slate-500 mb-2">OpenAI</h2>
        <div className="rounded-md border border-slate-200 p-3">
          <div className="flex items-center justify-between gap-2 mb-2">
            <div className="text-slate-700">
              Status:{" "}
              {status?.hasKey ? (
                <span className="text-emerald-700 font-medium">
                  configured · {status.source}
                </span>
              ) : (
                <span className="text-rose-700 font-medium">missing</span>
              )}
            </div>
            {status?.hasKey ? (
              <span className="font-mono text-xs text-slate-500">{status.redacted}</span>
            ) : null}
          </div>

          {!showInput && (
            <div className="flex gap-2">
              <button
                onClick={() => setShowInput(true)}
                className="px-2 py-1 rounded border border-slate-200 hover:bg-slate-50 text-xs"
              >
                {status?.hasKey ? "Replace key" : "Set key"}
              </button>
              {status?.source === "stored" && (
                <button
                  onClick={clearKey}
                  className="px-2 py-1 rounded border border-rose-200 text-rose-700 hover:bg-rose-50 text-xs"
                >
                  Clear stored key
                </button>
              )}
              <button
                onClick={test}
                disabled={!status?.hasKey || testing}
                className="px-2 py-1 rounded border border-slate-200 hover:bg-slate-50 text-xs disabled:opacity-40"
              >
                {testing ? "Testing…" : "Test connection"}
              </button>
            </div>
          )}

          {showInput && (
            <div className="space-y-2">
              <input
                type="password"
                value={input}
                onChange={(e) => setInput(e.target.value)}
                placeholder="sk-…"
                className="w-full px-2 py-1 rounded border border-slate-300 font-mono text-xs"
                autoFocus
              />
              <div className="flex gap-2">
                <button
                  onClick={save}
                  disabled={!input.trim() || saving}
                  className="px-2 py-1 rounded bg-slate-900 text-white text-xs disabled:opacity-40"
                >
                  {saving ? "Saving…" : "Save"}
                </button>
                <button
                  onClick={() => {
                    setShowInput(false);
                    setInput("");
                  }}
                  className="px-2 py-1 rounded border border-slate-200 text-xs"
                >
                  Cancel
                </button>
              </div>
            </div>
          )}

          {testResult && (
            <div
              className={
                "mt-2 text-xs " + (testResult.ok ? "text-emerald-700" : "text-rose-700")
              }
            >
              {testResult.ok ? "✓ key works" : `✗ ${testResult.error ?? "failed"}`}
            </div>
          )}
        </div>
        <p className="mt-2 text-xs text-slate-500">
          Stored key (chrome.storage.local) takes precedence over the build-time key from <code>.env</code>.
          Without a key, completion detection is disabled.
        </p>
      </section>

      <section>
        <div className="flex items-center justify-between mb-2">
          <h2 className="text-xs uppercase tracking-wide text-slate-500">Auto-save</h2>
          <label className="flex items-center gap-2 text-xs text-slate-600 cursor-pointer">
            <input
              type="checkbox"
              checked={autoMaster}
              onChange={(e) => toggleMaster(e.target.checked)}
              className="accent-slate-900"
            />
            <span>{autoMaster ? "enabled" : "disabled (all flows require manual approval)"}</span>
          </label>
        </div>
        <div className="rounded-md border border-slate-200 p-3 space-y-2">
          <p className="text-xs text-slate-600">
            When a meaningful candidate routes to a Notion database below, it's saved
            automatically — no prompt — provided the flow is ON. Switch a flow OFF to require
            manual approval for that destination. Brand-new databases always require manual
            approval the first time.
          </p>
          {databases.length === 0 ? (
            <p className="text-xs text-slate-400 italic">
              No databases yet. Once you approve a candidate, its destination database will
              appear here.
            </p>
          ) : (
            <ul className="divide-y divide-slate-100 -mx-1">
              {databases.map((db) => {
                const on = autoFor(db.id);
                return (
                  <li
                    key={db.id}
                    className="flex items-center justify-between gap-3 px-1 py-1.5"
                  >
                    <div className="min-w-0">
                      <div className="text-sm text-slate-800 truncate font-medium">
                        {db.name}
                      </div>
                      <div className="text-[10px] text-slate-400 tabular-nums">
                        {db.rowCount} row{db.rowCount === 1 ? "" : "s"}
                      </div>
                    </div>
                    <button
                      type="button"
                      role="switch"
                      aria-checked={on}
                      disabled={!autoMaster}
                      onClick={() => toggleDb(db.id, !on)}
                      className={
                        "shrink-0 relative inline-flex h-5 w-9 items-center rounded-full transition " +
                        (!autoMaster
                          ? "bg-slate-200 opacity-50 cursor-not-allowed"
                          : on
                            ? "bg-emerald-500"
                            : "bg-slate-300")
                      }
                      title={
                        !autoMaster
                          ? "Auto-save is OFF globally"
                          : on
                            ? "ON — items skip the prompt and write to this DB"
                            : "OFF — items require manual approval"
                      }
                    >
                      <span
                        className={
                          "inline-block h-4 w-4 transform rounded-full bg-white shadow transition " +
                          (on ? "translate-x-4" : "translate-x-0.5")
                        }
                      />
                    </button>
                  </li>
                );
              })}
            </ul>
          )}
        </div>
      </section>

      <section>
        <h2 className="text-xs uppercase tracking-wide text-slate-500 mb-2">Notion</h2>
        <div className="rounded-md border border-slate-200 p-3 text-xs text-slate-500">
          Notion target will be configured in the next step.
        </div>
      </section>
    </div>
  );
}
