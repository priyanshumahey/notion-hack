import { useEffect, useRef, useState } from "react";
import { send } from "../../lib/messages";
import type { ConnectorInfo } from "../../lib/connectors";
import type { CompletionCandidate } from "../../lib/types";

const REFRESH_MS = 2000;

export function ConnectorsView({ onOpenCompletions }: { onOpenCompletions: () => void }) {
  const [connectors, setConnectors] = useState<ConnectorInfo[]>([]);
  const [running, setRunning] = useState<string | null>(null);
  const [lastRun, setLastRun] = useState<{
    completion: CompletionCandidate | null;
    error?: string;
  } | null>(null);
  const timerRef = useRef<number | null>(null);

  async function refresh() {
    const resp = await send({ t: "listConnectors" });
    if (resp.t === "connectors") setConnectors(resp.connectors);
  }

  useEffect(() => {
    refresh();
    timerRef.current = window.setInterval(refresh, REFRESH_MS);
    return () => {
      if (timerRef.current) window.clearInterval(timerRef.current);
    };
  }, []);

  async function connect(id: ConnectorInfo["id"]) {
    setLastRun(null);
    const resp = await send({ t: "connectConnector", id });
    if (resp.t === "connectors") await refresh();
  }

  async function disconnect(id: ConnectorInfo["id"]) {
    setLastRun(null);
    const resp = await send({ t: "disconnectConnector", id });
    if (resp.t === "connectors") await refresh();
  }

  async function runFlow(id: ConnectorInfo["id"]) {
    setRunning(id);
    setLastRun(null);
    const resp = await send({ t: "executeConnectorFlow", connectorId: id });
    if (resp.t === "connectorFlowResult") {
      setLastRun({ completion: resp.completion });
      await refresh();
    } else if (resp.t === "error") {
      setLastRun({ completion: null, error: resp.message });
    }
    setRunning(null);
  }

  return (
    <div className="h-full flex flex-col">
      <div className="px-4 py-2 flex items-center justify-between text-xs text-slate-500 border-b border-slate-100">
        <span>{connectors.length} connector{connectors.length === 1 ? "" : "s"}</span>
        <button onClick={refresh} className="px-2 py-0.5 rounded border border-slate-200 hover:bg-slate-50">
          refresh
        </button>
      </div>

      <div className="flex-1 overflow-auto p-4 space-y-3">
        {connectors.map((connector) => (
          <section
            key={connector.id}
            className="rounded-md border border-slate-200 bg-white p-3 text-sm"
          >
            <div className="flex items-start justify-between gap-3">
              <div>
                <div className="flex items-center gap-2">
                  <h2 className="font-medium text-slate-900">{connector.label}</h2>
                  <span
                    className={
                      "px-1.5 py-0.5 rounded text-[10px] uppercase tracking-wide " +
                      (connector.status === "connected"
                        ? "bg-emerald-100 text-emerald-800"
                        : "bg-slate-100 text-slate-600")
                    }
                  >
                    {connector.status}
                  </span>
                </div>
                <p className="mt-1 text-xs text-slate-600">{connector.description}</p>
                <p className="mt-1 text-[11px] text-slate-400">
                  Workspace: {connector.workspace}
                </p>
              </div>
              {connector.status === "connected" ? (
                <button
                  onClick={() => disconnect(connector.id)}
                  className="px-2 py-1 rounded border border-slate-200 text-xs hover:bg-slate-50"
                >
                  disconnect
                </button>
              ) : (
                <button
                  onClick={() => connect(connector.id)}
                  className="px-2 py-1 rounded bg-slate-900 text-white text-xs hover:bg-slate-700"
                >
                  connect
                </button>
              )}
            </div>

            <div className="mt-3 flex flex-wrap gap-1">
              {connector.actions.map((action) => (
                <span
                  key={action}
                  className="px-1.5 py-0.5 rounded bg-slate-100 text-[10px] text-slate-700"
                >
                  {action}
                </span>
              ))}
            </div>

            <div className="mt-3 flex items-center gap-2">
              <button
                onClick={() => runFlow(connector.id)}
                disabled={connector.status !== "connected" || running === connector.id}
                className="px-2.5 py-1 rounded bg-emerald-600 text-white text-xs font-medium hover:bg-emerald-700 disabled:opacity-40"
              >
                {running === connector.id ? "running..." : "run latest saveable flow"}
              </button>
              <button
                onClick={onOpenCompletions}
                className="px-2.5 py-1 rounded border border-slate-200 text-xs hover:bg-slate-50"
              >
                view completions
              </button>
            </div>
          </section>
        ))}

        {lastRun && (
          <section className="rounded-md border border-slate-200 bg-slate-50 p-3 text-xs">
            {lastRun.error ? (
              <p className="text-rose-700">{lastRun.error}</p>
            ) : lastRun.completion ? (
              <div>
                <p className="font-medium text-slate-800">Flow executed.</p>
                <p className="mt-1 text-slate-600">
                  {lastRun.completion.connectorRuns?.at(-1)?.message ??
                    lastRun.completion.applied?.errorMessage ??
                    "Completion updated."}
                </p>
              </div>
            ) : (
              <p className="text-slate-600">
                No saveable completion is ready. Trigger a meaningful completion first.
              </p>
            )}
          </section>
        )}
      </div>
    </div>
  );
}
