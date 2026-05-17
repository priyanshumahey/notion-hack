// Background job-agent orchestrator.
//
// Lifecycle (one run):
//   1. collectJobContext()   — pull recent ATS pages the user visited from the
//                              local IDB AppEvent store. Extract titles/companies/URLs.
//   2. ensureJobAgentDbs()   — idempotently bootstrap the two job-agent DBs.
//   3. triggerJobProspector()— HMAC-signed POST to the worker webhook.
//                              The worker runs the 4-step `job-prospector` function.
//   4. pollAgentPicks(runId) — poll the Agent Picks DB for a row whose Run ID
//                              matches. The worker writes this row in its 4th step.
//   5. promoteLeads()        — fan the parsed leads JSON out into individual
//                              Job Leads rows (one Notion page per lead).
//
// The whole flow is fire-and-forget from the popup's perspective. The popup
// triggers `runJobAgent`, then periodically polls `getJobAgentStatus` to
// render progress.

import { makeLog } from "../lib/log";
import { getEventStore } from "../lib/store";
import {
  getObservationsClient,
  RealObservationsClient,
} from "../lib/notion/observations";
import {
  getBootstrapState,
  getExaKey,
  getNotionToken,
  setBootstrapState,
} from "../lib/settings";
import { triggerJobProspector } from "../lib/tracer";
import { newId } from "../lib/ids";
import type { AppEvent } from "../lib/types";
import type {
  AgentLead,
  AgentPickRow,
  JobLeadInput,
  RecentJobLead,
} from "../lib/notion/types";

const log = makeLog("job-agent");

// ATS / job-board host fragments. A URL is considered a job page if its
// hostname OR pathname matches one of these.
const ATS_HOST_HINTS = [
  "greenhouse.io",
  "lever.co",
  "ashbyhq.com",
  "wellfound.com",
  "ycombinator.com",
  "workatastartup.com",
  "jobs.workable.com",
  "myworkdayjobs.com",
  "smartrecruiters.com",
  "bamboohr.com",
  "linkedin.com/jobs",
  "indeed.com",
  "glassdoor.com",
] as const;

// How far back to look for job-page visits (ms). 24h keeps the signal fresh.
const CONTEXT_LOOKBACK_MS = 24 * 60 * 60 * 1000;
// How many AppEvents to scan when collecting context. Cheap — IDB recent() is O(n).
const CONTEXT_SCAN_LIMIT = 500;
// Cap titles/companies/urls sent to the worker (keeps the LLM prompt focused
// and well under the worker's 16KB http-body cap).
const CONTEXT_TITLES_MAX = 12;
const CONTEXT_COMPANIES_MAX = 8;
const CONTEXT_URLS_MAX = 20;

// Polling cadence. Worker advances 1 step/min, so 4 steps ≈ 4 min for a run
// to complete. Poll every 15s for snappy feedback once it lands.
const POLL_INTERVAL_MS = 15_000;
// Hard cap on polling — give up if the worker has had 8 minutes and still
// hasn't written the row.
const POLL_TIMEOUT_MS = 8 * 60_000;

// ---------------------------------------------------------------------------
// In-memory run status (popup polls this).
// ---------------------------------------------------------------------------

export type JobAgentPhase =
  | "idle"
  | "collecting"
  | "bootstrapping"
  | "triggering"
  | "waiting"
  | "promoting"
  | "done"
  | "error";

export interface JobAgentStatus {
  phase: JobAgentPhase;
  runId: string;
  /** Friendly one-liner for the popup. */
  message: string;
  /** Last error if phase==='error'. */
  error?: string;
  /** Populated once the Agent Picks row is written. */
  agentPickId?: string;
  query?: string;
  leads: AgentLead[];
  /** Job Leads rows actually written (post-promotion). */
  promotedCount: number;
  startedAt: number;
  updatedAt: number;
}

