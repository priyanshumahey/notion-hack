import { useEffect, useState } from "react";
import { send } from "../../lib/messages";
import type { ParentPageHit } from "../../lib/notion/types";

interface Props {
  onChanged: () => void;
}

type KeyStatus = {
  hasKey: boolean;
  source: "stored" | "build" | "none";
  redacted: string;
};

type NotionConnection = {
  hasToken: boolean;
  bootstrapped: boolean;
  workspaceName: string;
  parentPageId: string;
  parentPageTitle: string;
  observationsDbId: string;
  redactedToken: string;
};

export function SettingsView({ onChanged }: Props) {
  const [status, setStatus] = useState<KeyStatus | null>(null);
  const [input, setInput] = useState<string>("");
  const [showInput, setShowInput] = useState<boolean>(false);
  const [testing, setTesting] = useState<boolean>(false);
  const [testResult, setTestResult] = useState<{ ok: boolean; error?: string } | null>(null);
  const [saving, setSaving] = useState<boolean>(false);

  async function loadStatus() {
    const resp = await send({ t: "getKeyStatus" });
    if (resp.t === "keyStatus") {
      setStatus({ hasKey: resp.hasKey, source: resp.source, redacted: resp.redacted });
    }
  }

  useEffect(() => {
    loadStatus();
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

      <NotionSection onChanged={onChanged} />
      <BehaviorSection />
      <ResetSection onChanged={onChanged} />
    </div>
  );
}

// ---------------------------------------------------------------------------
// Notion section — token, parent picker, bootstrap.
// ---------------------------------------------------------------------------

function NotionSection({ onChanged }: { onChanged: () => void }) {
  const [conn, setConn] = useState<NotionConnection | null>(null);
  const [tokenInput, setTokenInput] = useState("");
  const [showTokenInput, setShowTokenInput] = useState(false);
  const [savingToken, setSavingToken] = useState(false);
  const [testing, setTesting] = useState(false);
  const [testMsg, setTestMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [query, setQuery] = useState("");
  const [searching, setSearching] = useState(false);
  const [parents, setParents] = useState<ParentPageHit[] | null>(null);
  const [bootstrapping, setBootstrapping] = useState(false);
  const [bootstrapErr, setBootstrapErr] = useState<string | null>(null);
  const [stats, setStats] = useState<{ today: number; total: number; lastError?: string } | null>(null);

  async function loadConn() {
    const r = await send({ t: "notionGetConnection" });
    if (r.t === "notionConnection") {
      setConn({
        hasToken: r.hasToken,
        bootstrapped: r.bootstrapped,
        workspaceName: r.workspaceName,
        parentPageId: r.parentPageId,
        parentPageTitle: r.parentPageTitle,
        observationsDbId: r.observationsDbId,
        redactedToken: r.redactedToken,
      });
    }
  }

  async function loadStats() {
    const r = await send({ t: "notionObservationStats" });
    if (r.t === "notionObservationStats") {
      setStats({ today: r.today, total: r.total, lastError: r.lastError });
    }
  }

  useEffect(() => {
    loadConn();
    loadStats();
  }, []);

  async function saveToken() {
    setSavingToken(true);
    await send({ t: "notionSetToken", token: tokenInput });
    setTokenInput("");
    setShowTokenInput(false);
    setParents(null);
    setSavingToken(false);
    await loadConn();
    onChanged();
  }

  async function disconnect() {
    if (!confirm("Disconnect Notion? The Observations DB stays in your workspace; the token + bootstrap state are cleared.")) return;
    await send({ t: "notionDisconnect" });
    setParents(null);
    setTestMsg(null);
    await loadConn();
    onChanged();
  }

  async function testConn() {
    setTesting(true);
    setTestMsg(null);
    const r = await send({ t: "notionTestConnection" });
    if (r.t === "testResult") {
      setTestMsg({
        ok: r.ok,
        text: r.ok ? `connected to ${r.detail ?? "Notion"}` : r.error ?? "failed",
      });
    }
    setTesting(false);
    await loadConn();
  }

  async function doSearch() {
    setSearching(true);
    setParents(null);
    const r = await send({ t: "notionSearchParents", query });
    setSearching(false);
    if (r.t === "notionParents") {
      setParents(r.results);
    } else if (r.t === "error") {
      setBootstrapErr(r.message);
    }
  }

  async function pickParent(p: ParentPageHit) {
    setBootstrapping(true);
    setBootstrapErr(null);
    const r = await send({
      t: "notionBootstrap",
      parentPageId: p.id,
      parentPageTitle: p.title,
    });
    setBootstrapping(false);
    if (r.t === "notionBootstrapped") {
      await loadConn();
      await loadStats();
      onChanged();
    } else if (r.t === "error") {
      setBootstrapErr(r.message);
    }
  }

  const observationsUrl = conn?.observationsDbId
    ? `https://www.notion.so/${conn.observationsDbId.replace(/-/g, "")}`
    : "";

  return (
    <section>
      <h2 className="text-xs uppercase tracking-wide text-slate-500 mb-2">Notion</h2>

      {/* TOKEN STATE ------------------------------------------------- */}
      <div className="rounded-md border border-slate-200 p-3 space-y-2">
        <div className="flex items-center justify-between gap-2">
          <div className="text-slate-700">
            Token:{" "}
            {conn?.hasToken ? (
              <span className="text-emerald-700 font-medium">configured</span>
            ) : (
              <span className="text-rose-700 font-medium">missing</span>
            )}
          </div>
          {conn?.hasToken && (
            <span className="font-mono text-xs text-slate-500">{conn.redactedToken}</span>
          )}
        </div>

        {!showTokenInput && (
          <div className="flex gap-2 flex-wrap">
            <button
              onClick={() => setShowTokenInput(true)}
              className="px-2 py-1 rounded border border-slate-200 hover:bg-slate-50 text-xs"
            >
              {conn?.hasToken ? "Replace token" : "Set token"}
            </button>
            {conn?.hasToken && (
              <>
                <button
                  onClick={testConn}
                  disabled={testing}
                  className="px-2 py-1 rounded border border-slate-200 hover:bg-slate-50 text-xs disabled:opacity-40"
                >
                  {testing ? "Testing…" : "Test connection"}
                </button>
                <button
                  onClick={disconnect}
                  className="px-2 py-1 rounded border border-rose-200 text-rose-700 hover:bg-rose-50 text-xs"
                >
                  Disconnect
                </button>
              </>
            )}
          </div>
        )}

        {showTokenInput && (
          <div className="space-y-2">
            <input
              type="password"
              value={tokenInput}
              onChange={(e) => setTokenInput(e.target.value)}
              placeholder="secret_…"
              className="w-full px-2 py-1 rounded border border-slate-300 font-mono text-xs"
              autoFocus
            />
            <p className="text-[11px] text-slate-500 leading-snug">
              Create an internal integration at{" "}
              <a
                href="https://www.notion.so/profile/integrations"
                target="_blank"
                rel="noreferrer"
                className="text-slate-700 underline"
              >
                notion.so/profile/integrations
              </a>
              , then share a parent page with it.
            </p>
            <div className="flex gap-2">
              <button
                onClick={saveToken}
                disabled={!tokenInput.trim() || savingToken}
                className="px-2 py-1 rounded bg-slate-900 text-white text-xs disabled:opacity-40"
              >
                {savingToken ? "Saving…" : "Save"}
              </button>
              <button
                onClick={() => {
                  setShowTokenInput(false);
                  setTokenInput("");
                }}
                className="px-2 py-1 rounded border border-slate-200 text-xs"
              >
                Cancel
              </button>
            </div>
          </div>
        )}

        {testMsg && (
          <div
            className={
              "text-xs " + (testMsg.ok ? "text-emerald-700" : "text-rose-700 break-all")
            }
          >
            {testMsg.ok ? `✓ ${testMsg.text}` : `✗ ${testMsg.text}`}
          </div>
        )}
      </div>

      {/* WORKSPACE + DB STATE --------------------------------------- */}
      {conn?.hasToken && (
        <div className="mt-3 rounded-md border border-slate-200 p-3 space-y-2">
          <div className="flex items-center justify-between">
            <div className="text-xs text-slate-500">Workspace</div>
            <div className="text-xs text-slate-700">
              {conn.workspaceName || <em className="text-slate-400">unknown — test the connection</em>}
            </div>
          </div>
          <div className="flex items-center justify-between gap-3">
            <div className="text-xs text-slate-500">Parent page</div>
            <div className="text-xs text-slate-700 truncate max-w-[60%] text-right">
              {conn.parentPageTitle || <em className="text-slate-400">not picked yet</em>}
            </div>
          </div>
          <div className="flex items-center justify-between gap-3">
            <div className="text-xs text-slate-500">Observations DB</div>
            <div className="text-xs">
              {conn.observationsDbId ? (
                <a
                  href={observationsUrl}
                  target="_blank"
                  rel="noreferrer"
                  className="text-emerald-700 underline"
                >
                  open in Notion ↗
                </a>
              ) : (
                <em className="text-slate-400">not bootstrapped</em>
              )}
            </div>
          </div>
          {stats && (
            <div className="border-t border-slate-100 pt-2 text-xs text-slate-600">
              Logged: <span className="font-medium">{stats.today}</span> today ·{" "}
              <span className="font-medium">{stats.total}</span> total
              {stats.lastError && (
                <div className="text-rose-700 mt-1 break-all">last error: {stats.lastError}</div>
              )}
            </div>
          )}
        </div>
      )}

      {/* PARENT PICKER ---------------------------------------------- */}
      {conn?.hasToken && !conn.bootstrapped && (
        <div className="mt-3 rounded-md border border-slate-200 p-3 space-y-2">
          <div className="text-xs text-slate-600">
            Pick a parent page. The <code>Observations</code> database will be created inside it.
          </div>
          <div className="flex gap-2">
            <input
              type="text"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="search pages…"
              onKeyDown={(e) => {
                if (e.key === "Enter") doSearch();
              }}
              className="flex-1 px-2 py-1 rounded border border-slate-300 text-xs"
            />
            <button
              onClick={doSearch}
              disabled={searching}
              className="px-2 py-1 rounded border border-slate-200 hover:bg-slate-50 text-xs disabled:opacity-40"
            >
              {searching ? "…" : "Search"}
            </button>
          </div>

          {parents && parents.length === 0 && (
            <div className="text-xs text-slate-500">
              No pages found. Make sure your integration has access — open a page in Notion, click "…",
              and add the integration as a connection.
            </div>
          )}

          {parents && parents.length > 0 && (
            <ul className="max-h-48 overflow-auto border-t border-slate-100 divide-y divide-slate-100">
              {parents.map((p) => (
                <li key={p.id} className="py-1.5 flex items-center justify-between gap-2">
                  <div className="min-w-0">
                    <div className="text-xs text-slate-800 truncate">{p.title}</div>
                    <div className="text-[10px] text-slate-400 truncate">{p.url}</div>
                  </div>
                  <button
                    onClick={() => pickParent(p)}
                    disabled={bootstrapping}
                    className="px-2 py-0.5 rounded bg-slate-900 text-white text-xs disabled:opacity-40"
                  >
                    {bootstrapping ? "…" : "use"}
                  </button>
                </li>
              ))}
            </ul>
          )}

          {bootstrapErr && (
            <div className="text-xs text-rose-700 break-all">✗ {bootstrapErr}</div>
          )}
        </div>
      )}
    </section>
  );
}

// ---------------------------------------------------------------------------
// Behavior section — auto-apply toggle.
// ---------------------------------------------------------------------------

function BehaviorSection() {
  const [enabled, setEnabled] = useState<boolean | null>(null);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    (async () => {
      const r = await send({ t: "getAutoApply" });
      if (r.t === "autoApply") setEnabled(r.enabled);
    })();
  }, []);

  async function toggle(next: boolean) {
    setSaving(true);
    const r = await send({ t: "setAutoApply", enabled: next });
    if (r.t === "autoApply") setEnabled(r.enabled);
    setSaving(false);
  }

  return (
    <section>
      <h2 className="text-sm font-semibold text-slate-700 mb-2">Behavior</h2>
      <div className="border border-slate-200 rounded-md p-3 bg-slate-50">
        <label className="flex items-start gap-3 cursor-pointer">
          <input
            type="checkbox"
            checked={!!enabled}
            disabled={enabled === null || saving}
            onChange={(e) => toggle(e.target.checked)}
            className="mt-0.5"
          />
          <div className="text-xs text-slate-700">
            <div className="font-medium text-slate-900">Auto-apply approved workflows</div>
            <p className="mt-0.5 text-slate-600">
              When a new candidate matches a database you've previously approved, write it to
              Notion automatically. When off (default), every candidate waits for manual
              approval in the Completions tab and shows a desktop notification.
            </p>
          </div>
        </label>
      </div>
      <p className="mt-2 text-xs text-slate-500">
        Every successful workflow run triggers a desktop notification regardless of this
        setting — click it to jump to the Runs tab.
      </p>
    </section>
  );
}

