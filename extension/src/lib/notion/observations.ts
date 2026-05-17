// ObservationsClient — talks to api.notion.com via REST.
//
// Authentication: an internal-integration token stored in chrome.storage.local
// (settings.getNotionToken). Token is passed as `Authorization: Bearer …`.
//
// Surface (grew past observations; see also Workflows + Runs):
//   - whoAmI()                  Settings → "test connection"
//   - searchParentPages()       Settings → parent picker
//   - bootstrapAll()            idempotent: ensure Observations + Workflows + Runs DBs
//   - createObservation()       hot path from ingest
//   - listRecentObservations()  popup observations tab
//   - findDatabaseByName()      apply: reuse destination DB if the user already has one
//   - createDatabase()          apply: create a new destination DB under our parent
//   - createPage()              apply: write a destination-DB row
//   - writeWorkflow()           apply: insert into Workflows
//   - writeRun()                apply: insert into Runs
//   - promoteObservation()      apply: PATCH Observations row Status → promoted
//   - listWorkflows() / listRuns()   popup tabs

import { makeLog } from "../log";
import type { NotionPropertySpec } from "../types";
import type {
  ObservationInput,
  ObservationRecord,
  ObservationsClient,
  ParentPageHit,
  RecentObservation,
  RecentWorkflow,
  RecentRun,
  WhoAmI,
  WorkflowInput,
  WorkflowRecord,
  RunInput,
  RunRecord,
  AgentLead,
  AgentPickRow,
  JobLeadInput,
  JobLeadRecord,
  RecentJobLead,
} from "./types";
import { NotionGatewayError } from "./types";
import type { NotionPropertyValue } from "./types";

const log = makeLog("notion");

const API = "https://api.notion.com/v1";
// Sticking with the stable 2022-06-28 version. The 2026-03-11 version moved
// database queries to `/v1/data_sources/{id}/query` (databases now have one
// or more data sources). Upgrading is a Phase 2/3 migration; for Phase 1 the
// old shape keeps observation writes + the dedupe query working uniformly.
const API_VERSION = "2022-06-28";

const OBSERVATIONS_DB_NAME = "Notion Dance · Observations";
const WORKFLOWS_DB_NAME = "Notion Dance · Workflows";
const RUNS_DB_NAME = "Notion Dance · Runs";
const AGENT_PICKS_DB_NAME = "Notion Dance · Agent Picks";
const JOB_LEADS_DB_NAME = "Notion Dance · Job Leads";

// Retry policy for transient errors (429 / 5xx). Capped low — fire-and-forget
// observation writes shouldn't pile up retries during a Notion outage.
const RETRY_MAX_ATTEMPTS = 3;
const RETRY_BASE_MS = 400;

/** Pre-defined select-property options. Notion auto-adds new values on insert,
 *  but predefining keeps the schema legible in the user's UI. */
const TRIGGER_KIND_OPTIONS = [
  { name: "form-submit", color: "blue" },
  { name: "terminal-nav", color: "purple" },
  { name: "content-dwell", color: "green" },
  { name: "repetition", color: "orange" },
  { name: "action-click", color: "yellow" },
  { name: "rich-page", color: "pink" },
] as const;

const OBSERVATION_STATUS_OPTIONS = [
  { name: "new", color: "default" },
  { name: "clustered", color: "blue" },
  { name: "proposed", color: "yellow" },
  { name: "promoted", color: "green" },
  { name: "dismissed", color: "gray" },
] as const;

const WORKFLOW_STATUS_OPTIONS = [
  { name: "proposed", color: "yellow" },
  { name: "active", color: "green" },
  { name: "paused", color: "gray" },
  { name: "archived", color: "default" },
] as const;

const WORKFLOW_RUN_MODE_OPTIONS = [
  { name: "ask-each-time", color: "blue" },
  { name: "auto-after-N", color: "yellow" },
  { name: "auto", color: "green" },
] as const;

const RUN_STATUS_OPTIONS = [
  { name: "proposed", color: "yellow" },
  { name: "confirmed", color: "green" },
  { name: "auto", color: "blue" },
  { name: "dismissed", color: "gray" },
  { name: "failed", color: "red" },
] as const;

const RUN_USER_RESPONSE_OPTIONS = [
  { name: "yes", color: "green" },
  { name: "no", color: "red" },
  { name: "no-ask-again", color: "default" },
  { name: "n/a", color: "gray" },
] as const;

const AGENT_PICK_STATUS_OPTIONS = [
  { name: "pending", color: "gray" },
  { name: "ready", color: "blue" },
  { name: "promoted", color: "green" },
  { name: "empty", color: "yellow" },
  { name: "error", color: "red" },
] as const;

const JOB_LEAD_SOURCE_OPTIONS = [
  { name: "visited", color: "blue" },
  { name: "agent", color: "purple" },
] as const;

const JOB_LEAD_STATUS_OPTIONS = [
  { name: "new", color: "default" },
  { name: "reviewed", color: "blue" },
  { name: "applied", color: "green" },
  { name: "archived", color: "gray" },
] as const;

interface ApiOpts {
  method?: "GET" | "POST" | "PATCH" | "DELETE";
  body?: unknown;
  signal?: AbortSignal;
}

export class RealObservationsClient implements ObservationsClient {
  constructor(
    private readonly token: string,
    private observationsDbId: string,
    private workflowsDbId: string,
    private runsDbId: string,
    private readonly cachedWorkspaceName: string = "",
    private agentPicksDbId: string = "",
    private jobLeadsDbId: string = "",
  ) {}

  workspaceName(): string {
    return this.cachedWorkspaceName || "Notion";
  }

  setObservationsDbId(id: string): void {
    this.observationsDbId = id || "";
  }

  setAgentPicksDbId(id: string): void {
    this.agentPicksDbId = id || "";
  }

  setJobLeadsDbId(id: string): void {
    this.jobLeadsDbId = id || "";
  }

  setWorkflowsDbId(id: string): void {
    this.workflowsDbId = id || "";
  }

  setRunsDbId(id: string): void {
    this.runsDbId = id || "";
  }

  async whoAmI(): Promise<WhoAmI> {
    const me = await this.api<NotionUser>("/users/me", { method: "GET" });
    const workspaceName =
      (me.bot?.workspace_name as string | undefined) ?? me.name ?? "Notion";
    return { workspaceName, botUserId: me.id };
  }

  async searchParentPages(query: string, limit: number): Promise<ParentPageHit[]> {
    const body: Record<string, unknown> = {
      filter: { value: "page", property: "object" },
      page_size: Math.min(Math.max(limit, 1), 50),
      sort: { direction: "descending", timestamp: "last_edited_time" },
    };
    if (query.trim()) body.query = query.trim();
    const res = await this.api<NotionSearchResponse>("/search", {
      method: "POST",
      body,
    });
    const out: ParentPageHit[] = [];
    for (const r of res.results ?? []) {
      if (r.object !== "page") continue;
      const title = extractPageTitle(r);
      out.push({
        id: r.id,
        title: title || "(untitled)",
        url: r.url ?? "",
        lastEditedAt: r.last_edited_time,
      });
    }
    return out;
  }

