import { useEffect, useState } from "react";
import { send } from "../../lib/messages";

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

      <section>
        <h2 className="text-xs uppercase tracking-wide text-slate-500 mb-2">Notion</h2>
        <div className="rounded-md border border-slate-200 p-3 text-xs text-slate-500">
          Notion target will be configured in the next step.
        </div>
      </section>
    </div>
  );
}