let currentStatus: JobAgentStatus = {
  phase: "idle",
  runId: "",
  message: "Idle.",
  leads: [],
  promotedCount: 0,
  startedAt: 0,
  updatedAt: 0,
};

export function getJobAgentStatus(): JobAgentStatus {
  return { ...currentStatus, leads: [...currentStatus.leads] };
}

function setStatus(patch: Partial<JobAgentStatus>): void {
  currentStatus = { ...currentStatus, ...patch, updatedAt: Date.now() };
  log("status", currentStatus.phase, currentStatus.message);
}

// ---------------------------------------------------------------------------
// Context collection — recent ATS visits from the local AppEvent store.
// ---------------------------------------------------------------------------

export interface JobContext {
  visitedTitles: string[];
  visitedCompanies: string[];
  visitedUrls: string[];
  locationHint: string;
}

export async function collectJobContext(locationHint = ""): Promise<JobContext> {
  const store = getEventStore();
  const events = await store.recent(CONTEXT_SCAN_LIMIT);
  const cutoff = Date.now() - CONTEXT_LOOKBACK_MS;

  const titles = new Set<string>();
  const companies = new Set<string>();
  const urls = new Set<string>();

  for (const e of events) {
    if (e.ts < cutoff) continue;
    if (!looksLikeJobUrl(e.url)) continue;
    urls.add(e.url);
    const t = extractJobTitle(e);
    if (t) titles.add(t);
    const c = extractCompany(e);
    if (c) companies.add(c);
  }

  return {
    visitedTitles: Array.from(titles).slice(0, CONTEXT_TITLES_MAX),
    visitedCompanies: Array.from(companies).slice(0, CONTEXT_COMPANIES_MAX),
    visitedUrls: Array.from(urls).slice(0, CONTEXT_URLS_MAX),
    locationHint: locationHint.trim() || "remote",
  };
}

function looksLikeJobUrl(url: string): boolean {
  if (!url) return false;
  const lower = url.toLowerCase();
  for (const hint of ATS_HOST_HINTS) {
    if (lower.includes(hint)) return true;
  }
  return false;
}

function extractJobTitle(e: AppEvent): string {
  // Prefer the og:title or twitter:title or page title from the captured
  // page context — they're more reliable than the raw <title> in many ATSes.
  const ctx = e.pageContext;
  if (!ctx) return "";
  const candidates = [
    ctx.og?.title,
    ctx.twitter?.title,
    ctx.title,
    ctx.headings?.find((h) => /^h1:/i.test(h))?.replace(/^h1:\s*/i, ""),
  ];
  for (const c of candidates) {
    const cleaned = cleanTitle(c);
    if (cleaned) return cleaned;
  }
  return "";
}

function cleanTitle(s: string | undefined): string {
  if (!s) return "";
  // Trim common boilerplate suffixes like " — Company Careers".
  let t = s.trim();
  t = t.replace(/\s*[-–|]\s*(careers|jobs|hiring|greenhouse|lever|ashby).*$/i, "");
  t = t.replace(/\s+/g, " ").trim();
  if (t.length < 4 || t.length > 120) return "";
  return t;
}

function extractCompany(e: AppEvent): string {
  const ctx = e.pageContext;
  if (!ctx) return "";
  // og:site_name is usually "<Company> Careers" or just "<Company>".
  const site = (ctx.og?.site_name ?? "").trim();
  if (site) {
    return site.replace(/\s*(careers|jobs|hiring)\s*$/i, "").trim();
  }
  // Greenhouse URLs look like boards.greenhouse.io/<company>/jobs/<id>.
  try {
    const u = new URL(e.url);
    if (u.hostname.endsWith("greenhouse.io")) {
      const seg = u.pathname.split("/").filter(Boolean)[0];
      if (seg) return slugToTitle(seg);
    }
    if (u.hostname.endsWith("lever.co")) {
      // jobs.lever.co/<company>/<id>
      const seg = u.pathname.split("/").filter(Boolean)[0];
      if (seg) return slugToTitle(seg);
    }
    if (u.hostname.endsWith("ashbyhq.com")) {
      const seg = u.pathname.split("/").filter(Boolean)[0];
      if (seg) return slugToTitle(seg);
    }
  } catch {
    // ignore parse errors
  }
  return "";
}