  async bootstrapObservations(
    parentPageId: string,
  ): Promise<{ observationsDbId: string }> {
    if (!parentPageId) {
      throw new NotionGatewayError("validation_error", "parentPageId required");
    }

    // Idempotency: search for an existing DB with our canonical name under
    // this parent. Safer than relying on a stored id that might point at a
    // trashed DB.
    const existing = await this.findChildDatabase(parentPageId, OBSERVATIONS_DB_NAME);
    if (existing) {
      log("bootstrap: reusing existing observations db", existing.id);
      this.observationsDbId = existing.id;
      return { observationsDbId: existing.id };
    }

    const created = await this.api<NotionDatabaseRaw>("/databases", {
      method: "POST",
      body: {
        parent: { type: "page_id", page_id: parentPageId },
        title: [{ type: "text", text: { content: OBSERVATIONS_DB_NAME } }],
        properties: observationsSchemaPayload(),
      },
    });
    log("bootstrap: created observations db", created.id);
    this.observationsDbId = created.id;
    return { observationsDbId: created.id };
  }

  async bootstrapWorkflows(
    parentPageId: string,
  ): Promise<{ workflowsDbId: string }> {
    if (!parentPageId) {
      throw new NotionGatewayError("validation_error", "parentPageId required");
    }
    const existing = await this.findChildDatabase(parentPageId, WORKFLOWS_DB_NAME);
    if (existing) {
      log("bootstrap: reusing existing workflows db", existing.id);
      this.workflowsDbId = existing.id;
      return { workflowsDbId: existing.id };
    }
    const created = await this.api<NotionDatabaseRaw>("/databases", {
      method: "POST",
      body: {
        parent: { type: "page_id", page_id: parentPageId },
        title: [{ type: "text", text: { content: WORKFLOWS_DB_NAME } }],
        properties: workflowsSchemaPayload(),
      },
    });
    log("bootstrap: created workflows db", created.id);
    this.workflowsDbId = created.id;
    return { workflowsDbId: created.id };
  }

  async bootstrapRuns(parentPageId: string): Promise<{ runsDbId: string }> {
    if (!parentPageId) {
      throw new NotionGatewayError("validation_error", "parentPageId required");
    }
    const existing = await this.findChildDatabase(parentPageId, RUNS_DB_NAME);
    if (existing) {
      log("bootstrap: reusing existing runs db", existing.id);
      this.runsDbId = existing.id;
      return { runsDbId: existing.id };
    }
    const created = await this.api<NotionDatabaseRaw>("/databases", {
      method: "POST",
      body: {
        parent: { type: "page_id", page_id: parentPageId },
        title: [{ type: "text", text: { content: RUNS_DB_NAME } }],
        properties: runsSchemaPayload(),
      },
    });
    log("bootstrap: created runs db", created.id);
    this.runsDbId = created.id;
    return { runsDbId: created.id };
  }

  /** Ensure all three Notion Dance DBs exist under the given parent. Idempotent. */
  async bootstrapAll(parentPageId: string): Promise<{
    observationsDbId: string;
    workflowsDbId: string;
    runsDbId: string;
  }> {
    // Run sequentially — keep the search/create traffic predictable and easy
    // to debug. Bootstrap is a one-time interactive flow; latency doesn't matter.
    const o = await this.bootstrapObservations(parentPageId);
    const w = await this.bootstrapWorkflows(parentPageId);
    const r = await this.bootstrapRuns(parentPageId);
    return {
      observationsDbId: o.observationsDbId,
      workflowsDbId: w.workflowsDbId,
      runsDbId: r.runsDbId,
    };
  }

  // ---- Job-agent DBs (Agent Picks + Job Leads) -------------------------

  async bootstrapAgentPicks(
    parentPageId: string,
  ): Promise<{ agentPicksDbId: string }> {
    if (!parentPageId) {
      throw new NotionGatewayError("validation_error", "parentPageId required");
    }
    const existing = await this.findChildDatabase(parentPageId, AGENT_PICKS_DB_NAME);
    if (existing) {
      log("bootstrap: reusing existing agent picks db", existing.id);
      this.agentPicksDbId = existing.id;
      return { agentPicksDbId: existing.id };
    }
    const created = await this.api<NotionDatabaseRaw>("/databases", {
      method: "POST",
      body: {
        parent: { type: "page_id", page_id: parentPageId },
        title: [{ type: "text", text: { content: AGENT_PICKS_DB_NAME } }],
        properties: agentPicksSchemaPayload(),
      },
    });
    log("bootstrap: created agent picks db", created.id);
    this.agentPicksDbId = created.id;
    return { agentPicksDbId: created.id };
  }

  async bootstrapJobLeads(
    parentPageId: string,
  ): Promise<{ jobLeadsDbId: string }> {
    if (!parentPageId) {
      throw new NotionGatewayError("validation_error", "parentPageId required");
    }
    const existing = await this.findChildDatabase(parentPageId, JOB_LEADS_DB_NAME);
    if (existing) {
      log("bootstrap: reusing existing job leads db", existing.id);
      this.jobLeadsDbId = existing.id;
      return { jobLeadsDbId: existing.id };
    }
    const created = await this.api<NotionDatabaseRaw>("/databases", {
      method: "POST",
      body: {
        parent: { type: "page_id", page_id: parentPageId },
        title: [{ type: "text", text: { content: JOB_LEADS_DB_NAME } }],
        properties: jobLeadsSchemaPayload(),
      },
    });
    log("bootstrap: created job leads db", created.id);
    this.jobLeadsDbId = created.id;
    return { jobLeadsDbId: created.id };
  }

  /** Bootstrap both job-agent DBs in one call. Idempotent. */
  async bootstrapJobAgent(
    parentPageId: string,
  ): Promise<{ agentPicksDbId: string; jobLeadsDbId: string }> {
    const a = await this.bootstrapAgentPicks(parentPageId);
    const j = await this.bootstrapJobLeads(parentPageId);
    return { agentPicksDbId: a.agentPicksDbId, jobLeadsDbId: j.jobLeadsDbId };
  }

  /** Look up an Agent Picks row by its Run ID property. Returns null if not found. */
  async findAgentPickByRunId(runId: string): Promise<AgentPickRow | null> {
    if (!this.agentPicksDbId || !runId) return null;
    const res = await this.api<NotionQueryResponse>(
      `/databases/${this.agentPicksDbId}/query`,
      {
        method: "POST",
        body: {
          filter: { property: "Run ID", rich_text: { equals: runId } },
          page_size: 1,
        },
      },
    );
    const row = res.results?.[0];
    if (!row) return null;
    return rowToAgentPick(row);
  }

  /** Most recent Agent Picks rows, newest first. */
  async listAgentPicks(limit: number): Promise<AgentPickRow[]> {
    if (!this.agentPicksDbId) return [];
    const pageSize = Math.min(Math.max(limit, 1), 50);
    const res = await this.api<NotionQueryResponse>(
      `/databases/${this.agentPicksDbId}/query`,
      {
        method: "POST",
        body: {
          page_size: pageSize,
          sorts: [{ timestamp: "created_time", direction: "descending" }],
        },
      },
    );
    return (res.results ?? []).map(rowToAgentPick);
  }

  /** PATCH an Agent Picks row's Status (e.g. ready → promoted). */
  async markAgentPickStatus(
    agentPickId: string,
    status: "pending" | "ready" | "promoted" | "empty" | "error",
  ): Promise<void> {
    if (!agentPickId) return;
    try {
      await this.api(`/pages/${agentPickId}`, {
        method: "PATCH",
        body: { properties: { Status: { select: { name: status } } } },
      });
    } catch (e) {
      log.warn("markAgentPickStatus: PATCH failed", agentPickId, (e as Error).message);
    }
  }

