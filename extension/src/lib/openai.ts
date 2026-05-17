// OpenAI client — minimal, just what we need.
//
// One real call: judgeCandidate() → Judgement.
// One health check: pingOpenAi() → {ok, error?} (for Settings "Test connection").
//
// We use chat.completions with JSON mode (response_format=json_object) and
// validate the result ourselves. We deliberately don't use strict JSON-schema
// mode here because the schema includes a union (`proposal: null | {...}`)
// that's awkward to express; lightweight validation is plenty.

import { getOpenAiKey } from "./settings";
import { makeLog } from "./log";
import type {
  AppEvent,
  CompletionCandidate,
  Judgement,
  NotionProposal,
  NotionPropertySpec,
  NotionRowCell,
} from "./types";

const log = makeLog("bg");
const MODEL = "gpt-4o-mini";
const ENDPOINT = "https://api.openai.com/v1/chat/completions";

const SYSTEM_PROMPT = `You are a backend agent for a browser extension that watches a user's web activity and saves meaningful artifacts to their Notion workspace.

You receive a sequence of browser events plus a TRIGGER REASON. Each event may include rich CONTEXT: page title, meta description, og:* tags, headings, JSON-LD structured data, a main-text excerpt, dwell metrics, and (on form submissions) the submitted form's fields. USE THIS CONTEXT — it is your primary source of truth. JSON-LD especially often contains the exact data that should populate a Notion row.

Trigger reasons you may see:
  - form-submit   — user just submitted a form.
  - terminal-nav  — user landed on a confirmation / success / thank-you page.
  - repetition    — user has visited several distinct URLs that share a canonical pageKey pattern (e.g. multiple tweets from one author, multiple product listings). The pattern is what's meaningful.
  - action-click  — user repeatedly clicked the same UI element on the same host within minutes. Each click represents one item the user acted on (could be Save / Bookmark / Like / Add to cart / Star / etc. — or noise like Delete / Next). YOU decide what's being collected. If meaningful, emit one row per distinct item from the click fingerprints + surrounding context; if individual items aren't separable, emit one summary row.
  - rich-page     — user is looking at a page with substantive content (structured data, og tags, or a meaningful text body). The page may or may not be a saveable artifact — YOU decide what kind of thing it is by reading the URL, title, JSON-LD, og tags, and main text, and whether it's worth saving.

YOUR JOB:

1. Decide whether the sequence represents something MEANINGFUL — worth saving to Notion.
   Meaningful examples: applied for a job, made a purchase, signed up, RSVP'd, scheduled a meeting, saved/bookmarked, viewed a specific job posting / product / recipe / event / article they care about, recurring pattern of consuming content from a specific source, repeated action-clicks of the "save / bookmark / wishlist / star" kind.
   NOT meaningful: random searches, abandoned forms, login screens, cookie banners, captchas, filter changes, app shells, admin/settings pages, dashboards, ephemeral notifications.

2. If meaningful, produce a NOTION PROPOSAL.

ROUTING (where the row goes):
  - Prefer REUSING an existing database from "EXISTING DATABASES" when the artifact naturally fits one (mode="use-existing", set existingId). Match by name first, then sample-row similarity, then schema shape. Use the existing DB's exact column names (don't rename "source" to "publisher").
  - Otherwise PROPOSE A NEW DATABASE (mode="create-new", existingId=null) — only when the artifact is clearly worth its own collection AND no existing DB fits.
  - Otherwise set meaningful=false.

USER-HISTORY SIGNALS (when provided):
  - Per-DB "user-history (30d): approved=N denied=M" — DBs with several approvals and zero denials are STRONG attractors; route there generously. DBs with multiple denials are NEGATIVE signals — be selective about routing items there.
  - Host-level "USER HISTORY ON THIS HOST" — if the user has reliably saved from this host before, lean toward meaningful=true. If they've reliably denied, lean toward meaningful=false unless the fit is overwhelming.
  - User behavior trumps abstract type-matching: they know what they want saved.

NEW DATABASE SCHEMAS (when create-new):
  - Short descriptive name, one-line description, 4-8 properties.
  - Property types: title, rich_text, url, date, select, multi_select, number.
  - EXACTLY ONE property must be type "title". Use options[] only for select/multi_select; otherwise pass [].

ROW VALUES:
  - Each property name MUST match the schema.
  - Value types: title/rich_text/url/select → string; date → ISO 8601; number → number; multi_select → array of strings.
  - Extract values only from observable data. Prefer JSON-LD when available — it's authoritative. Omit cells where the value isn't observable.

DATE-FIELD SEMANTICS — read the property name to decide what the date means:
  - "Date Saved", "Saved At", "Added", "Bookmarked", "Created" → the time the user is saving this NOW. Use the TRIGGER TIMESTAMP (provided in the user message as "NOW") as ISO 8601.
  - "Date Posted", "Published", "Application Deadline", "Event Date" → extract from JSON-LD / page context. If not present, OMIT the field rather than guess.
  - NEVER fabricate a date.

REPETITION-specific: the row should represent the PATTERN (e.g. an entry in "Followed Authors", "Frequently Read Publishers"), not the most recent single instance. Use JSON-LD author/publisher fields when present.

Always return STRICT JSON matching this exact shape (no markdown, no commentary):

{
  "meaningful": boolean,
  "confidence": number,
  "reasoning": string,
  "proposal": null | {
    "database": {
      "mode": "use-existing" | "create-new",
      "existingId": string | null,
      "name": string,
      "description": string,
      "properties": [{ "name": string, "type": "title"|"rich_text"|"url"|"date"|"select"|"multi_select"|"number", "options": string[] }]
    },
    "row": [{ "property": string, "value": string | number | string[] }]
  }
}`;

