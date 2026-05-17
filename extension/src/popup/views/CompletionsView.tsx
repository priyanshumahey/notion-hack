import { useEffect, useRef, useState } from "react";
import { send } from "../../lib/messages";
import type {
  CompletionCandidate,
  FormContext,
  NotionPropertySpec,
  NotionRowCell,
  PageContext,
} from "../../lib/types";

const REFRESH_MS = 2000;
const LIMIT = 50;

interface Props {
  hasKey: boolean;
  onNeedKey: () => void;
  onOpenNotion: () => void;
}

export function CompletionsView({ hasKey, onNeedKey, onOpenNotion }: Props) {
  const [items, setItems] = useState<CompletionCandidate[]>([]);
  const [openId, setOpenId] = useState<string | null>(null);
  const timerRef = useRef<number | null>(null);

  async function refresh() {
    const resp = await send({ t: "getCompletions", limit: LIMIT });
    if (resp.t === "completions") setItems(resp.completions);
  }

  useEffect(() => {
    refresh();
    timerRef.current = window.setInterval(refresh, REFRESH_MS);
    return () => {
      if (timerRef.current) window.clearInterval(timerRef.current);
    };
  }, []);

  async function onRetry(id: string) {
    const resp = await send({ t: "retryJudge", id });
    if (resp.t === "completion") refresh();
  }
  async function onDelete(id: string) {
    await send({ t: "deleteCompletion", id });
    if (openId === id) setOpenId(null);
    refresh();
  }
  async function onApply(id: string) {
    await send({ t: "applyCandidate", id });
    refresh();
  }
  async function onDeny(id: string) {
    await send({ t: "denyCandidate", id });
    refresh();
  }
  async function clearAll() {
    if (!confirm("Clear all completion candidates?")) return;
    await send({ t: "clearCompletions" });
    refresh();
  }

  if (!hasKey) {
    return (
      <div className="h-full flex items-center justify-center p-6 text-center text-sm text-slate-600">
        <div>
          <p className="mb-3">
            Completion detection is disabled because no OpenAI key is set.
          </p>
          <button
            onClick={onNeedKey}
            className="px-3 py-1.5 rounded-md bg-slate-900 text-white hover:bg-slate-700"
          >
            Open Settings
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="h-full flex flex-col">
      <div className="px-4 py-2 flex items-center justify-between text-xs text-slate-500 border-b border-slate-100">
        <span>{items.length} candidates</span>
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
        {items.length === 0 && (
          <li className="px-4 py-8 text-center text-slate-400 text-sm">
            No candidates yet — submit a form on any site.
          </li>
        )}
        {items.map((c) => (
          <CompletionRow
            key={c.id}
            c={c}
            expanded={openId === c.id}
            onToggle={() => setOpenId(openId === c.id ? null : c.id)}
            onRetry={() => onRetry(c.id)}
            onDelete={() => onDelete(c.id)}
            onApply={() => onApply(c.id)}
            onDeny={() => onDeny(c.id)}
            onOpenNotion={onOpenNotion}
          />
        ))}
      </ul>
    </div>
  );
}

interface RowProps {
  c: CompletionCandidate;
  expanded: boolean;
  onToggle: () => void;
  onRetry: () => void;
  onDelete: () => void;
  onApply: () => void;
  onDeny: () => void;
  onOpenNotion: () => void;
}

function CompletionRow({ c, expanded, onToggle, onRetry, onDelete, onApply, onDeny, onOpenNotion }: RowProps) {
  const time = new Date(c.detectedAt).toLocaleTimeString(undefined, { hour12: false });
  const j = c.judgement;
  return (
    <li className="text-xs">
      <button
        onClick={onToggle}
        className="w-full text-left px-4 py-2 hover:bg-slate-50 flex items-center gap-2"
      >
        <span className="text-slate-400 tabular-nums w-16 shrink-0">{time}</span>
        <StateBadge c={c} />
        <span className="truncate font-medium text-slate-800">
          {j?.proposal?.database.name ?? (c.error ? "judge failed" : j ? "not meaningful" : "judging…")}
        </span>
        {j ? <ConfidenceBar value={j.confidence} /> : null}
      </button>

      {expanded && (
        <div className="bg-slate-50 px-4 py-3 border-t border-slate-100 space-y-3">
          <Section label="Trigger">
            <div className="flex flex-col gap-1">
              <div className="flex items-center gap-1.5">
                <ReasonBadge reason={c.reason} />
                <code className="text-[11px]">
                  {c.trigger.kind} · {c.trigger.pageKey}
                </code>
              </div>
              {c.triggerNote && (
                <code className="text-[11px] text-slate-600">{c.triggerNote}</code>
              )}
            </div>
          </Section>

          {c.trigger.pageContext && <PageContextBlock ctx={c.trigger.pageContext} />}
          {c.trigger.formContext && <FormContextBlock fc={c.trigger.formContext} />}

          {c.error && (
            <Section label="Error">
              <code className="text-[11px] text-rose-700">{c.error}</code>
            </Section>
          )}

          {j && (
            <>
              <Section label="Reasoning">
                <p className="text-[11px] text-slate-700">{j.reasoning}</p>
              </Section>

              {j.proposal && (
                <>
                  <Section label={`Proposed DB — ${j.proposal.database.name} (${j.proposal.database.mode})`}>
                    {j.proposal.database.description && (
                      <p className="text-[11px] text-slate-600 mb-1">
                        {j.proposal.database.description}
                      </p>
                    )}
                    <SchemaTable properties={j.proposal.database.properties} />
                  </Section>
                  <Section label="Proposed row">
                    <RowTable row={j.proposal.row} properties={j.proposal.database.properties} />
                  </Section>
                </>
              )}
            </>
          )}

          <Section label={`Context — ${c.context.length} events`}>
            <ul className="text-[11px] text-slate-600 space-y-0.5 max-h-40 overflow-auto pr-1">
              {c.context.map((e) => (
                <li key={e.id} className="truncate">
                  [{new Date(e.ts).toLocaleTimeString(undefined, { hour12: false })}]{" "}
                  <span className="font-medium">{e.kind}</span>{" "}
                  {e.fingerprint?.accessibleName || e.fingerprint?.text || ""}{" "}
                  <span className="text-slate-400">→ {e.pageKey}</span>
                </li>
              ))}
            </ul>
          </Section>

          <div className="flex flex-wrap gap-2 pt-1 items-center">
            {j?.meaningful && j.proposal && !c.applied && (
              <>
                <button
                  onClick={onApply}
                  className="px-2.5 py-1 rounded bg-emerald-600 text-white hover:bg-emerald-700 text-[11px] font-medium"
                >
                  approve &amp; add to notion
                </button>
                <button
                  onClick={onDeny}
                  className="px-2.5 py-1 rounded border border-slate-300 text-slate-700 hover:bg-white text-[11px] font-medium"
                  title="Reject this proposal and stop suggesting this pattern for a while."
                >
                  deny
                </button>
              </>
            )}
            {c.applied?.status === "pending" && (
              <span className="px-2 py-0.5 rounded bg-amber-100 text-amber-800 text-[10px] uppercase tracking-wide">
                applying…
              </span>
            )}
            {c.applied?.status === "applied" && (
              <button
                onClick={onOpenNotion}
                className="px-2 py-0.5 rounded bg-emerald-100 text-emerald-800 text-[10px] uppercase tracking-wide hover:bg-emerald-200"
              >
                {c.applied.auto ? "⚡ auto-applied" : "✓ applied"} · view in notion
              </button>
            )}
            {c.applied?.status === "skipped" && (
              <span className="px-2 py-0.5 rounded bg-slate-200 text-slate-700 text-[10px] uppercase tracking-wide">
                denied
              </span>
            )}
            {c.applied?.status === "failed" && (
              <span
                className="px-2 py-0.5 rounded bg-rose-100 text-rose-800 text-[10px] uppercase tracking-wide"
                title={c.applied.errorMessage}
              >
                apply failed
              </span>
            )}
            {c.applied?.droppedFields && c.applied.droppedFields.length > 0 && (
              <span
                className="text-[10px] text-amber-700"
                title={c.applied.droppedFields.map((d) => `${d.property}: ${d.reason}`).join("\n")}
              >
                {c.applied.droppedFields.length} field
                {c.applied.droppedFields.length === 1 ? "" : "s"} dropped
              </span>
            )}
            <button
              onClick={onRetry}
              className="px-2 py-0.5 rounded border border-slate-200 hover:bg-white text-[11px]"
            >
              retry judge
            </button>
            <button
              onClick={onDelete}
              className="px-2 py-0.5 rounded border border-rose-200 text-rose-700 hover:bg-white text-[11px]"
            >
              delete
            </button>
          </div>
        </div>
      )}
    </li>
  );
}

function StateBadge({ c }: { c: CompletionCandidate }) {
  let color = "bg-slate-200 text-slate-700";
  let label = "pending";
  if (c.applied?.status === "applied") {
    color = "bg-emerald-100 text-emerald-800";
    label = c.applied.auto ? "auto-applied" : "applied";
  } else if (c.status === "dismissed") {
    color = "bg-slate-200 text-slate-500";
    label = "denied";
  } else if (c.error) {
    color = "bg-rose-100 text-rose-800";
    label = "error";
  } else if (c.judgement) {
    if (c.judgement.meaningful) {
      color = "bg-emerald-100 text-emerald-800";
      label = "saveable";
    } else {
      color = "bg-slate-200 text-slate-700";
      label = "not meaningful";
    }
  }
  return (
    <span className={"px-1.5 py-0.5 rounded text-[10px] font-medium uppercase tracking-wide shrink-0 " + color}>
      {label}
    </span>
  );
}

function ReasonBadge({ reason }: { reason: CompletionCandidate["reason"] }) {
  const color: Record<CompletionCandidate["reason"], string> = {
    "activity": "bg-slate-200 text-slate-800",
    "form-submit": "bg-emerald-100 text-emerald-800",
    "terminal-nav": "bg-sky-100 text-sky-800",
    "content-dwell": "bg-teal-100 text-teal-800",
    "repetition": "bg-fuchsia-100 text-fuchsia-800",
    "action-click": "bg-orange-100 text-orange-800",
    "rich-page": "bg-indigo-100 text-indigo-800",
  };
  return (
    <span
      className={
        "px-1.5 py-0.5 rounded text-[10px] font-medium uppercase tracking-wide shrink-0 " +
        color[reason]
      }
    >
      {reason}
    </span>
  );
}

function ConfidenceBar({ value }: { value: number }) {
  const pct = Math.round(value * 100);
  return (
    <span className="ml-auto flex items-center gap-1 text-slate-500 text-[10px] tabular-nums">
      <span className="w-12 h-1 bg-slate-200 rounded overflow-hidden">
        <span className="block h-full bg-slate-500" style={{ width: pct + "%" }} />
      </span>
      {pct}%
    </span>
  );
}

function Section({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <div className="text-[10px] uppercase tracking-wide text-slate-500 mb-1">{label}</div>
      {children}
    </div>
  );
}

function SchemaTable({ properties }: { properties: NotionPropertySpec[] }) {
  return (
    <table className="text-[11px] w-full">
      <tbody>
        {properties.map((p) => (
          <tr key={p.name} className="border-b border-slate-200 last:border-0">
            <td className="py-0.5 pr-2 font-medium text-slate-800 w-1/3">{p.name}</td>
            <td className="py-0.5 text-slate-600">
              {p.type}
              {p.options.length ? <span className="text-slate-400"> · {p.options.join(", ")}</span> : null}
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

function RowTable({ row, properties }: { row: NotionRowCell[]; properties: NotionPropertySpec[] }) {
  // Surface validation hint: rows whose property doesn't match any schema name
  // get a small warning marker.
  const propNames = new Set(properties.map((p) => p.name));
  return (
    <table className="text-[11px] w-full">
      <tbody>
        {row.map((r) => (
          <tr key={r.property} className="border-b border-slate-200 last:border-0">
            <td className="py-0.5 pr-2 font-medium text-slate-800 w-1/3 align-top">
              {r.property}
              {!propNames.has(r.property) && (
                <span className="ml-1 text-rose-600" title="property not in schema">⚠</span>
              )}
            </td>
            <td className="py-0.5 text-slate-700 break-all">
              {Array.isArray(r.value) ? r.value.join(", ") : String(r.value)}
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

function PageContextBlock({ ctx }: { ctx: PageContext }) {
  const [showRaw, setShowRaw] = useState(false);
  const summary: [string, string | undefined][] = [
    ["title", ctx.title],
    ["canonical", ctx.canonicalUrl],
    ["description", ctx.description],
  ];
  return (
    <Section label={`Page context · hash ${ctx.contentHash}`}>
      <table className="text-[11px] w-full mb-1">
        <tbody>
          {summary
            .filter(([, v]) => !!v)
            .map(([k, v]) => (
              <tr key={k} className="border-b border-slate-200 last:border-0">
                <td className="py-0.5 pr-2 font-medium text-slate-800 w-24 align-top">{k}</td>
                <td className="py-0.5 text-slate-700 break-all">{v}</td>
              </tr>
            ))}
        </tbody>
      </table>
      {ctx.headings.length > 0 && (
        <details className="mt-1">
          <summary className="cursor-pointer text-[11px] text-slate-600">
            headings ({ctx.headings.length})
          </summary>
          <ul className="ml-3 mt-1 text-[11px] text-slate-700 list-disc">
            {ctx.headings.map((h, i) => (
              <li key={i} className="break-all">
                {h}
              </li>
            ))}
          </ul>
        </details>
      )}
      {ctx.jsonLd.length > 0 && (
        <details className="mt-1">
          <summary className="cursor-pointer text-[11px] text-slate-600">
            JSON-LD ({ctx.jsonLd.length} block{ctx.jsonLd.length === 1 ? "" : "s"})
          </summary>
          <pre className="ml-3 mt-1 text-[10px] text-slate-700 whitespace-pre-wrap break-all max-h-48 overflow-auto bg-white border border-slate-200 rounded p-1">
            {JSON.stringify(ctx.jsonLd, null, 2)}
          </pre>
        </details>
      )}
      {ctx.mainText && (
        <details className="mt-1">
          <summary className="cursor-pointer text-[11px] text-slate-600">
            main text excerpt ({ctx.mainText.length} chars)
          </summary>
          <p className="ml-3 mt-1 text-[11px] text-slate-700 max-h-32 overflow-auto bg-white border border-slate-200 rounded p-1">
            {ctx.mainText}
          </p>
        </details>
      )}
      {ctx.errors && ctx.errors.length > 0 && (
        <p className="mt-1 text-[10px] text-rose-700">capture errors: {ctx.errors.join("; ")}</p>
      )}
      <button
        onClick={() => setShowRaw((v) => !v)}
        className="mt-1 text-[10px] text-slate-500 underline"
      >
        {showRaw ? "hide raw JSON" : "show raw JSON"}
      </button>
      {showRaw && (
        <pre className="mt-1 text-[10px] text-slate-700 whitespace-pre-wrap break-all max-h-48 overflow-auto bg-white border border-slate-200 rounded p-1">
          {JSON.stringify(ctx, null, 2)}
        </pre>
      )}
    </Section>
  );
}

function FormContextBlock({ fc }: { fc: FormContext }) {
  return (
    <Section label={`Form context · ${fc.method.toUpperCase()} ${fc.action || "(same page)"}`}>
      <table className="text-[11px] w-full">
        <thead>
          <tr className="text-left text-slate-500">
            <th className="py-0.5 pr-2 font-medium w-1/3">field</th>
            <th className="py-0.5 pr-2 font-medium w-16">type</th>
            <th className="py-0.5 font-medium">value</th>
          </tr>
        </thead>
        <tbody>
          {fc.fields.map((f, i) => (
            <tr key={i} className="border-b border-slate-200 last:border-0 align-top">
              <td className="py-0.5 pr-2 font-medium text-slate-800 break-all">
                {f.label || f.name || <span className="text-slate-400">(no label)</span>}
                {f.label && f.name && (
                  <span className="ml-1 text-slate-400 font-normal">[{f.name}]</span>
                )}
              </td>
              <td className="py-0.5 pr-2 text-slate-600">{f.type}</td>
              <td className="py-0.5 text-slate-700 break-all">
                {f.value === undefined ? (
                  f.filename ? (
                    <span className="text-slate-500">file: {f.filename}</span>
                  ) : f.type === "password" ? (
                    <span className="text-slate-400 italic">omitted</span>
                  ) : (
                    <span className="text-slate-400">empty</span>
                  )
                ) : Array.isArray(f.value) ? (
                  f.value.join(", ")
                ) : (
                  f.value
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </Section>
  );
}