  async createJobLead(input: JobLeadInput): Promise<JobLeadRecord | null> {
    if (!this.jobLeadsDbId) {
      log.warn("createJobLead: no job leads db id; skipping");
      return null;
    }
    // Dedup on source URL — clicking "Save" twice on the same lead should
    // not produce duplicate rows.
    if (/^https?:\/\//i.test(input.url)) {
      try {
        const existing = await this.api<NotionQueryResponse>(
          `/databases/${this.jobLeadsDbId}/query`,
          {
            method: "POST",
            body: {
              filter: { property: "URL", url: { equals: input.url } },
              page_size: 1,
            },
          },
        );
        const hit = existing.results?.[0];
        if (hit) {
          log("createJobLead: dedup hit", input.url, hit.id);
          return { id: hit.id, url: hit.url ?? "" };
        }
      } catch (e) {
        log.warn("createJobLead: dedup query failed", (e as Error).message);
      }
    }
    const props = jobLeadToProperties(input);
    const page = await this.api<NotionPageRaw>("/pages", {
      method: "POST",
      body: { parent: { database_id: this.jobLeadsDbId }, properties: props },
    });
    log("job lead written", page.id, input.title);
    return { id: page.id, url: page.url ?? "" };
  }

  async listJobLeads(limit: number): Promise<RecentJobLead[]> {
    if (!this.jobLeadsDbId) return [];
    const pageSize = Math.min(Math.max(limit, 1), 50);
    const res = await this.api<NotionQueryResponse>(
      `/databases/${this.jobLeadsDbId}/query`,
      {
        method: "POST",
        body: {
          page_size: pageSize,
          sorts: [{ property: "Found At", direction: "descending" }],
        },
      },
    );
    return (res.results ?? []).map(rowToJobLead);
  }

  async createObservation(input: ObservationInput): Promise<ObservationRecord | null> {
    if (!this.observationsDbId) {
      log.warn("createObservation: no observations db id; skipping");
      return null;
    }

    // Idempotency: if a row already exists for this localEventId, return it
    // instead of inserting a duplicate. Cheap query — DB is filtered to one
    // page max. PRD §3.1 says exactly one Observations row per trigger.
    if (input.localEventId) {
      const existing = await this.findByLocalEventId(input.localEventId);
      if (existing) {
        log("createObservation: dedup hit", input.localEventId, existing.id);
        return existing;
      }
    }

    const props = observationToProperties(input);
    const page = await this.api<NotionPageRaw>("/pages", {
      method: "POST",
      body: { parent: { database_id: this.observationsDbId }, properties: props },
    });
    return { id: page.id, url: page.url ?? "" };
  }

  private async findByLocalEventId(
    localEventId: string,
  ): Promise<ObservationRecord | null> {
    if (!this.observationsDbId) return null;
    try {
      const res = await this.api<NotionQueryResponse>(
        `/databases/${this.observationsDbId}/query`,
        {
          method: "POST",
          body: {
            page_size: 1,
            filter: {
              property: "Local Event Id",
              rich_text: { equals: localEventId },
            },
          },
        },
      );
      const hit = (res.results ?? [])[0];
      if (!hit) return null;
      return { id: hit.id, url: hit.url ?? "" };
    } catch (e) {
      // Dedup is a nice-to-have; if the query fails (e.g. schema drift), let
      // the caller proceed with the insert and accept potential duplicates.
      log.warn("findByLocalEventId failed; proceeding without dedup", (e as Error).message);
      return null;
    }
  }

  async listRecentObservations(limit: number): Promise<RecentObservation[]> {
    if (!this.observationsDbId) return [];
    const pageSize = Math.min(Math.max(limit, 1), 50);
    const res = await this.api<NotionQueryResponse>(
      `/databases/${this.observationsDbId}/query`,
      {
        method: "POST",
        body: {
          page_size: pageSize,
          sorts: [{ property: "Captured At", direction: "descending" }],
        },
      },
    );
    return (res.results ?? []).map(rowToRecent);
  }

  // ---- Destination DB management ----------------------------------------
  //
  // Used by the apply flow to create / reuse the user's workflow target DBs.
  // We dedup by name under the Notion Dance parent page so re-approving a
  // similar candidate doesn't create a forest of "Jobs (2)", "Jobs (3)" DBs.

  /** Returns null if no DB with this exact name exists under the parent. */
  async findDestinationDatabaseByName(
    parentPageId: string,
    name: string,
  ): Promise<{ id: string } | null> {
    return this.findChildDatabase(parentPageId, name);
  }

  /** Fetch a DB's schema. Returns null on 404 (DB was deleted in Notion). */
  async getDatabaseSchema(
    databaseId: string,
  ): Promise<{ id: string; name: string; properties: NotionPropertySpec[] } | null> {
    try {
      const raw = await this.api<NotionDatabaseFullRaw>(
        `/databases/${databaseId}`,
        { method: "GET" },
      );
      return {
        id: raw.id,
        name: extractDatabaseTitleFull(raw),
        properties: parsePropertiesSchema(raw.properties ?? {}),
      };
    } catch (e) {
      if (e instanceof NotionGatewayError && e.code === "not_found") return null;
      throw e;
    }
  }

  /** Create a destination DB under our parent page with the given schema. */
  async createDestinationDatabase(input: {
    parentPageId: string;
    name: string;
    description: string;
    properties: NotionPropertySpec[];
  }): Promise<{ id: string; name: string; properties: NotionPropertySpec[] }> {
    const schemaProps = specsToNotionSchema(input.properties);
    const created = await this.api<NotionDatabaseFullRaw>("/databases", {
      method: "POST",
      body: {
        parent: { type: "page_id", page_id: input.parentPageId },
        title: [{ type: "text", text: { content: clip(input.name, 200) } }],
        description: input.description
          ? [{ type: "text", text: { content: clip(input.description, 400) } }]
          : [],
        properties: schemaProps,
      },
    });
    log("created destination db", created.id, input.name);
    return {
      id: created.id,
      name: input.name,
      properties: input.properties,
    };
  }

  /** Create a page in any DB given a coerced value map. Returns id + url. */
  async createPageInDatabase(input: {
    databaseId: string;
    values: Record<string, NotionPropertyValue>;
  }): Promise<{ id: string; url: string }> {
    const props = valuesToNotionProperties(input.values);
    const page = await this.api<NotionPageRaw>("/pages", {
      method: "POST",
      body: {
        parent: { database_id: input.databaseId },
        properties: props,
      },
    });
    return { id: page.id, url: page.url ?? "" };
  }

  /**
   * Return the first existing page in `databaseId` whose `urlPropertyName`
   * equals any of `urls`. Used by the apply path to prevent duplicate rows
   * when several triggers (rich-page + content-dwell + action-click) all
   * converge on the same artifact.
   *
   * Returns null on schema mismatch or no match. Errors are swallowed and
   * logged — dedup is a best-effort guard, not a hard requirement.
   */
  async findRowByUrl(
    databaseId: string,
    urlPropertyName: string,
    urls: string[],
  ): Promise<{ id: string; url: string } | null> {
    const wanted = urls.map((u) => u.trim()).filter(Boolean);
    if (!wanted.length || !urlPropertyName) return null;
    const filter =
      wanted.length === 1
        ? { property: urlPropertyName, url: { equals: wanted[0] } }
        : {
            or: wanted.map((u) => ({
              property: urlPropertyName,
              url: { equals: u },
            })),
          };
    try {
      type Row = { id: string; url?: string };
      const data = await this.api<{ results?: Row[] }>(
        `/databases/${databaseId}/query`,
        { method: "POST", body: { filter, page_size: 1 } },
      );
      const hit = data.results?.[0];
      if (!hit) return null;
      return { id: hit.id, url: hit.url ?? "" };
    } catch (e) {
      // Schema may not actually have a URL property of that name — Notion
      // returns 400 validation_error. Treat as "no dedupe possible".
      if (
        e instanceof NotionGatewayError &&
        (e.code === "bad_request" || e.code === "validation_error")
      ) {
        log("findRowByUrl: dedup query rejected", urlPropertyName, e.message);
        return null;
      }
      throw e;
    }
  }