export interface KnownDatabase {
  id: string;
  name: string;
  description?: string;
  properties: NotionPropertySpec[];
  rowCount?: number;
  /** Up to 3 one-line summaries of recent rows in the DB. Shown to the LLM
   *  so it can see what kind of artifact already lives in each destination. */
  samples?: string[];
}

export interface UserHistorySignal {
  /** dbId → approval/denial counts over the last 30 days. */
  byDb: Record<string, { applied: number; denied: number }>;
  /** Approvals on the current trigger host (last 30 d). */
  hostApplied: number;
  /** Denials on the current trigger host (last 30 d). */
  hostDenied: number;
  triggerHost: string;
}

export async function judgeCandidate(
  candidate: CompletionCandidate,
  knownDatabases: KnownDatabase[],
  userHistory?: UserHistorySignal,
): Promise<Judgement> {
  const key = await getOpenAiKey();
  if (!key) {
    throw new Error("no-openai-key");
  }

  const userPrompt = buildUserPrompt(candidate, knownDatabases, userHistory);
  log("judge → openai", { reason: candidate.reason, ctxLen: candidate.context.length });

  const resp = await fetch(ENDPOINT, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${key}`,
    },
    body: JSON.stringify({
      model: MODEL,
      response_format: { type: "json_object" },
      temperature: 0.2,
      messages: [
        { role: "system", content: SYSTEM_PROMPT },
        { role: "user", content: userPrompt },
      ],
    }),
  });

  if (!resp.ok) {
    const body = await resp.text().catch(() => "");
    throw new Error(`openai-${resp.status}: ${body.slice(0, 200)}`);
  }

  const data = (await resp.json()) as {
    choices?: { message?: { content?: string } }[];
  };
  const raw = data.choices?.[0]?.message?.content ?? "";
  log("judge ← openai (raw)", raw);

  const parsed = JSON.parse(raw);
  return validateJudgement(parsed);
}

export async function pingOpenAi(): Promise<{ ok: boolean; error?: string }> {
  const key = await getOpenAiKey();
  if (!key) return { ok: false, error: "no-openai-key" };
  try {
    const resp = await fetch("https://api.openai.com/v1/models", {
      headers: { Authorization: `Bearer ${key}` },
    });
    if (!resp.ok) {
      const body = await resp.text().catch(() => "");
      return { ok: false, error: `${resp.status}: ${body.slice(0, 120)}` };
    }
    return { ok: true };
  } catch (e) {
    return { ok: false, error: (e as Error).message };
  }
}

// ---------------------------------------------------------------------------
// Prompt construction + validation
// ---------------------------------------------------------------------------

function buildUserPrompt(
  candidate: CompletionCandidate,
  dbs: KnownDatabase[],
  userHistory?: UserHistorySignal,
): string {
  const stats = userHistory?.byDb ?? {};
  const dbBlock = dbs.length
    ? dbs
        .map((d) => {
          const s = stats[d.id];
          const lines = [`- id: ${d.id}`, `  name: ${d.name}`];
          if (d.description) lines.push(`  description: ${d.description}`);
          if (typeof d.rowCount === "number") lines.push(`  rows: ${d.rowCount}`);
          if (s && (s.applied || s.denied)) {
            lines.push(`  user-history (30d): approved=${s.applied} denied=${s.denied}`);
          }
          lines.push(
            `  properties: ${d.properties.map((p) => `${p.name}:${p.type}`).join(", ")}`,
          );
          if (d.samples && d.samples.length) {
            lines.push(`  recent rows:`);
            for (const s of d.samples) lines.push(`    · ${s}`);
          }
          return lines.join("\n");
        })
        .join("\n")
    : "(none — propose a new database)";

  // Budget: ~24 KB of event text total. The trigger event always gets its
  // full context; earlier events are summarized. If we're still over budget
  // we drop oldest events first.
  const BUDGET = 24_000;
  const trigger = candidate.trigger;
  const triggerBlock = formatEventFull(trigger, /*isTrigger*/ true);

  // Earlier events: newest first so the freshest context is closest to the
  // trigger if we have to drop some.
  const earlier = candidate.context.filter((e) => e.id !== trigger.id);
  const earlierLines: string[] = [];
  let used = triggerBlock.length;
  for (const e of earlier.slice().reverse()) {
    const line = formatEventCompact(e);
    if (used + line.length > BUDGET) {
      earlierLines.push(`… ${earlier.length - earlierLines.length} earlier events omitted`);
      break;
    }
    earlierLines.unshift(line);
    used += line.length;
  }

  const hostBlock = userHistory
    ? userHistory.hostApplied || userHistory.hostDenied
      ? `USER HISTORY ON THIS HOST (${userHistory.triggerHost}, 30d): approved=${userHistory.hostApplied} denied=${userHistory.hostDenied}` +
        (userHistory.hostDenied >= 2 && userHistory.hostApplied === 0
          ? "  ⚠️ user has repeatedly rejected suggestions from this host — bias toward meaningful=false unless the fit is overwhelmingly obvious."
          : userHistory.hostApplied >= 2 && userHistory.hostDenied === 0
            ? "  ✅ user reliably saves from this host — be generous about routing."
            : "")
      : `USER HISTORY ON THIS HOST (${userHistory.triggerHost}, 30d): no prior approvals or denials.`
    : "";

  return [
    `EXISTING DATABASES:`,
    dbBlock,
    ``,
    `NOW: ${new Date(candidate.trigger.ts).toISOString()}`,
    hostBlock ? `` : ``,
    hostBlock,
    ``,
    `EVENT SEQUENCE (oldest → newest, summaries):`,
    earlierLines.length ? earlierLines.join("\n") : "(no prior context in window)",
    ``,
    `TRIGGER EVENT (${candidate.reason}${candidate.triggerNote ? `: ${candidate.triggerNote}` : ""}):`,
    triggerBlock,
  ]
    .filter((s) => s !== "")
    .join("\n");
}

/** Compact one-line summary for non-trigger context events. */
function formatEventCompact(e: AppEvent): string {
  const t = new Date(e.ts).toISOString().slice(11, 19);
  const fp = e.fingerprint;
  const label = fp
    ? `"${(fp.accessibleName || fp.text || fp.testid || fp.tag || "").slice(0, 80)}" (${fp.role ?? fp.tag})`
    : "";
  const title = e.pageContext?.title ? ` · title:"${e.pageContext.title.slice(0, 80)}"` : "";
  return `- [${t}] ${e.kind}${label ? " " + label : ""} → ${e.pageKey}${title}`;
}

/** Full block including page context + (for submits) form fields. */
function formatEventFull(e: AppEvent, isTrigger: boolean): string {
  const t = new Date(e.ts).toISOString().slice(11, 19);
  const lines: string[] = [];
  const tag = isTrigger ? "TRIGGER" : "EVENT";
  lines.push(`[${t}] ${tag}: ${e.kind} → ${e.pageKey}`);
  lines.push(`  url: ${e.url}`);

  const fp = e.fingerprint;
  if (fp) {
    const label = fp.accessibleName || fp.text || fp.testid || fp.tag;
    lines.push(`  target: <${fp.role ?? fp.tag}> "${(label ?? "").slice(0, 200)}"`);
    if (fp.hrefPattern) lines.push(`  href: ${fp.hrefPattern}`);
  }

  // Dwell metrics — meaningful only on page-dwell events.
  if (e.kind === "page-dwell" && e.meta) {
    const m = e.meta as Record<string, unknown>;
    lines.push(
      `  dwell: foreground=${m.foregroundMs}ms total=${m.totalMs}ms scroll=${m.maxScrollPct}% interactions=${m.interactionCount} reason=${m.reason}`,
    );
  }

  const pc = e.pageContext;
  if (pc) {
    if (pc.title) lines.push(`  page.title: ${pc.title}`);
    if (pc.canonicalUrl && pc.canonicalUrl !== pc.url) lines.push(`  page.canonical: ${pc.canonicalUrl}`);
    if (pc.description) lines.push(`  page.description: ${pc.description}`);
    if (pc.og && Object.keys(pc.og).length) {
      const og = Object.entries(pc.og)
        .map(([k, v]) => `${k}=${v}`)
        .join(" | ");
      lines.push(`  page.og: ${og}`);
    }
    if (pc.headings.length) {
      lines.push(`  page.headings:`);
      for (const h of pc.headings) lines.push(`    - ${h}`);
    }
    if (pc.jsonLd.length) {
      lines.push(`  page.jsonLd:`);
      for (const block of pc.jsonLd) {
        lines.push(`    ${truncateLine(JSON.stringify(block), 1200)}`);
      }
    }
    if (pc.mainText) {
      lines.push(`  page.mainText: ${truncateLine(pc.mainText, 1500)}`);
    }
    if (pc.selectionText) {
      lines.push(`  page.selection: ${truncateLine(pc.selectionText, 600)}`);
    }
  }

  const fc = e.formContext;
  if (fc) {
    lines.push(`  form.action: ${fc.action || "(same page)"}  method: ${fc.method}`);
    if (fc.formName) lines.push(`  form.name: ${fc.formName}`);
    lines.push(`  form.fields:`);
    for (const f of fc.fields) {
      const label = f.label ? ` "${f.label}"` : "";
      const valStr =
        f.value === undefined
          ? (f.filename ? `<file: ${f.filename}>` : f.type === "password" ? "<omitted>" : "<empty>")
          : Array.isArray(f.value)
            ? `[${f.value.join(", ")}]`
            : truncateLine(String(f.value), 400);
      lines.push(`    - ${f.name ?? "(no-name)"} (${f.type})${label}: ${valStr}`);
    }
  }

  if (e.meta && Object.keys(e.meta).length && e.kind !== "page-dwell") {
    lines.push(`  meta: ${truncateLine(JSON.stringify(e.meta), 300)}`);
  }
  return lines.join("\n");
}

function truncateLine(s: string, max: number): string {
  return s.length <= max ? s : s.slice(0, max - 1) + "…";
}

// ---------------------------------------------------------------------------
// Validators. Defensive but not paranoid: shape check, type check, coercions
// for the common LLM slip-ups. Throws on hard failures.
// ---------------------------------------------------------------------------

function validateJudgement(x: unknown): Judgement {
  if (!isObject(x)) throw new Error("judgement: not an object");
  const meaningful = !!x.meaningful;
  const confidence = clamp01(asNumber(x.confidence, 0.5));
  const reasoning = asString(x.reasoning, "");
  let proposal: NotionProposal | null = null;
  if (meaningful) {
    if (!isObject(x.proposal)) throw new Error("judgement: meaningful=true but no proposal");
    proposal = validateProposal(x.proposal);
  }
  return { meaningful, confidence, reasoning, proposal };
}

function validateProposal(x: Record<string, unknown>): NotionProposal {
  const db = x.database;
  if (!isObject(db)) throw new Error("proposal: missing database");
  const mode = db.mode === "use-existing" ? "use-existing" : "create-new";
  const existingId = typeof db.existingId === "string" ? db.existingId : null;
  const name = asString(db.name, "Untitled");
  const description = asString(db.description, "");
  const properties = Array.isArray(db.properties)
    ? db.properties.map(validateProperty).filter(Boolean) as NotionPropertySpec[]
    : [];
  if (!properties.some((p) => p.type === "title")) {
    throw new Error("proposal: schema has no title property");
  }
  const rowsIn = Array.isArray(x.row) ? x.row : [];
  const row: NotionRowCell[] = rowsIn.map(validateRowCell).filter(Boolean) as NotionRowCell[];
  return {
    database: { mode, existingId, name, description, properties },
    row,
  };
}

function validateProperty(x: unknown): NotionPropertySpec | null {
  if (!isObject(x)) return null;
  const name = asString(x.name, "");
  if (!name) return null;
  const allowed = ["title", "rich_text", "url", "date", "select", "multi_select", "number"] as const;
  const t = allowed.find((a) => a === x.type);
  if (!t) return null;
  const options = Array.isArray(x.options) ? x.options.filter((o) => typeof o === "string") as string[] : [];
  return { name, type: t, options };
}

function validateRowCell(x: unknown): NotionRowCell | null {
  if (!isObject(x)) return null;
  const property = asString(x.property, "");
  if (!property) return null;
  const v = x.value;
  if (typeof v === "string" || typeof v === "number") return { property, value: v };
  if (Array.isArray(v) && v.every((s) => typeof s === "string")) {
    return { property, value: v as string[] };
  }
  // Coerce unknown shapes to JSON string so we never lose the data.
  return { property, value: JSON.stringify(v) };
}

function isObject(x: unknown): x is Record<string, unknown> {
  return !!x && typeof x === "object" && !Array.isArray(x);
}
function asString(x: unknown, fallback: string): string {
  return typeof x === "string" ? x : fallback;
}
function asNumber(x: unknown, fallback: number): number {
  return typeof x === "number" && isFinite(x) ? x : fallback;
}
function clamp01(n: number): number {
  return n < 0 ? 0 : n > 1 ? 1 : n;
}
