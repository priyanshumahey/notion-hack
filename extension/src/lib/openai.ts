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

const SYSTEM_PROMPT = `You are a backend agent for a browser extension that watches a user's web activity and saves meaningful tasks/artifacts/patterns to their Notion workspace.

You will receive a sequence of browser events and a TRIGGER REASON. Each event may include rich CONTEXT: the page's title, meta description, og:* tags, headings, JSON-LD structured data, a main-text excerpt, dwell metrics (foreground time, scroll depth, interactions), and (on form submissions) the submitted form's field labels and values. USE THIS CONTEXT — it is your primary source of truth. JSON-LD blocks especially often contain the exact information that should populate a Notion row.

TRIGGER REASONS you may see:
  - "form-submit": the user just submitted a form.
  - "terminal-nav": the user just landed on a confirmation/success/thank-you-style page.
  - "content-dwell": the user spent meaningful time engaging with a high-value content page (job posting, product, event, recipe, course, etc.). The page itself is the artifact — they didn't necessarily complete a transaction, they CONSUMED it intently.
  - "repetition": the user has visited several distinct URLs that share the same canonicalized page-key pattern recently (e.g. multiple tweets from one author, multiple articles from one publisher, multiple product listings of a kind). The pattern is what's meaningful, not any single event.
  - "action-click": the user repeatedly clicked the same UI element on the same host within minutes — same testid or same normalized label. Each click event represents one item the user acted on. We do NOT pre-filter by verb — the cluster might be Save / Bookmark / Like / Follow / Add to cart / Star / RSVP / Subscribe / Pin / Upvote / "Save Recipe" / "Add to my Notion" / a star icon / a heart icon / etc. — OR it might be something noisy (Delete, Next, Reply). YOU decide. If meaningful, PROPOSE A TRACKER DATABASE for the collection (e.g. "Bookmarked Tweets", "Saved Jobs", "Wishlist Items", "Saved Recipes", "Starred Repos"), and emit one row PER distinct item the user acted on, extracting what you can from each click's fingerprint text/accessibleName and from the surrounding page context. If individual items aren't separable from the click fingerprints, emit one summary row describing the pattern (e.g. "5 saves on allrecipes.com") and explain in reasoning what was acted on. If the clicks are clearly noise (Delete in inbox, pagination, dismissing notifications), set meaningful=false.

Your job:

1. Decide whether the sequence represents something MEANINGFUL — worth saving to Notion. Be generous on "content-dwell" and "repetition" triggers: the heuristics have already filtered for engagement and recurrence, your job is to recognize what kind of artifact this is.
   - Meaningful examples: submitted a job application, made a purchase, signed up, scheduled a meeting, RSVP'd, saved/bookmarked, completed a transaction, engaged deeply with a job posting or product or event, recurring pattern of consuming content from a specific source (e.g. tweets from one account, articles from one publisher, recipes from one site), repeated action-clicks on a host (e.g. bookmarking tweets, saving jobs, wishlisting products, following authors).
   - NOT meaningful: random searches, abandoned forms, login screens, cookie banners, captchas, filter changes, app shells, ephemeral notifications.

2. If meaningful, produce a NOTION PROPOSAL:
   a. Target database — reuse one from "EXISTING DATABASES" (mode: "use-existing", set existingId) or propose a new one (mode: "create-new", existingId: null). Prefer reusing when the artifact fits naturally.
   b. For a new database: a short descriptive name, one-line description, schema of 4-8 properties. Property types: title, rich_text, url, date, select, multi_select, number. EXACTLY ONE property must be type "title". Use options[] only for select/multi_select; otherwise pass [].
   c. The row values — array of {property, value} pairs. Each property name MUST match the schema. Value types:
      - title/rich_text/url/select: string
      - date: ISO 8601
      - number: number
      - multi_select: array of strings
   d. For repetition: the row should represent the PATTERN (e.g. an entry in "Followed Authors" or "Frequently Read Publishers"), not the most recent single instance. The database schema should make sense for an evolving collection. Use JSON-LD author/publisher fields when present.
   e. Extract values only from observable data. Prefer JSON-LD when available — it's authoritative. Omit cells where the value isn't observable.

3. If NOT meaningful, set meaningful=false, give a one-sentence reasoning, proposal=null.

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
  properties: NotionPropertySpec[];
}

export async function judgeCandidate(
  candidate: CompletionCandidate,
  knownDatabases: KnownDatabase[],
): Promise<Judgement> {
  const key = await getOpenAiKey();
  if (!key) {
    throw new Error("no-openai-key");
  }

  const userPrompt = buildUserPrompt(candidate, knownDatabases);
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

function buildUserPrompt(candidate: CompletionCandidate, dbs: KnownDatabase[]): string {
  const dbBlock = dbs.length
    ? dbs
        .map(
          (d) =>
            `- id: ${d.id}\n  name: ${d.name}\n  properties: ${d.properties
              .map((p) => `${p.name}:${p.type}`)
              .join(", ")}`,
        )
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

  return [
    `EXISTING DATABASES:`,
    dbBlock,
    ``,
    `EVENT SEQUENCE (oldest → newest, summaries):`,
    earlierLines.length ? earlierLines.join("\n") : "(no prior context in window)",
    ``,
    `TRIGGER EVENT (${candidate.reason}${candidate.triggerNote ? `: ${candidate.triggerNote}` : ""}):`,
    triggerBlock,
  ].join("\n");
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