  /**
   * Read a handful of recent rows from a destination DB for the judge
   * prompt. Each row is collapsed to a `{prop: string}` map so the LLM
   * can see "what kind of stuff already lives in Saved Jobs" without
   * us having to teach it Notion's full property JSON shape.
   *
   * Best-effort: returns [] on any error. NEVER throw — this is purely
   * informational context.
   */
  async listRecentRows(
    databaseId: string,
    limit: number,
  ): Promise<Array<{ id: string; properties: Record<string, string> }>> {
    if (!databaseId) return [];
    const pageSize = Math.min(Math.max(limit, 1), 10);
    try {
      const res = await this.api<NotionQueryResponse>(
        `/databases/${databaseId}/query`,
        {
          method: "POST",
          body: {
            page_size: pageSize,
            sorts: [{ timestamp: "created_time", direction: "descending" }],
          },
        },
      );
      const out: Array<{ id: string; properties: Record<string, string> }> = [];
      for (const row of res.results ?? []) {
        const props: Record<string, string> = {};
        for (const [name, p] of Object.entries(row.properties ?? {})) {
          const v = formatRowPropValue(p);
          if (v) props[name] = v;
        }
        out.push({ id: row.id, properties: props });
      }
      return out;
    } catch (e) {
      log.warn("listRecentRows: failed", databaseId, (e as Error).message);
      return [];
    }
  }

  // ---- Workflows --------------------------------------------------------

  async writeWorkflow(input: WorkflowInput): Promise<WorkflowRecord> {
    if (!this.workflowsDbId) {
      throw new NotionGatewayError("validation_error", "workflows db not bootstrapped");
    }
    const props = workflowToProperties(input);
    const page = await this.api<NotionPageRaw>("/pages", {
      method: "POST",
      body: { parent: { database_id: this.workflowsDbId }, properties: props },
    });
    log("workflow written", page.id, input.name);
    return { id: page.id, url: page.url ?? "" };
  }

  async listWorkflows(limit: number): Promise<RecentWorkflow[]> {
    if (!this.workflowsDbId) return [];
    const pageSize = Math.min(Math.max(limit, 1), 50);
    const res = await this.api<NotionQueryResponse>(
      `/databases/${this.workflowsDbId}/query`,
      {
        method: "POST",
        body: {
          page_size: pageSize,
          sorts: [{ property: "Approved At", direction: "descending" }],
        },
      },
    );
    return (res.results ?? []).map(rowToWorkflow);
  }

  /**
   * Find an existing ACTIVE workflow that targets the same destination DB
   * with the same canonical name. Returned to the apply path so we can
   * increment Run Count + union Source Apps instead of creating a duplicate
   * workflow row.
   *
   * Matching key: (name, Target Database Id, status=active). Name is built
   * deterministically by inferWorkflowName(reason, dbName) — different
   * trigger reasons targeting the same DB therefore remain distinct
   * policies (e.g. "Save → Saved Jobs" vs "Save read → Saved Jobs"), but
   * repeated saves of the same kind to the same DB fold together.
   *
   * If multiple matches exist (legacy duplicate state), return the OLDEST
   * by Approved At — that's the row to keep growing. The remaining
   * duplicates can be archived manually.
   */
  async findActiveWorkflowForTarget(
    name: string,
    targetDatabaseId: string,
  ): Promise<RecentWorkflow | null> {
    if (!this.workflowsDbId) return null;
    if (!targetDatabaseId || !name.trim()) return null;
    try {
      const res = await this.api<NotionQueryResponse>(
        `/databases/${this.workflowsDbId}/query`,
        {
          method: "POST",
          body: {
            page_size: 10,
            filter: {
              and: [
                { property: "Name", title: { equals: name } },
                {
                  property: "Target Database Id",
                  rich_text: { equals: targetDatabaseId },
                },
                { property: "Status", select: { equals: "active" } },
              ],
            },
            // Oldest first — the workflow with the longest history wins.
            sorts: [{ property: "Approved At", direction: "ascending" }],
          },
        },
      );
      const hits = (res.results ?? []).map(rowToWorkflow);
      return hits[0] ?? null;
    } catch (e) {
      // Fall through — apply path will create as a new workflow. Worse than
      // ideal but not data-corrupting.
      log.warn("findActiveWorkflowForTarget failed", (e as Error).message);
      return null;
    }
  }

  /**
   * PATCH an existing workflow row to record a fresh run:
   *   - Run Count += 1
   *   - Last Triggered = now
   *   - Source Apps unioned with the new run's hosts (capped 20)
   *
   * Reasoning is intentionally NOT overwritten — the original LLM
   * justification stays as the workflow's stable description; the moving
   * parts are confined to counters and hosts.
   */
  async incrementWorkflowRun(args: {
    workflowPageId: string;
    prevRunCount: number;
    prevSourceApps: string[];
    newSourceApps: string[];
    triggeredAt: number;
  }): Promise<void> {
    if (!args.workflowPageId) return;
    const union = new Set<string>();
    for (const s of args.prevSourceApps) if (s) union.add(s);
    for (const s of args.newSourceApps) if (s) union.add(s);
    const merged = Array.from(union).slice(0, 20);
    try {
      await this.api(`/pages/${args.workflowPageId}`, {
        method: "PATCH",
        body: {
          properties: {
            "Run Count": { number: (args.prevRunCount || 0) + 1 },
            "Last Triggered": {
              date: { start: new Date(args.triggeredAt).toISOString() },
            },
            "Source Apps": {
              multi_select: merged.map((s) => ({ name: clip(s, 100) })),
            },
          },
        },
      });
    } catch (e) {
      log.warn(
        "incrementWorkflowRun PATCH failed",
        args.workflowPageId,
        (e as Error).message,
      );
    }
  }

  // ---- Runs -------------------------------------------------------------

  async writeRun(input: RunInput): Promise<RunRecord> {
    if (!this.runsDbId) {
      throw new NotionGatewayError("validation_error", "runs db not bootstrapped");
    }
    const props = runToProperties(input);
    const page = await this.api<NotionPageRaw>("/pages", {
      method: "POST",
      body: { parent: { database_id: this.runsDbId }, properties: props },
    });
    log("run written", page.id, input.status);
    return { id: page.id, url: page.url ?? "" };
  }

  async listRuns(limit: number): Promise<RecentRun[]> {
    if (!this.runsDbId) return [];
    const pageSize = Math.min(Math.max(limit, 1), 50);
    const res = await this.api<NotionQueryResponse>(
      `/databases/${this.runsDbId}/query`,
      {
        method: "POST",
        body: {
          page_size: pageSize,
          sorts: [{ property: "Triggered At", direction: "descending" }],
        },
      },
    );
    return (res.results ?? []).map(rowToRun);
  }

  // ---- Observation promotion -------------------------------------------