// ---------------------------------------------------------------------------
// Reset section — wipe all locally-saved data without disconnecting Notion
// or clearing the OpenAI key.
// ---------------------------------------------------------------------------

function ResetSection({ onChanged }: { onChanged: () => void }) {
  const [clearing, setClearing] = useState(false);
  const [result, setResult] = useState<{ ok: boolean; text: string } | null>(null);

  async function reset() {
    const yes = confirm(
      "Clear all locally-saved data?\n\n" +
        "This wipes:\n" +
        "  • observed events (browsing activity)\n" +
        "  • completion candidates and run history\n" +
        "  • observation counters\n\n" +
        "This keeps:\n" +
        "  • your OpenAI key\n" +
        "  • your Notion connection and databases\n" +
        "  • workflows already in Notion\n\n" +
        "Cannot be undone.",
    );
    if (!yes) return;
    setClearing(true);
    setResult(null);
    const r = await send({ t: "clearLocalData" });
    setClearing(false);
    if (r.t === "ok") {
      setResult({ ok: true, text: "Local data cleared." });
      onChanged();
    } else if (r.t === "error") {
      setResult({ ok: false, text: r.message });
    } else {
      setResult({ ok: false, text: "Unexpected response." });
    }
  }

  return (
    <section>
      <h2 className="text-sm font-semibold text-slate-700 mb-2">Reset</h2>
      <div className="border border-rose-200 rounded-md p-3 bg-rose-50/40">
        <p className="text-xs text-slate-700 leading-snug">
          Forget all browsing activity, completion candidates, and run history saved by
          this extension on this machine. Your OpenAI key and Notion connection stay
          intact — anything already written to Notion is left alone.
        </p>
        <div className="mt-2 flex items-center gap-2 flex-wrap">
          <button
            onClick={reset}
            disabled={clearing}
            className="px-2 py-1 rounded border border-rose-300 text-rose-700 hover:bg-rose-100 text-xs disabled:opacity-40"
          >
            {clearing ? "Clearing…" : "Clear local data"}
          </button>
          {result && (
            <span
              className={
                "text-xs " + (result.ok ? "text-emerald-700" : "text-rose-700")
              }
            >
              {result.ok ? "✓ " : "✗ "}
              {result.text}
            </span>
          )}
        </div>
      </div>
    </section>
  );
}
