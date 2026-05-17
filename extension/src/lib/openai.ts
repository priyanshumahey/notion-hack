// LLM client — minimal, just what we need.
//
// Backend: Azure OpenAI (chat.completions on a named deployment). The
// deployment name (gpt-4o-mini) and api-version are baked into ENDPOINT;
// auth is via the `api-key` header rather than `Authorization: Bearer`.
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
// Azure OpenAI deployment endpoint. The deployment name in the path
// determines the model; the body's `model` field is ignored, so we omit it.
const ENDPOINT =
  "https://priya-mjx9ubft-eastus2.cognitiveservices.azure.com/openai/deployments/gpt-4o-mini/chat/completions?api-version=2025-01-01-preview";

const SYSTEM_PROMPT = `You are a backend agent for a browser extension that watches a user's web activity and decides what (if anything) is worth saving to their Notion workspace.

You will receive:
  - EXISTING DATABASES — every destination DB already in the user's workspace, with its schema and a few of its most-recent rows so you can see what kind of items already live there.
  - EXISTING WORKFLOWS — natural-language POLICIES the user has previously approved (e.g. "Save jobs from any company — user has approved Notion, OpenAI, DeepMind so far"). Each workflow points at a destination DB. Treat workflow.reasoning as the policy text and let it grow as more items are routed.
  - RECENT ACTIVITY — every browser event in the last few minutes (navs, clicks, page-dwells, form submits) with full page-context where available.
  - EXTENDED HISTORY — a compact one-line-per-page summary of nav events further back, used ONLY for detecting patterns (e.g. "user has viewed 2 other job postings this week").

Your job: decide whether the user's recent activity contains a single ARTIFACT worth saving to one of these databases, and if so, return the proposal.

KEY PRINCIPLES — lean toward letting the user save things, not toward gatekeeping:

0. ANCHOR ON THE TRIGGER — the artifact under consideration is the SINGLE event marked TRIGGER (the newest event in RECENT ACTIVITY). Older events are CONTEXT ONLY, used for two narrow purposes:
   (a) detecting repetition patterns ("user has viewed N similar items before");
   (b) helping you choose the right destination DB / workflow for the TRIGGER.
   Never propose saving an OLDER event just because it has a better existing-DB or workflow match. If the TRIGGER itself doesn't fit anything, return meaningful=false — do NOT reach back into earlier context for a save target.

   TOPIC SWITCHES: if the TRIGGER's host or apparent category differs from earlier events in the window (e.g. window starts on openai.com/careers, ends on allrecipes.com), the earlier events are a CLOSED EPISODE. They no longer represent the user's current intent. Do not save from them. The user already had a chance to save them when each one was the freshest event; their own moment has passed.

   The TRIGGER event is shown in FULL detail (page-context, JSON-LD, headings). Earlier events are compact summaries. That asymmetry is intentional — only the TRIGGER carries the artifact.

   WHAT THE ARTIFACT IS depends on the TRIGGER's kind — read this carefully, it's the most common failure mode:
   - If the TRIGGER is a nav or page-dwell to a specific item page (job detail, recipe page, product page, article, paper, etc.), the artifact IS that page.
   - If the TRIGGER is a CLICK on a listings / search / index / careers / catalog page, the artifact is the CLICKED ITEM, extracted from the click target's label/role (e.g. target: <link> "Data Scientist, Codex · Data Science · San Francisco" → that's the artifact). The TRIGGER's pageKey will be the listings URL (e.g. openai.com/careers/search, allrecipes.com, amazon.com/s) but the actual artifact is the job/product/recipe/etc the user just clicked. Treat that click as an act of opening the item — the user has declared interest in it even if no nav event has followed yet. DO NOT dismiss it as "just a listings page" — the click target is the artifact.
   - If the TRIGGER is a click revealing a modal/expander on the same page, the artifact is whatever the click revealed (from the click label or subsequent page-context).

1. CATEGORY GATE — different things go in different databases.
   - Before ANY routing decision, identify the ARTIFACT CATEGORY of the TRIGGER: job posting, recipe, product, article, paper, person, place, video, repo, etc.
   - An existing DB is ONLY a candidate if its category matches the TRIGGER's. Match on ALL of: name, description, AND sample-row content. If the existing DB is "Saved Recipes" (rows about food) and the TRIGGER is a job posting, that DB is NOT a fit — no matter how flexible its schema is. Do not force-route across categories.
   - If NO existing DB matches the TRIGGER's category:
       a) If the pattern threshold is met (≥2 similar items across RECENT ACTIVITY + EXTENDED HISTORY) → propose mode="create-new" with a sensibly-named NEW DB for that category.
       b) Otherwise → return meaningful=false. Cross-category mis-routing is always worse than waiting.
   - Cross-category examples (never route these together): jobs↔recipes, products↔articles, people↔places, papers↔videos, code-repos↔blog-posts.

2. PATTERNS BEAT SINGLE PAGES for NEW databases.
   - Routing to an EXISTING database that matches the TRIGGER's category? Single visit is enough — the user has already declared they care about this category.
   - Proposing a NEW database from scratch? Require at least ~2 DISTINCT artifacts of the same category in RECENT ACTIVITY + EXTENDED HISTORY combined. Count by DISTINCT artifact (different recipe titles, different job postings), NOT by event count — twenty clicks on the same one recipe page is still ONE artifact and is NOT a pattern. Two or three different ones in the same window IS.
   - You see distinct artifacts by looking at pageKey + page title + click label. Three different recipe names visible in the context ("Shoyu Chicken", "Easy Mexican Casserole", "A Great Greek Pasta Salad") is unambiguous proof of interest in recipes, even if each shows up as a one-line summary.
   - The patterns aren't about URLs being identical — they're about KIND. Two different job postings (different companies) is a pattern. A recipe page + an article-about-cooking is not.
   - FOR CLICKS ON LISTINGS PAGES: the click TARGET's LABEL is the artifact identity, NOT the pageKey. Five clicks on the SAME careers-search URL with FIVE different job-title labels = FIVE distinct job artifacts. Do NOT dismiss them as "all on the same page" — the page is just where the user is browsing; each click is a discovery of a new item. Concretely: distinct click labels that contain distinct item names (job titles, recipe names, product names, paper titles) count as distinct artifacts, and ≥ 2 of them is enough to justify creating a new DB.
   - The threshold is GENEROUS by design: 2 distinct artifacts is enough, 3+ is overwhelming evidence. Do not demand more. The whole point of this agent is to spin up the DB the moment a pattern is visible, not to wait until the user has hand-collected ten things.
   - When the threshold IS met and no existing DB fits the category, you MUST propose mode="create-new" with a sensibly-named DB. Don't return meaningful=false just because the DB doesn't exist yet — that's exactly when it should be created.

3. REUSE EXISTING DATABASES — but only inside the same category as the TRIGGER.
   - When the category matches: prefer mode="use-existing" and existingId of that DB. Copy the row's property names EXACTLY to the existing DB's column names.
   - The sample rows under each DB are the strongest category signal. If your new row would NOT look like a sibling of those samples, that DB is the WRONG category — don't use it.
   - Never duplicate a DB within the same category (don't propose "Jobs" if "Saved Jobs" already exists with job rows).

4. REUSE EXISTING WORKFLOWS — they are STANDING APPROVALS for routing the TRIGGER, not licenses to save older events.
   - Each workflow.reasoning describes the policy. If the TRIGGER matches a workflow's policy (same kind of artifact, same general source), reuse the workflow's targetDatabaseId. Mention the workflow in your reasoning ("matches workflow X").
   - sourceApps is a HINT, not a hard filter. A "Save jobs" workflow that listed jobs.ashbyhq.com should still accept a greenhouse.io job posting — as long as the TRIGGER is the job posting.
   - A workflow only fires if the TRIGGER fits its category. A "Save recipes" workflow does NOT accept a job posting; a "Save jobs" workflow does NOT fire when the TRIGGER is a recipe even if earlier events in the window were jobs.

5. EXTRACT FROM THE PAGE — use JSON-LD when present (it's authoritative), otherwise fall back to og:* tags, headings, then mainText. Extract from the TRIGGER's page-context only. Omit cells where the value isn't observable; don't hallucinate.

6. WHEN GENUINELY UNSURE, RETURN meaningful=false — but "unsure" means truly ambiguous: you can't tell what the item is, the category is unclear, or the signal is one fleeting click. It does NOT mean "I see a clear pattern but the DB doesn't exist yet" and it does NOT mean "the TRIGGER is a click on a listings page so I should bail". Failing to act on an obvious pattern is also a failure mode, and the more common one in practice. If the user has spent ~1 minute clicking through ≥ 2 distinct items of the same category, that IS a save signal — propose create-new and route the TRIGGER's item into it. The user can rename or delete a freshly-created DB in seconds; they cannot un-miss the moment of intent you ignored. Default toward acting; reserve meaningful=false for cases where you genuinely cannot identify an artifact or its category.

WHAT'S NOT WORTH SAVING:
  - Login screens, captchas, cookie banners, app shells, settings pages
  - The listings/search/index PAGE ITSELF as a row (you would never save the URL openai.com/careers/search or amazon.com/s?k=... as a saved item). HOWEVER, individual CLICKS on items WITHIN a listings page ARE artifact signals — each click target is an item the user is investigating, and those items ARE worth saving. Do not conflate "the listings page is not an artifact" with "clicks on tiles in that listings page are not artifacts".
  - Filter / sort changes, pagination clicks, dismissing notifications, sidebar/menu toggles

WORKED EXAMPLE — recipes, no existing DB, threshold met → create-new

EXISTING DATABASES: (no Recipes DB; maybe a Saved Jobs DB exists, irrelevant here)
EXISTING WORKFLOWS: (none relevant — a Saved Jobs workflow exists but doesn't apply)
RECENT ACTIVITY (compact, oldest → newest, ending with TRIGGER):
  [07:52:19] click "Shoyu Chicken" → allrecipes.com
  [07:52:20] nav → allrecipes.com/recipe/:id/shoyu-chicken
  [07:52:24] page-dwell → allrecipes.com/recipe/:id/shoyu-chicken
  [07:52:26] nav → allrecipes.com/recipe/:id/easy-mexican-casserole
  [07:52:34] page-dwell → allrecipes.com/recipe/:id/easy-mexican-casserole
  [07:52:37] click "A Great Greek Pasta Salad" → allrecipes.com
  [07:52:37] TRIGGER: click "View Recipe" → allrecipes.com/recipe/:id/a-great-greek-pasta-salad
    (full page-context with JSON-LD Recipe schema, ingredients, prep time, etc.)

CORRECT analysis:
  - TRIGGER artifact category = recipe.
  - Distinct recipe artifacts visible in context: Shoyu Chicken, Easy Mexican Casserole, A Great Greek Pasta Salad = THREE. Pattern threshold (≥2) is clearly met.
  - No existing DB matches the recipe category. Category gate prevents routing into Saved Jobs.
  - Therefore: propose mode="create-new" for a "Saved Recipes" DB. Do NOT return meaningful=false — the user has clearly demonstrated interest, and the whole point of this system is to spin up a DB when it's earned.

CORRECT output (shape, not literal):
{
  "meaningful": true,
  "confidence": 0.88,
  "reasoning": "Trigger is a recipe page. User viewed 3 distinct recipes in the last minute (Shoyu Chicken, Easy Mexican Casserole, Greek Pasta Salad) — clear pattern. No existing Recipes DB. Proposing a new 'Saved Recipes' DB.",
  "proposal": {
    "database": {
      "mode": "create-new",
      "existingId": null,
      "name": "Saved Recipes",
      "description": "Recipes the user is interested in cooking. Captured from recipe sites.",
      "properties": [
        { "name": "Title", "type": "title", "options": [] },
        { "name": "URL", "type": "url", "options": [] },
        { "name": "Source", "type": "select", "options": [] },
        { "name": "Prep Time", "type": "rich_text", "options": [] },
        { "name": "Cuisine", "type": "select", "options": [] },
        { "name": "Tags", "type": "multi_search", "options": [] }
      ]
    },
    "row": [
      { "property": "Title", "value": "A Great Greek Pasta Salad" },
      { "property": "URL", "value": "https://www.allrecipes.com/recipe/.../a-great-greek-pasta-salad" },
      { "property": "Source", "value": "Allrecipes" },
      { "property": "Cuisine", "value": "Greek" }
    ]
  }
}
(Pick property types from the allowed set; the Tags example above is illustrative — use "multi_select" not "multi_search".)

WRONG behavior to avoid in this scenario:
  - "User has not viewed enough similar items" → FALSE. Three distinct recipes in 25 seconds is plenty.
  - Routing into Saved Jobs because it's the only DB that exists → category mismatch, forbidden by principle 1.
  - Returning meaningful=false on this — that's the failure mode this example exists to prevent.

WORKED EXAMPLE 2 — careers page, ONLY clicks on tiles (no individual job-detail navs yet) → create-new

EXISTING DATABASES: (none relevant — maybe an unrelated Saved Recipes DB exists, doesn't matter)
EXISTING WORKFLOWS: (none)
RECENT ACTIVITY (compact, oldest → newest, ending with TRIGGER):
  [07:59:24] nav → openai.com/careers/search
  [07:59:40] click "AI Success Engineer · AI Success · Sydney, Australia" → openai.com/careers/search
  [07:59:45] click "Applied AI Engineer, Codex Core Agent · Codex Engineering · 4 locations" → openai.com/careers/search
  [07:59:54] click "ChatGPT Performance Engineer · Applied AI Engineering · 4 locations" → openai.com/careers/search
  [08:00:00] click "Counsel, AI Policy · Legal · 2 locations" → openai.com/careers/search
  [08:00:41] click "Data Center Controls Network Engineer · Datacenter Design · San Francisco" → openai.com/careers/search
  [08:00:48] TRIGGER: click "Data Scientist, Codex · Data Science · San Francisco" → openai.com/careers/search
    (full page-context: openai.com/careers/search — a listings page; the TRIGGER's fingerprint carries the clicked job tile's label)

CORRECT analysis:
  - TRIGGER is a CLICK on a job-tile on a careers listings page. pageKey is the careers URL, but per principle 0 the ARTIFACT is the CLICKED ITEM: "Data Scientist, Codex" on the OpenAI Data Science team in San Francisco. The TRIGGER's fingerprint label is where the artifact lives.
  - Distinct click labels visible across recent activity: AI Success Engineer, Applied AI Engineer, ChatGPT Performance Engineer, Counsel AI Policy, Data Center Controls Network Engineer, Data Scientist Codex = SIX distinct job artifacts in ~90 seconds. Pattern threshold (≥ 2) is massively exceeded.
  - No existing DB matches the job category. Category gate forbids routing into Saved Recipes.
  - Therefore: propose mode="create-new" for a "Saved Jobs" DB and route the TRIGGER's job (Data Scientist, Codex) into it.

CORRECT output (shape, not literal):
{
  "meaningful": true,
  "confidence": 0.9,
  "reasoning": "Trigger is a click on a specific job tile (Data Scientist, Codex) on the openai.com careers page. User has clicked through 6 distinct job postings in under 90 seconds — strong, unambiguous job-search pattern. No existing Jobs DB. Creating one.",
  "proposal": {
    "database": {
      "mode": "create-new",
      "existingId": null,
      "name": "Saved Jobs",
      "description": "Job postings the user is interested in. Captured from company careers pages and job boards.",
      "properties": [
        { "name": "Title", "type": "title", "options": [] },
        { "name": "Company", "type": "select", "options": [] },
        { "name": "Team", "type": "rich_text", "options": [] },
        { "name": "Location", "type": "rich_text", "options": [] },
        { "name": "URL", "type": "url", "options": [] },
        { "name": "Source", "type": "select", "options": [] }
      ]
    },
    "row": [
      { "property": "Title", "value": "Data Scientist, Codex" },
      { "property": "Company", "value": "OpenAI" },
      { "property": "Team", "value": "Data Science" },
      { "property": "Location", "value": "San Francisco" },
      { "property": "URL", "value": "https://openai.com/careers/search" },
      { "property": "Source", "value": "openai.com/careers" }
    ]
  }
}

WRONG behavior this example exists to prevent (the exact bug observed in production):
  - "The earlier events do not represent unique job postings" → FALSE. Each click label is a distinct job title — six distinct artifacts.
  - "TRIGGER pageKey is just the careers search page, so the artifact is a listings page and should be skipped" → WRONG. When the TRIGGER is a click on a tile, the click TARGET's label is the artifact, not the pageKey.
  - "We don't have a Jobs DB so we can't route this" → WRONG. The whole point of mode="create-new" is to spin up the DB the moment the pattern is earned. Six distinct jobs is way past earned.
  - Returning meaningful=false on this scenario is the primary failure mode of this agent. Don't.

OUTPUT — STRICT JSON, no markdown, no commentary. Use this exact shape:

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
}

For mode="use-existing", set existingId AND copy the existing DB's schema verbatim into properties (column names + types). The row property names MUST match. Value types: string for title/rich_text/url/select, ISO 8601 for date, number for number, string[] for multi_select. EXACTLY ONE property must be type "title".`;