  /** PATCH an Observations row Status → promoted and link to a Workflow page id.
   *  Best-effort: returns false if the row can't be located. */
  async promoteObservationByLocalEventId(
    localEventId: string,
    workflowPageId: string,
  ): Promise<boolean> {
    const row = await this.findByLocalEventId(localEventId);
    if (!row) return false;
    try {
      await this.api(`/pages/${row.id}`, {
        method: "PATCH",
        body: {
          properties: {
            Status: { select: { name: "promoted" } },
            "Workflow Page Id": {
              rich_text: workflowPageId
                ? [{ type: "text", text: { content: workflowPageId } }]
                : [],
            },
          },
        },
      });
      return true;
    } catch (e) {
      log.warn("promoteObservation: PATCH failed", localEventId, (e as Error).message);
      return false;
    }
  }

  // ---- Workspace inventory (for the judge) ------------------------------

  /**
   * List ALL databases that live directly under `parentPageId`.
   *
   * Used by the judge prompt: the LLM needs to see what destination DBs
   * already exist in the user's workspace so it routes new artifacts into
   * them instead of inventing duplicates. We filter out the three system
   * DBs (Observations / Workflows / Runs) — those are bookkeeping, never
   * a destination.
   *
   * Each row includes the full property schema so the LLM can populate
   * existing columns correctly when it picks `use-existing`.
   */
  async listChildDatabases(
    parentPageId: string,
    limit = 50,
  ): Promise<{ id: string; name: string; description: string; properties: NotionPropertySpec[] }[]> {
    // Notion /search returns at most 100 per page. We paginate up to `limit`
    // total. In practice users have far fewer than 100 DBs under one page.
    const out: { id: string; name: string; description: string; properties: NotionPropertySpec[] }[] = [];
    let cursor: string | undefined;
    const systemNames = new Set([
      OBSERVATIONS_DB_NAME,
      WORKFLOWS_DB_NAME,
      RUNS_DB_NAME,
    ]);
    while (out.length < limit) {
      const body: Record<string, unknown> = {
        filter: { value: "database", property: "object" },
        page_size: Math.min(100, limit - out.length),
      };
      if (cursor) body.start_cursor = cursor;
      const res = await this.api<NotionSearchResponse & {
        has_more?: boolean;
        next_cursor?: string | null;
      }>("/search", { method: "POST", body });
      for (const r of res.results ?? []) {
        if (r.object !== "database") continue;
        if (r.parent?.type !== "page_id") continue;
        if (normId(r.parent.page_id ?? "") !== normId(parentPageId)) continue;
        const name = extractDatabaseTitle(r).trim();
        if (!name || systemNames.has(name)) continue;
        // Fetch the full schema (the /search response omits property type
        // details). Tolerate per-DB failures — a single broken DB shouldn't
        // poison the whole inventory.
        try {
          const full = await this.api<NotionDatabaseFullRaw & {
            description?: NotionRichTextRaw[];
          }>(`/databases/${r.id}`, { method: "GET" });
          const desc = (full.description ?? [])
            .map((t) => t.plain_text ?? "")
            .join("");
          out.push({
            id: full.id,
            name: extractDatabaseTitleFull(full) || name,
            description: desc,
            properties: parsePropertiesSchema(full.properties ?? {}),
          });
        } catch (e) {
          log.warn(
            "listChildDatabases: skipping db",
            r.id,
            (e as Error).message,
          );
        }
      }
      if (!res.has_more || !res.next_cursor) break;
      cursor = res.next_cursor;
    }
    return out;
  }

  // ---- low level ---------------------------------------------------------

  private async findChildDatabase(
    parentPageId: string,
    name: string,
  ): Promise<{ id: string } | null> {
    const res = await this.api<NotionSearchResponse>("/search", {
      method: "POST",
      body: {
        query: name,
        filter: { value: "database", property: "object" },
        page_size: 50,
      },
    });
    for (const r of res.results ?? []) {
      if (r.object !== "database") continue;
      const parent = r.parent;
      if (parent?.type !== "page_id") continue;
      if (normId(parent.page_id ?? "") !== normId(parentPageId)) continue;
      const title = extractDatabaseTitle(r);
      if (title.trim() === name.trim()) return { id: r.id };
    }
    return null;
  }

  private async api<T>(path: string, opts: ApiOpts = {}): Promise<T> {
    const method = opts.method ?? "GET";
    const init: RequestInit = {
      method,
      headers: {
        Authorization: `Bearer ${this.token}`,
        "Notion-Version": API_VERSION,
        "Content-Type": "application/json",
      },
      signal: opts.signal,
    };
    if (opts.body !== undefined) init.body = JSON.stringify(opts.body);

    let lastErr: NotionGatewayError | null = null;
    for (let attempt = 1; attempt <= RETRY_MAX_ATTEMPTS; attempt++) {
      const r = await fetch(`${API}${path}`, init);
      if (r.ok) return (await r.json()) as T;

      const detail = await safeReadText(r);
      const code = mapHttpStatus(r.status);
      lastErr = new NotionGatewayError(
        code,
        `Notion ${method} ${path}: ${r.status} ${detail}`,
      );

      // Retry only on 429 / 5xx. Everything else (401/403/404/400) is a
      // user-actionable error — fail fast.
      const isTransient = r.status === 429 || r.status >= 500;
      if (!isTransient || attempt === RETRY_MAX_ATTEMPTS) throw lastErr;

      const retryAfter = parseRetryAfter(r.headers.get("retry-after"));
      const backoff = retryAfter ?? RETRY_BASE_MS * Math.pow(2, attempt - 1);
      log.warn(
        `api ${method} ${path} ${r.status} — retrying in ${backoff}ms (attempt ${attempt}/${RETRY_MAX_ATTEMPTS})`,
      );
      await sleep(backoff);
    }
    // Unreachable, but keeps TS happy.
    throw lastErr ?? new NotionGatewayError("error", "unknown api failure");
  }
}

async function safeReadText(r: Response): Promise<string> {
  try {
    const txt = await r.text();
    return txt.slice(0, 500);
  } catch {
    return "";
  }
}