function slugToTitle(slug: string): string {
  return slug
    .replace(/[-_]+/g, " ")
    .replace(/\b\w/g, (c) => c.toUpperCase())
    .trim();
}

// ---------------------------------------------------------------------------
// Bootstrap the two job-agent DBs lazily.
// ---------------------------------------------------------------------------

async function ensureJobAgentDbs(): Promise<{
  agentPicksDbId: string;
  jobLeadsDbId: string;
}> {
  const b = await getBootstrapState();
  if (b.agentPicksDbId && b.jobLeadsDbId) {
    return { agentPicksDbId: b.agentPicksDbId, jobLeadsDbId: b.jobLeadsDbId };
  }
  if (!b.parentPageId) {
    throw new Error("Notion not bootstrapped — set parent page in Settings first.");
  }
  const client = await getObservationsClient();
  if (!client) throw new Error("Notion not connected.");
  const ids = await client.bootstrapJobAgent(b.parentPageId);
  await setBootstrapState({
    agentPicksDbId: ids.agentPicksDbId,
    jobLeadsDbId: ids.jobLeadsDbId,
  });
  if (client instanceof RealObservationsClient) {
    client.setAgentPicksDbId(ids.agentPicksDbId);
    client.setJobLeadsDbId(ids.jobLeadsDbId);
  }
  log("job-agent dbs bootstrapped", ids);
  return ids;
}

// ---------------------------------------------------------------------------
// Run orchestration.
// ---------------------------------------------------------------------------

export interface RunJobAgentOpts {
  /** Optional free-text city/remote preference; defaults to "remote". */
  locationHint?: string;
}

let runInFlight: Promise<JobAgentStatus> | null = null;

export async function runJobAgent(
  opts: RunJobAgentOpts = {},
): Promise<JobAgentStatus> {
  if (runInFlight) {
    log("runJobAgent: already in flight; returning existing");
    return runInFlight;
  }
  const runId = newId();
  setStatus({
    phase: "collecting",
    runId,
    message: "Collecting recent job context…",
    error: undefined,
    agentPickId: undefined,
    query: undefined,
    leads: [],
    promotedCount: 0,
    startedAt: Date.now(),
  });
  runInFlight = (async () => {
    try {
      const ctx = await collectJobContext(opts.locationHint ?? "");
      if (ctx.visitedUrls.length === 0) {
        // Soft signal — we still trigger, but tell the LLM nothing was visited.
        log.warn("no recent job-page visits found; triggering anyway");
      }
      setStatus({
        phase: "bootstrapping",
        message: "Ensuring Agent Picks / Job Leads DBs…",
      });
      const ids = await ensureJobAgentDbs();

      const [notionToken, exaKey] = await Promise.all([
        getNotionToken(),
        getExaKey(),
      ]);
      if (!notionToken) throw new Error("Notion token missing.");
      if (!exaKey) throw new Error("Exa API key missing.");

      const input = {
        exaKey,
        notionToken,
        agentPicksDbId: ids.agentPicksDbId,
        runId,
        visitedTitles: ctx.visitedTitles,
        visitedCompanies: ctx.visitedCompanies,
        visitedUrls: ctx.visitedUrls,
        locationHint: ctx.locationHint,
      };

      setStatus({
        phase: "triggering",
        message: "Triggering tracer worker…",
      });
      const r = await triggerJobProspector(input, runId);
      if (!r.ok) {
        throw new Error(`tracer trigger failed (${r.status}): ${r.body}`);
      }

      setStatus({
        phase: "waiting",
        message:
          "Worker is running (≈4 min: queryGen → search → parse → persist).",
      });
      const pick = await pollAgentPicks(runId);
      if (!pick) {
        throw new Error("timed out waiting for Agent Picks row");
      }
      setStatus({
        phase: "promoting",
        message: `Found ${pick.leads.length} leads. Writing Job Leads…`,
        agentPickId: pick.id,
        query: pick.query,
        leads: pick.leads,
      });
      const promoted = await promoteLeadsToJobLeads(pick, runId);
      // Best-effort: mark the Agent Picks row as promoted/empty.
      const client = await getObservationsClient();
      if (client instanceof RealObservationsClient) {
        await client.markAgentPickStatus(
          pick.id,
          pick.leads.length === 0 ? "empty" : "promoted",
        );
      }
      setStatus({
        phase: "done",
        message:
          promoted === 0
            ? "No leads returned. Try again later or browse more job pages."
            : `Saved ${promoted} new job leads to Notion.`,
        promotedCount: promoted,
      });
      return currentStatus;
    } catch (e) {
      const msg = (e as Error)?.message ?? String(e);
      log.error("runJobAgent failed", msg);
      setStatus({
        phase: "error",
        message: "Job agent failed.",
        error: msg,
      });
      return currentStatus;
    } finally {
      runInFlight = null;
    }
  })();
  return runInFlight;
}