export interface KnownDatabase {
  id: string;
  name: string;
  description: string;
  properties: NotionPropertySpec[];
  /**
   * A handful of recent rows from this DB, collapsed to
   * `propertyName -> string`. Surfaced in the prompt so the LLM can
   * pattern-match what already lives here. Best-effort; may be empty.
   */
  recentRows?: Array<{ properties: Record<string, string> }>;
}

/**
 * A workflow the user has previously approved (a row in their Workflows DB).
 * The judge treats matching workflows as STANDING APPROVALS: if a new
 * candidate looks like it would fire the same workflow, reuse the workflow's
 * target DB instead of proposing a new one — even if no destination DB
 * is an obvious name match.
 */
export interface KnownWorkflow {
  id: string;
  name: string;
  status: string;
  runMode: string;
  targetDatabaseId: string;
  targetDatabaseName: string;
  sourceApps: string[];
  reasoning: string;
  runCount: number;
}

export async function judgeCandidate(
  candidate: CompletionCandidate,
  knownDatabases: KnownDatabase[],
  knownWorkflows: KnownWorkflow[],
): Promise<Judgement> {
  const key = await getOpenAiKey();
  if (!key) {
    throw new Error("no-openai-key");
  }

  const userPrompt = buildUserPrompt(candidate, knownDatabases, knownWorkflows);
  log("judge → openai", {
    reason: candidate.reason,
    ctxLen: candidate.context.length,
    knownDbs: knownDatabases.length,
    knownWorkflows: knownWorkflows.length,
  });

  const resp = await fetch(ENDPOINT, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "api-key": key,
    },
    body: JSON.stringify({
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
    // Azure has no public `/v1/models`-equivalent we can hit with a key, so
    // do the smallest possible chat completion against the same deployment.
    const resp = await fetch(ENDPOINT, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "api-key": key,
      },
      body: JSON.stringify({
        messages: [{ role: "user", content: "ping" }],
        max_tokens: 1,
        temperature: 0,
      }),
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
  workflows: KnownWorkflow[],
): string {
  // ---- EXISTING DATABASES (with sample rows) ----------------------------
  const dbBlock = dbs.length
    ? dbs
        .map((d) => {
          const propLine = d.properties
            .map((p) => `${p.name}:${p.type}`)
            .join(", ");
          const descLine = d.description
            ? `\n  description: ${truncateLine(d.description, 200)}`
            : "";
          const rows = d.recentRows ?? [];
          const sampleBlock = rows.length
            ? "\n  recent rows:\n" +
              rows
                .slice(0, 5)
                .map((r) => {
                  const parts = Object.entries(r.properties)
                    .filter(([, v]) => v && v.length > 0)
                    .map(([k, v]) => `${k}=${truncateLine(v, 80)}`)
                    .join(" | ");
                  return `    · ${parts || "(empty row)"}`;
                })
                .join("\n")
            : "";
          return `- id: ${d.id}\n  name: ${d.name}${descLine}\n  properties: ${propLine}${sampleBlock}`;
        })
        .join("\n")
    : "(none — propose a new database only if the activity contains a clear recurring pattern across 2+ similar items)";

  // ---- EXISTING WORKFLOWS (policies) -----------------------------------
  const wfBlock = workflows.length
    ? workflows
        .map((w) => {
          const apps = w.sourceApps.length ? w.sourceApps.join(", ") : "(any)";
          const why = w.reasoning ? truncateLine(w.reasoning, 400) : "";
          return [
            `- workflow: ${w.name}`,
            `  status: ${w.status}  runMode: ${w.runMode}  runs: ${w.runCount}`,
            `  targetDatabaseId: ${w.targetDatabaseId}`,
            `  targetDatabaseName: ${w.targetDatabaseName}`,
            `  sourceApps: ${apps}`,
            why ? `  policy: ${why}` : null,
          ]
            .filter(Boolean)
            .join("\n");
        })
        .join("\n")
    : "(none — no prior workflows to reuse)";

  // ---- RECENT ACTIVITY (last few minutes, full context) ----------------
  // candidate.context already carries the rolling window from ingest.
  // Show every event with full page-context where available. Budget ~16 KB.
  const BUDGET = 16_000;
  const recentEvents = candidate.context.length ? candidate.context : [candidate.trigger];
  const recentBlocks: string[] = [];
  let used = 0;
  // newest first — if budget bites we drop oldest
  for (const e of recentEvents.slice().reverse()) {
    const isTrigger = e.id === candidate.trigger.id;
    // Full detail for the TRIGGER only. Older events are compact one-liners
    // — that asymmetry tells the LLM which event is the artifact under
    // consideration (see principle 0 in the system prompt).
    const block = isTrigger ? formatEventFull(e, /*isTrigger*/ true) : formatEventCompact(e);
    if (used + block.length > BUDGET) {
      recentBlocks.push(`… ${recentEvents.length - recentBlocks.length} earlier events omitted`);
      break;
    }
    recentBlocks.unshift(block);
    used += block.length;
  }

  // ---- EXTENDED HISTORY (one-liners, days back) ------------------------
  const extHistRaw = candidate.extendedHistory ?? [];
  const extHistBlock = extHistRaw.length
    ? extHistRaw
        .slice(0, 60)
        .map((h) => {
          const day = new Date(h.ts).toISOString().slice(0, 10);
          const title = h.title ? ` "${truncateLine(h.title, 80)}"` : "";
          return `- [${day}] ${h.pageKey}${title}`;
        })
        .join("\n")
    : "(none)";

  return [
    `EXISTING DATABASES (only route here if the artifact's CATEGORY matches the DB's category — checked via name, description, AND sample rows):`,
    dbBlock,
    ``,
    `EXISTING WORKFLOWS (prior user approvals — reuse their targetDatabaseId when current activity fits the policy AND the category):`,
    wfBlock,
    ``,
    `RECENT ACTIVITY (last few minutes, oldest → newest — the TRIGGER event at the end is the artifact under consideration and is shown in full; earlier events are CONTEXT ONLY, summarized in one line each):`,
    recentBlocks.length ? recentBlocks.join("\n") : "(no events)",
    ``,
    `EXTENDED HISTORY (older nav events — use ONLY to recognize patterns like "user has viewed N similar items before"):`,
    extHistBlock,
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