function parseRetryAfter(h: string | null): number | null {
  if (!h) return null;
  const n = Number(h);
  if (Number.isFinite(n) && n >= 0) return Math.min(n * 1000, 10_000);
  return null;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ---------------------------------------------------------------------------
// Module-level accessor used by ingest hot path.
//
// Resolves once per token/dbId change. ingest.ts calls getObservationsClient()
// fire-and-forget on every trigger — keep the resolution cheap.
// ---------------------------------------------------------------------------

import { getNotionToken, getBootstrapState } from "../settings";

let cached: {
  client: RealObservationsClient;
  token: string;
  observationsDbId: string;
  workflowsDbId: string;
  runsDbId: string;
  agentPicksDbId: string;
  jobLeadsDbId: string;
} | null = null;

/** Returns null when no token is configured. */
export async function getObservationsClient(): Promise<RealObservationsClient | null> {
  const [token, b] = await Promise.all([getNotionToken(), getBootstrapState()]);
  if (!token) {
    cached = null;
    return null;
  }
  if (
    cached &&
    cached.token === token &&
    cached.observationsDbId === b.observationsDbId &&
    cached.workflowsDbId === b.workflowsDbId &&
    cached.runsDbId === b.runsDbId &&
    cached.agentPicksDbId === b.agentPicksDbId &&
    cached.jobLeadsDbId === b.jobLeadsDbId
  ) {
    return cached.client;
  }
  const client = new RealObservationsClient(
    token,
    b.observationsDbId,
    b.workflowsDbId,
    b.runsDbId,
    b.workspaceName,
    b.agentPicksDbId,
    b.jobLeadsDbId,
  );
  cached = {
    client,
    token,
    observationsDbId: b.observationsDbId,
    workflowsDbId: b.workflowsDbId,
    runsDbId: b.runsDbId,
    agentPicksDbId: b.agentPicksDbId,
    jobLeadsDbId: b.jobLeadsDbId,
  };
  return client;
}

/** Force a re-resolve on next call. Use after token/db-id changes. */
export function resetObservationsClient(): void {
  cached = null;
}

// ---------------------------------------------------------------------------
// Schema + property serialization
// ---------------------------------------------------------------------------

function observationsSchemaPayload(): Record<string, unknown> {
  return {
    Name: { title: {} },
    "Captured At": { date: {} },
    URL: { url: {} },
    "Cluster Key": { rich_text: {} },
    Host: { select: { options: [] } },
    "Trigger Kind": { select: { options: TRIGGER_KIND_OPTIONS.map((o) => ({ ...o })) } },
    "Page Type": { select: { options: [] } },
    "Extracted Data": { rich_text: {} },
    Engagement: { rich_text: {} },
    Confidence: { number: { format: "number" } },
    Status: { select: { options: OBSERVATION_STATUS_OPTIONS.map((o) => ({ ...o })) } },
    "Local Event Id": { rich_text: {} },
    "Workflow Page Id": { rich_text: {} },
  };
}

function workflowsSchemaPayload(): Record<string, unknown> {
  return {
    Name: { title: {} },
    Status: { select: { options: WORKFLOW_STATUS_OPTIONS.map((o) => ({ ...o })) } },
    "Trigger Spec": { rich_text: {} },
    "Source Apps": { multi_select: { options: [] } },
    "Target Database Id": { rich_text: {} },
    "Target Database Name": { rich_text: {} },
    "Extraction Schema": { rich_text: {} },
    "Run Mode": { select: { options: WORKFLOW_RUN_MODE_OPTIONS.map((o) => ({ ...o })) } },
    "Confidence Floor": { number: { format: "number" } },
    Reasoning: { rich_text: {} },
    "Source Candidate Id": { rich_text: {} },
    "Source Local Event Ids": { rich_text: {} },
    "Approved At": { date: {} },
    "Last Triggered": { date: {} },
    "Run Count": { number: { format: "number" } },
  };
}

function runsSchemaPayload(): Record<string, unknown> {
  return {
    Name: { title: {} },
    "Workflow Page Id": { rich_text: {} },
    "Workflow Name": { rich_text: {} },
    "Triggered At": { date: {} },
    "Page URL": { url: {} },
    Status: { select: { options: RUN_STATUS_OPTIONS.map((o) => ({ ...o })) } },
    "User Response": { select: { options: RUN_USER_RESPONSE_OPTIONS.map((o) => ({ ...o })) } },
    "Created Page Id": { rich_text: {} },
    "Created Page Url": { url: {} },
    Extracted: { rich_text: {} },
    Error: { rich_text: {} },
    "Latency Ms": { number: { format: "number" } },
  };
}

function agentPicksSchemaPayload(): Record<string, unknown> {
  return {
    Name: { title: {} },
    "Run ID": { rich_text: {} },
    Query: { rich_text: {} },
    Leads: { rich_text: {} },
    Status: { select: { options: AGENT_PICK_STATUS_OPTIONS.map((o) => ({ ...o })) } },
    "Found At": { date: {} },
  };
}

function jobLeadsSchemaPayload(): Record<string, unknown> {
  return {
    Title: { title: {} },
    Company: { rich_text: {} },
    URL: { url: {} },
    Score: { number: { format: "number" } },
    Source: { select: { options: JOB_LEAD_SOURCE_OPTIONS.map((o) => ({ ...o })) } },
    Status: { select: { options: JOB_LEAD_STATUS_OPTIONS.map((o) => ({ ...o })) } },
    "Found At": { date: {} },
    "Agent Pick Id": { rich_text: {} },
    "Run ID": { rich_text: {} },
  };
}

const TEXT_MAX = 1900; // Notion limit 2000 — leave a safety margin

function observationToProperties(o: ObservationInput): Record<string, unknown> {
  const props: Record<string, unknown> = {
    Name: { title: [{ type: "text", text: { content: clip(o.name || "(observation)", 200) } }] },
    "Captured At": { date: { start: new Date(o.capturedAt).toISOString() } },
    "Cluster Key": rich(o.clusterKey),
    Host: o.host ? { select: { name: clip(o.host, 100) } } : { select: null },
    "Trigger Kind": { select: { name: o.triggerKind } },
    "Local Event Id": rich(o.localEventId),
    Status: { select: { name: "new" } },
  };
  // URL: only set if it's actually a valid http(s) value — Notion rejects others.
  if (/^https?:\/\//i.test(o.url)) {
    props.URL = { url: clip(o.url, TEXT_MAX) };
  }
  if (o.pageType) props["Page Type"] = { select: { name: clip(o.pageType, 100) } };
  if (typeof o.confidence === "number" && Number.isFinite(o.confidence)) {
    props.Confidence = { number: o.confidence };
  }
  if (o.extracted !== undefined) {
    props["Extracted Data"] = rich(safeJson(o.extracted));
  }
  if (o.engagement) props.Engagement = rich(safeJson(o.engagement));
  return props;
}

function rich(value: string): Record<string, unknown> {
  return {
    rich_text: value
      ? [{ type: "text", text: { content: clip(value, TEXT_MAX) } }]
      : [],
  };
}

function clip(s: string, n: number): string {
  if (!s) return "";
  return s.length <= n ? s : s.slice(0, n - 1) + "…";
}

function safeJson(v: unknown): string {
  try {
    return JSON.stringify(v);
  } catch {
    return String(v);
  }
}

// ---------------------------------------------------------------------------
// Notion REST response shapes (minimal — only fields we read)
// ---------------------------------------------------------------------------

interface NotionUser {
  id: string;
  name?: string;
  bot?: { workspace_name?: string };
}

interface NotionSearchResponse {
  results: NotionSearchResult[];
}

interface NotionQueryResponse {
  results: NotionPageRaw[];
}

interface NotionSearchResult {
  object: "page" | "database";
  id: string;
  url?: string;
  last_edited_time?: string;
  parent?: { type: string; page_id?: string; database_id?: string; workspace?: true };
  properties?: Record<string, NotionPropertyRaw>;
  title?: NotionRichTextRaw[];
}

interface NotionPropertyRaw {
  type: string;
  title?: NotionRichTextRaw[];
  rich_text?: NotionRichTextRaw[];
}

interface NotionRichTextRaw {
  plain_text?: string;
  type?: string;
}

interface NotionDatabaseRaw {
  id: string;
  url?: string;
}

interface NotionPageRaw {
  id: string;
  url?: string;
  /** ISO timestamp when the row was created. Used as a fallback ordering field. */
  created_time?: string;
  properties?: Record<string, NotionRowPropRaw>;
}

/** Property shapes we read off DB rows. Only the fields we use. */
interface NotionRowPropRaw {
  type: string;
  title?: NotionRichTextRaw[];
  rich_text?: NotionRichTextRaw[];
  url?: string | null;
  date?: { start?: string | null } | null;
  select?: { name?: string } | null;
  multi_select?: { name?: string }[];
  number?: number | null;
}

/** Full database fetch shape — for getDatabaseSchema(). */
interface NotionDatabaseFullRaw {
  id: string;
  url?: string;
  title?: NotionRichTextRaw[];
  properties?: Record<string, NotionDatabasePropRaw>;
}

/** Per-property schema entry on a database fetch. */
interface NotionDatabasePropRaw {
  id?: string;
  name?: string;
  type: string;
  select?: { options?: { name: string }[] };
  multi_select?: { options?: { name: string }[] };
}

function rowToRecent(row: NotionPageRaw): RecentObservation {
  const p = row.properties ?? {};
  const name = readTitle(p.Name) || "(observation)";
  const sourceUrl = readUrl(p.URL);
  const capturedAt = readDate(p["Captured At"]);
  const host = readSelect(p.Host);
  const triggerKind = readSelect(p["Trigger Kind"]);
  const pageType = readSelect(p["Page Type"]);
  const status = readSelect(p.Status);
  const confidence = readNumber(p.Confidence);
  return {
    id: row.id,
    url: row.url ?? "",
    name,
    capturedAt,
    host,
    triggerKind,
    pageType,
    sourceUrl,
    confidence,
    status,
  };
}

function readTitle(p: NotionRowPropRaw | undefined): string {
  if (!p?.title) return "";
  return p.title.map((t) => t.plain_text ?? "").join("");
}

function readUrl(p: NotionRowPropRaw | undefined): string {
  return typeof p?.url === "string" ? p.url : "";
}

function readDate(p: NotionRowPropRaw | undefined): number {
  const s = p?.date?.start;
  if (!s) return 0;
  const t = Date.parse(s);
  return Number.isFinite(t) ? t : 0;
}

function readSelect(p: NotionRowPropRaw | undefined): string {
  return p?.select?.name ?? "";
}

function readNumber(p: NotionRowPropRaw | undefined): number | null {
  const v = p?.number;
  return typeof v === "number" && Number.isFinite(v) ? v : null;
}

/**
 * Collapse any supported row-property value into a short human-readable
 * string for the judge prompt. Empty/unsupported → "".
 *
 * We TRUNCATE — DB samples in the prompt are signal, not full row dumps.
 */
function formatRowPropValue(p: NotionRowPropRaw | undefined): string {
  if (!p) return "";
  switch (p.type) {
    case "title": {
      const s = readTitle(p);
      return s ? truncate(s, 120) : "";
    }
    case "rich_text": {
      const s = (p.rich_text ?? []).map((t) => t.plain_text ?? "").join("");
      return s ? truncate(s, 120) : "";
    }
    case "url":
      return truncate(readUrl(p), 200);
    case "select":
      return readSelect(p);
    case "multi_select":
      return (p.multi_select ?? []).map((o) => o?.name ?? "").filter(Boolean).join(", ");
    case "date": {
      const t = readDate(p);
      return t ? new Date(t).toISOString().slice(0, 10) : "";
    }
    case "number": {
      const n = readNumber(p);
      return n == null ? "" : String(n);
    }
    default:
      return "";
  }
}

function truncate(s: string, max: number): string {
  return s.length <= max ? s : s.slice(0, max - 1) + "…";
}

function extractPageTitle(r: NotionSearchResult): string {
  if (r.properties) {
    for (const p of Object.values(r.properties)) {
      if (p.type === "title" && p.title) return p.title.map((t) => t.plain_text ?? "").join("");
    }
  }
  return "";
}

function extractDatabaseTitle(r: NotionSearchResult): string {
  if (r.title) return r.title.map((t) => t.plain_text ?? "").join("");
  return "";
}

function normId(id: string): string {
  return id.replace(/-/g, "").toLowerCase();
}

function mapHttpStatus(s: number): string {
  if (s === 401) return "unauthorized";
  if (s === 403) return "forbidden";
  if (s === 404) return "not_found";
  if (s === 429) return "rate_limited";
  if (s >= 500) return "server_error";
  if (s >= 400) return "bad_request";
  return "error";
}

// ---------------------------------------------------------------------------
// Property serialization for destination DBs (apply flow)
//
// `specsToNotionSchema`  converts NotionPropertySpec[] (proposal shape) into
// the body shape expected by POST /v1/databases.
// `valuesToNotionProperties`  converts the coerced row values into the body
// shape expected by POST /v1/pages.
// `parsePropertiesSchema`  parses GET /v1/databases/{id} back into specs.
// ---------------------------------------------------------------------------

function specsToNotionSchema(specs: NotionPropertySpec[]): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  let hasTitle = false;
  for (const spec of specs) {
    switch (spec.type) {
      case "title":
        out[spec.name] = { title: {} };
        hasTitle = true;
        break;
      case "rich_text":
        out[spec.name] = { rich_text: {} };
        break;
      case "url":
        out[spec.name] = { url: {} };
        break;
      case "date":
        out[spec.name] = { date: {} };
        break;
      case "number":
        out[spec.name] = { number: { format: "number" } };
        break;
      case "select":
        out[spec.name] = {
          select: { options: spec.options.map((name) => ({ name: clip(name, 100) })) },
        };
        break;
      case "multi_select":
        out[spec.name] = {
          multi_select: {
            options: spec.options.map((name) => ({ name: clip(name, 100) })),
          },
        };
        break;
    }
  }
  // Notion requires exactly one title column. If the spec omitted it, inject one.
  if (!hasTitle) out["Name"] = { title: {} };
  return out;
}