// ---------------------------------------------------------------------------
// Polling.
// ---------------------------------------------------------------------------

async function pollAgentPicks(runId: string): Promise<AgentPickRow | null> {
  const client = await getObservationsClient();
  if (!(client instanceof RealObservationsClient)) return null;
  const deadline = Date.now() + POLL_TIMEOUT_MS;
  let attempt = 0;
  while (Date.now() < deadline) {
    attempt++;
    try {
      const row = await client.findAgentPickByRunId(runId);
      if (row) {
        log("pollAgentPicks: row found", runId, "after", attempt, "tries");
        return row;
      }
    } catch (e) {
      log.warn("pollAgentPicks: query failed", (e as Error).message);
    }
    await sleep(POLL_INTERVAL_MS);
  }
  return null;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ---------------------------------------------------------------------------
// Promotion: Agent Pick (JSON blob) → individual Job Leads rows.
// ---------------------------------------------------------------------------

async function promoteLeadsToJobLeads(
  pick: AgentPickRow,
  runId: string,
): Promise<number> {
  if (pick.leads.length === 0) return 0;
  const client = await getObservationsClient();
  if (!(client instanceof RealObservationsClient)) return 0;
  let count = 0;
  // Sequential to keep traffic modest and respect Notion rate limits.
  for (const lead of pick.leads) {
    const input: JobLeadInput = {
      title: lead.title,
      company: lead.company,
      url: lead.url,
      score: lead.score,
      source: "agent",
      foundAt: Date.now(),
      agentPickId: pick.id,
      runId,
    };
    try {
      const r = await client.createJobLead(input);
      if (r) count++;
    } catch (e) {
      log.warn("createJobLead failed", lead.url, (e as Error).message);
    }
  }
  return count;
}

// ---------------------------------------------------------------------------
// Read-side helpers exposed to the popup.
// ---------------------------------------------------------------------------

export async function listJobLeads(limit: number): Promise<RecentJobLead[]> {
  const client = await getObservationsClient();
  if (!(client instanceof RealObservationsClient)) return [];
  try {
    return await client.listJobLeads(limit);
  } catch (e) {
    log.warn("listJobLeads failed", (e as Error).message);
    return [];
  }
}

export async function listAgentPicks(limit: number): Promise<AgentPickRow[]> {
  const client = await getObservationsClient();
  if (!(client instanceof RealObservationsClient)) return [];
  try {
    return await client.listAgentPicks(limit);
  } catch (e) {
    log.warn("listAgentPicks failed", (e as Error).message);
    return [];
  }
}