function valuesToNotionProperties(
  values: Record<string, NotionPropertyValue>,
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [name, v] of Object.entries(values)) {
    switch (v.type) {
      case "title":
        out[name] = {
          title: [{ type: "text", text: { content: clip(v.value, TEXT_MAX) } }],
        };
        break;
      case "rich_text":
        out[name] = v.value
          ? {
              rich_text: [
                { type: "text", text: { content: clip(v.value, TEXT_MAX) } },
              ],
            }
          : { rich_text: [] };
        break;
      case "url":
        // Notion rejects non-http urls. Already validated by coerce, but
        // double-guard.
        out[name] = /^https?:\/\//i.test(v.value)
          ? { url: clip(v.value, TEXT_MAX) }
          : { url: null };
        break;
      case "date":
        out[name] = { date: { start: v.value } };
        break;
      case "select":
        out[name] = v.value ? { select: { name: clip(v.value, 100) } } : { select: null };
        break;
      case "multi_select":
        out[name] = {
          multi_select: v.value.map((s) => ({ name: clip(s, 100) })),
        };
        break;
      case "number":
        out[name] = Number.isFinite(v.value) ? { number: v.value } : { number: null };
        break;
    }
  }
  return out;
}

function parsePropertiesSchema(
  raw: Record<string, NotionDatabasePropRaw>,
): NotionPropertySpec[] {
  const supported = new Set([
    "title",
    "rich_text",
    "url",
    "date",
    "number",
    "select",
    "multi_select",
  ]);
  const out: NotionPropertySpec[] = [];
  for (const [name, p] of Object.entries(raw)) {
    if (!supported.has(p.type)) continue;
    const options =
      p.type === "select"
        ? (p.select?.options ?? []).map((o) => o.name)
        : p.type === "multi_select"
          ? (p.multi_select?.options ?? []).map((o) => o.name)
          : [];
    out.push({ name, type: p.type as NotionPropertySpec["type"], options });
  }
  return out;
}

function extractDatabaseTitleFull(raw: NotionDatabaseFullRaw): string {
  if (raw.title) return raw.title.map((t) => t.plain_text ?? "").join("");
  return "";
}

// ---------------------------------------------------------------------------
// Workflows + Runs writers & readers
// ---------------------------------------------------------------------------

function workflowToProperties(w: WorkflowInput): Record<string, unknown> {
  // A workflow row is only ever created at the moment its first run
  // succeeds (see apply.ts step 4) — so Run Count starts at 1 and
  // Last Triggered mirrors Approved At. Subsequent runs against the same
  // (name, target_db) bump the existing row via incrementWorkflowRun
  // rather than inserting a duplicate.
  return {
    Name: { title: [{ type: "text", text: { content: clip(w.name || "(workflow)", 200) } }] },
    Status: { select: { name: w.status } },
    "Trigger Spec": rich(safeJson(w.triggerSpec)),
    "Source Apps": {
      multi_select: w.sourceApps.slice(0, 20).map((s) => ({ name: clip(s, 100) })),
    },
    "Target Database Id": rich(w.targetDatabaseId),
    "Target Database Name": rich(w.targetDatabaseName),
    "Extraction Schema": rich(safeJson(w.extractionSchema)),
    "Run Mode": { select: { name: w.runMode } },
    "Confidence Floor": Number.isFinite(w.confidenceFloor)
      ? { number: w.confidenceFloor }
      : { number: null },
    Reasoning: rich(w.reasoning),
    "Source Candidate Id": rich(w.sourceCandidateId),
    "Source Local Event Ids": rich(w.sourceLocalEventIds.slice(0, 50).join(",")),
    "Approved At": { date: { start: new Date(w.approvedAt).toISOString() } },
    "Last Triggered": { date: { start: new Date(w.approvedAt).toISOString() } },
    "Run Count": { number: 1 },
  };
}

function runToProperties(r: RunInput): Record<string, unknown> {
  const name = `${r.workflowName || "(workflow)"} · ${new Date(r.triggeredAt).toISOString()}`;
  const props: Record<string, unknown> = {
    Name: { title: [{ type: "text", text: { content: clip(name, 200) } }] },
    "Workflow Page Id": rich(r.workflowPageId),
    "Workflow Name": rich(r.workflowName),
    "Triggered At": { date: { start: new Date(r.triggeredAt).toISOString() } },
    Status: { select: { name: r.status } },
    "User Response": { select: { name: r.userResponse } },
    "Created Page Id": rich(r.createdPageId),
    Extracted: rich(safeJson(r.extracted)),
    Error: rich(r.error),
    "Latency Ms": Number.isFinite(r.latencyMs) ? { number: r.latencyMs } : { number: null },
  };
  if (/^https?:\/\//i.test(r.pageUrl)) props["Page URL"] = { url: clip(r.pageUrl, TEXT_MAX) };
  if (/^https?:\/\//i.test(r.createdPageUrl))
    props["Created Page Url"] = { url: clip(r.createdPageUrl, TEXT_MAX) };
  return props;
}

function rowToWorkflow(row: NotionPageRaw): RecentWorkflow {
  const p = row.properties ?? {};
  return {
    id: row.id,
    url: row.url ?? "",
    name: readTitle(p.Name) || "(workflow)",
    status: readSelect(p.Status),
    runMode: readSelect(p["Run Mode"]),
    targetDatabaseId: readRichText(p["Target Database Id"]),
    targetDatabaseName: readRichText(p["Target Database Name"]),
    sourceApps: readMultiSelect(p["Source Apps"]),
    reasoning: readRichText(p.Reasoning),
    approvedAt: readDate(p["Approved At"]),
    lastTriggered: readDate(p["Last Triggered"]),
    runCount: readNumber(p["Run Count"]) ?? 0,
  };
}

function rowToRun(row: NotionPageRaw): RecentRun {
  const p = row.properties ?? {};
  return {
    id: row.id,
    url: row.url ?? "",
    name: readTitle(p.Name) || "(run)",
    status: readSelect(p.Status),
    userResponse: readSelect(p["User Response"]),
    workflowName: readRichText(p["Workflow Name"]),
    workflowPageId: readRichText(p["Workflow Page Id"]),
    pageUrl: readUrl(p["Page URL"]),
    createdPageUrl: readUrl(p["Created Page Url"]),
    triggeredAt: readDate(p["Triggered At"]),
    latencyMs: readNumber(p["Latency Ms"]),
    error: readRichText(p.Error),
  };
}

function jobLeadToProperties(j: JobLeadInput): Record<string, unknown> {
  const props: Record<string, unknown> = {
    Title: {
      title: [{ type: "text", text: { content: clip(j.title || "(lead)", 200) } }],
    },
    Company: rich(j.company || ""),
    Source: { select: { name: j.source } },
    Status: { select: { name: "new" } },
    "Found At": { date: { start: new Date(j.foundAt).toISOString() } },
  };
  if (/^https?:\/\//i.test(j.url)) {
    props.URL = { url: clip(j.url, TEXT_MAX) };
  }
  if (Number.isFinite(j.score)) {
    props.Score = { number: j.score };
  }
  if (j.agentPickId) props["Agent Pick Id"] = rich(j.agentPickId);
  if (j.runId) props["Run ID"] = rich(j.runId);
  return props;
}

function rowToJobLead(row: NotionPageRaw): RecentJobLead {
  const p = row.properties ?? {};
  return {
    id: row.id,
    url: row.url ?? "",
    title: readTitle(p.Title) || "(lead)",
    company: readRichText(p.Company),
    sourceUrl: readUrl(p.URL),
    score: readNumber(p.Score) ?? 0,
    source: readSelect(p.Source),
    status: readSelect(p.Status),
    foundAt: readDate(p["Found At"]),
  };
}

function rowToAgentPick(row: NotionPageRaw): AgentPickRow {
  const p = row.properties ?? {};
  const leadsJson = readRichText(p.Leads);
  let leads: AgentLead[] = [];
  if (leadsJson) {
    try {
      const parsed = JSON.parse(leadsJson);
      const arr = Array.isArray(parsed)
        ? parsed
        : Array.isArray(parsed?.leads)
          ? parsed.leads
          : [];
      leads = arr
        .map((x: unknown) => coerceAgentLead(x))
        .filter((x: AgentLead | null): x is AgentLead => x !== null);
    } catch (e) {
      log.warn("rowToAgentPick: leads JSON parse failed", (e as Error).message);
    }
  }
  return {
    id: row.id,
    url: row.url ?? "",
    runId: readRichText(p["Run ID"]),
    status: readSelect(p.Status),
    query: readRichText(p.Query),
    leads,
    createdAt: readDateIso(p["Found At"]) || row.created_time || "",
  };
}

function coerceAgentLead(v: unknown): AgentLead | null {
  if (!v || typeof v !== "object") return null;
  const o = v as Record<string, unknown>;
  const url = typeof o.url === "string" ? o.url : "";
  if (!/^https?:\/\//i.test(url)) return null;
  return {
    title: typeof o.title === "string" ? o.title : "",
    company: typeof o.company === "string" ? o.company : "",
    url,
    score: typeof o.score === "number" ? o.score : 0,
  };
}

function readDateIso(p: NotionRowPropRaw | undefined): string {
  return p?.date?.start ?? "";
}

function readRichText(p: NotionRowPropRaw | undefined): string {
  if (!p?.rich_text) return "";
  return p.rich_text.map((t) => t.plain_text ?? "").join("");
}

function readMultiSelect(p: NotionRowPropRaw | undefined): string[] {
  if (!p?.multi_select) return [];
  return p.multi_select.map((o) => o.name ?? "").filter(Boolean);
}
