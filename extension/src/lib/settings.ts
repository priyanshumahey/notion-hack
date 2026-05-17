// Typed wrapper over chrome.storage.local for app settings.
//
// Resolution order for the OpenAI key when callers ask `getOpenAiKey()`:
//   1. chrome.storage.local.openaiKey (set via Settings UI) — wins
//   2. __OPENAI_KEY_BUILD__ injected by Vite from `.env` at build time
//   3. "" — features that require a key must refuse to run
//
// Same resolution order applies to the Notion token + bootstrap state
// (workspace name, parent page, DB ids). Build-time defaults let a freshly
// installed unpacked extension run without re-entering everything; the user
// can still override any field via the Settings UI and storage wins.

const KEYS = {
  openaiKey: "openaiKey",
  notionToken: "notionToken",
  notionWorkspaceName: "notionWorkspaceName",
  notionParentPageId: "notionParentPageId",
  notionParentPageTitle: "notionParentPageTitle",
  notionObservationsDbId: "notionObservationsDbId",
  notionWorkflowsDbId: "notionWorkflowsDbId",
  notionRunsDbId: "notionRunsDbId",
  notionAgentPicksDbId: "notionAgentPicksDbId",
  notionJobLeadsDbId: "notionJobLeadsDbId",
  autoApply: "autoApply",
  exaKey: "exaKey",
  tracerTriggerUrl: "tracerTriggerUrl",
  tracerIngestSecret: "tracerIngestSecret",
} as const;

export interface Settings {
  openaiKey: string;
}

export interface NotionConnection {
  /** True iff a token is stored. */
  hasToken: boolean;
  /** True iff token + parent page + ALL three DBs (observations, workflows, runs) are set. */
  bootstrapped: boolean;
  workspaceName: string;
  parentPageId: string;
  parentPageTitle: string;
  observationsDbId: string;
  workflowsDbId: string;
  runsDbId: string;
  /** Set only after the job-agent feature has provisioned its DBs. */
  agentPicksDbId: string;
  jobLeadsDbId: string;
  /** Token redacted for display. */
  redactedToken: string;
}

/** Build-time fallback (from extension/.env via vite define). May be ""; never throws. */
function buildKey(): string {
  try {
    return typeof __OPENAI_KEY_BUILD__ === "string" ? __OPENAI_KEY_BUILD__ : "";
  } catch {
    return "";
  }
}

/** Build-time fallback for the Notion integration token. May be "". */
function buildNotionToken(): string {
  try {
    return typeof __NOTION_TOKEN_BUILD__ === "string" ? __NOTION_TOKEN_BUILD__ : "";
  } catch {
    return "";
  }
}

/** Build-time fallback for the parent + workspace + DB ids. Any field may be "". */
function buildNotionBootstrap(): BootstrapState {
  const safe = (v: unknown): string => (typeof v === "string" ? v : "");
  try {
    return {
      workspaceName: safe(__NOTION_WORKSPACE_NAME_BUILD__),
      parentPageId: safe(__NOTION_PARENT_PAGE_ID_BUILD__),
      parentPageTitle: safe(__NOTION_PARENT_PAGE_TITLE_BUILD__),
      observationsDbId: safe(__NOTION_OBSERVATIONS_DB_ID_BUILD__),
      workflowsDbId: safe(__NOTION_WORKFLOWS_DB_ID_BUILD__),
      runsDbId: safe(__NOTION_RUNS_DB_ID_BUILD__),
      agentPicksDbId: "",
      jobLeadsDbId: "",
    };
  } catch {
    return {
      workspaceName: "",
      parentPageId: "",
      parentPageTitle: "",
      observationsDbId: "",
      workflowsDbId: "",
      runsDbId: "",
      agentPicksDbId: "",
      jobLeadsDbId: "",
    };
  }
}

/** Build-time fallback for the Exa search API key. May be "". */
function buildExaKey(): string {
  try {
    return typeof __EXA_KEY_BUILD__ === "string" ? __EXA_KEY_BUILD__ : "";
  } catch {
    return "";
  }
}

/** Build-time fallback for the tracer worker's triggerFunction webhook URL. */
function buildTracerTriggerUrl(): string {
  try {
    return typeof __TRACER_TRIGGER_URL_BUILD__ === "string"
      ? __TRACER_TRIGGER_URL_BUILD__
      : "";
  } catch {
    return "";
  }
}

/** Build-time fallback for the tracer ingest HMAC secret. */
function buildTracerIngestSecret(): string {
  try {
    return typeof __TRACER_INGEST_SECRET_BUILD__ === "string"
      ? __TRACER_INGEST_SECRET_BUILD__
      : "";
  } catch {
    return "";
  }
}

export async function getOpenAiKey(): Promise<string> {
  const r = await chrome.storage.local.get([KEYS.openaiKey]);
  const stored = (r[KEYS.openaiKey] as string | undefined) ?? "";
  return stored || buildKey();
}

export async function setOpenAiKey(key: string): Promise<void> {
  const trimmed = key.trim();
  if (trimmed) {
    await chrome.storage.local.set({ [KEYS.openaiKey]: trimmed });
  } else {
    await chrome.storage.local.remove([KEYS.openaiKey]);
  }
}

/** True iff there's any usable key (stored OR build-time). */
export async function hasOpenAiKey(): Promise<boolean> {
  return (await getOpenAiKey()).length > 0;
}

/** Tells the caller WHERE the active key came from, for the Settings UI. */
export async function describeKeySource(): Promise<"stored" | "build" | "none"> {
  const r = await chrome.storage.local.get([KEYS.openaiKey]);
  const stored = (r[KEYS.openaiKey] as string | undefined) ?? "";
  if (stored) return "stored";
  if (buildKey()) return "build";
  return "none";
}

/** Show only last 4 chars; never log full keys. */
export function redactKey(key: string): string {
  if (!key) return "";
  if (key.length <= 8) return "•".repeat(key.length);
  return `${key.slice(0, 3)}…${key.slice(-4)}`;
}

// ---------------------------------------------------------------------------
// Notion integration settings
// ---------------------------------------------------------------------------

export async function getNotionToken(): Promise<string> {
  const r = await chrome.storage.local.get([KEYS.notionToken]);
  const stored = (r[KEYS.notionToken] as string | undefined) ?? "";
  return stored || buildNotionToken();
}

export async function setNotionToken(token: string): Promise<void> {
  const trimmed = token.trim();
  if (trimmed) {
    await chrome.storage.local.set({ [KEYS.notionToken]: trimmed });
  } else {
    await chrome.storage.local.remove([KEYS.notionToken]);
  }
}

export async function hasNotionToken(): Promise<boolean> {
  return (await getNotionToken()).length > 0;
}

/** Tells the caller WHERE the active Notion token came from, for the Settings UI. */
export async function describeNotionTokenSource(): Promise<"stored" | "build" | "none"> {
  const r = await chrome.storage.local.get([KEYS.notionToken]);
  const stored = (r[KEYS.notionToken] as string | undefined) ?? "";
  if (stored) return "stored";
  if (buildNotionToken()) return "build";
  return "none";
}

export interface BootstrapState {
  workspaceName: string;
  parentPageId: string;
  parentPageTitle: string;
  observationsDbId: string;
  workflowsDbId: string;
  runsDbId: string;
  /** Job-agent inbox DB. Empty until the user runs the agent at least once. */
  agentPicksDbId: string;
  /** Curated Job Leads DB. Empty until first agent run. */
  jobLeadsDbId: string;
}

export async function getBootstrapState(): Promise<BootstrapState> {
  const r = await chrome.storage.local.get([
    KEYS.notionWorkspaceName,
    KEYS.notionParentPageId,
    KEYS.notionParentPageTitle,
    KEYS.notionObservationsDbId,
    KEYS.notionWorkflowsDbId,
    KEYS.notionRunsDbId,
    KEYS.notionAgentPicksDbId,
    KEYS.notionJobLeadsDbId,
  ]);
  const fb = buildNotionBootstrap();
  // Per-field fallback: a user can override just one field via the UI
  // (e.g. pick a different parent page) without losing the others.
  return {
    workspaceName:
      ((r[KEYS.notionWorkspaceName] as string | undefined) ?? "") || fb.workspaceName,
    parentPageId:
      ((r[KEYS.notionParentPageId] as string | undefined) ?? "") || fb.parentPageId,
    parentPageTitle:
      ((r[KEYS.notionParentPageTitle] as string | undefined) ?? "") || fb.parentPageTitle,
    observationsDbId:
      ((r[KEYS.notionObservationsDbId] as string | undefined) ?? "") ||
      fb.observationsDbId,
    workflowsDbId:
      ((r[KEYS.notionWorkflowsDbId] as string | undefined) ?? "") || fb.workflowsDbId,
    runsDbId: ((r[KEYS.notionRunsDbId] as string | undefined) ?? "") || fb.runsDbId,
    agentPicksDbId:
      ((r[KEYS.notionAgentPicksDbId] as string | undefined) ?? "") || fb.agentPicksDbId,
    jobLeadsDbId:
      ((r[KEYS.notionJobLeadsDbId] as string | undefined) ?? "") || fb.jobLeadsDbId,
  };
}

export async function setBootstrapState(s: Partial<BootstrapState>): Promise<void> {
  const patch: Record<string, string> = {};
  if (s.workspaceName !== undefined) patch[KEYS.notionWorkspaceName] = s.workspaceName;
  if (s.parentPageId !== undefined) patch[KEYS.notionParentPageId] = s.parentPageId;
  if (s.parentPageTitle !== undefined) patch[KEYS.notionParentPageTitle] = s.parentPageTitle;
  if (s.observationsDbId !== undefined)
    patch[KEYS.notionObservationsDbId] = s.observationsDbId;
  if (s.workflowsDbId !== undefined) patch[KEYS.notionWorkflowsDbId] = s.workflowsDbId;
  if (s.runsDbId !== undefined) patch[KEYS.notionRunsDbId] = s.runsDbId;
  if (s.agentPicksDbId !== undefined)
    patch[KEYS.notionAgentPicksDbId] = s.agentPicksDbId;
  if (s.jobLeadsDbId !== undefined) patch[KEYS.notionJobLeadsDbId] = s.jobLeadsDbId;
  if (Object.keys(patch).length) await chrome.storage.local.set(patch);
}

/** Wipe token + bootstrap state. The Notion DB itself is left intact. */
export async function clearNotionConnection(): Promise<void> {
  await chrome.storage.local.remove([
    KEYS.notionToken,
    KEYS.notionWorkspaceName,
    KEYS.notionParentPageId,
    KEYS.notionParentPageTitle,
    KEYS.notionObservationsDbId,
    KEYS.notionWorkflowsDbId,
    KEYS.notionRunsDbId,
    KEYS.notionAgentPicksDbId,
    KEYS.notionJobLeadsDbId,
  ]);
}

export async function getNotionConnection(): Promise<NotionConnection> {
  const [token, b] = await Promise.all([getNotionToken(), getBootstrapState()]);
  return {
    hasToken: !!token,
    bootstrapped: !!(
      token &&
      b.parentPageId &&
      b.observationsDbId &&
      b.workflowsDbId &&
      b.runsDbId
    ),
    workspaceName: b.workspaceName,
    parentPageId: b.parentPageId,
    parentPageTitle: b.parentPageTitle,
    observationsDbId: b.observationsDbId,
    workflowsDbId: b.workflowsDbId,
    runsDbId: b.runsDbId,
    agentPicksDbId: b.agentPicksDbId,
    jobLeadsDbId: b.jobLeadsDbId,
    redactedToken: redactKey(token),
  };
}

/** Phase-1 kill switch: features that talk to OpenAI must also require Notion connected. */
export async function isFullyConnected(): Promise<boolean> {
  const [hasKey, conn] = await Promise.all([hasOpenAiKey(), getNotionConnection()]);
  return hasKey && conn.bootstrapped;
}

// ---------------------------------------------------------------------------
// Auto-apply preference
//
// When OFF (default): the judge still produces candidates, but nothing
// writes to Notion automatically — the user must approve each candidate
// from the Completions tab. A chrome notification fires for each new
// meaningful candidate so the user knows to review.
//
// When ON: candidates whose proposed DB has been previously approved get
// applied silently (the "standing approval" path).
// ---------------------------------------------------------------------------

export async function getAutoApplyEnabled(): Promise<boolean> {
  const r = await chrome.storage.local.get([KEYS.autoApply]);
  return r[KEYS.autoApply] === true;
}

export async function setAutoApplyEnabled(enabled: boolean): Promise<void> {
  if (enabled) {
    await chrome.storage.local.set({ [KEYS.autoApply]: true });
  } else {
    await chrome.storage.local.remove([KEYS.autoApply]);
  }
}

// ---------------------------------------------------------------------------
// Job-agent integration: Exa search + tracer-worker triggerFunction webhook.
// All three values follow the same resolution rule as the OpenAI key:
// chrome.storage.local wins; otherwise fall back to the value baked at build
// time from `extension/.env`.
// ---------------------------------------------------------------------------

export async function getExaKey(): Promise<string> {
  const r = await chrome.storage.local.get([KEYS.exaKey]);
  const stored = (r[KEYS.exaKey] as string | undefined) ?? "";
  return stored || buildExaKey();
}

export async function setExaKey(key: string): Promise<void> {
  const trimmed = key.trim();
  if (trimmed) {
    await chrome.storage.local.set({ [KEYS.exaKey]: trimmed });
  } else {
    await chrome.storage.local.remove([KEYS.exaKey]);
  }
}

export async function getTracerTriggerUrl(): Promise<string> {
  const r = await chrome.storage.local.get([KEYS.tracerTriggerUrl]);
  const stored = (r[KEYS.tracerTriggerUrl] as string | undefined) ?? "";
  return stored || buildTracerTriggerUrl();
}

export async function setTracerTriggerUrl(url: string): Promise<void> {
  const trimmed = url.trim();
  if (trimmed) {
    await chrome.storage.local.set({ [KEYS.tracerTriggerUrl]: trimmed });
  } else {
    await chrome.storage.local.remove([KEYS.tracerTriggerUrl]);
  }
}

export async function getTracerIngestSecret(): Promise<string> {
  const r = await chrome.storage.local.get([KEYS.tracerIngestSecret]);
  const stored = (r[KEYS.tracerIngestSecret] as string | undefined) ?? "";
  return stored || buildTracerIngestSecret();
}

export async function setTracerIngestSecret(secret: string): Promise<void> {
  const trimmed = secret.trim();
  if (trimmed) {
    await chrome.storage.local.set({ [KEYS.tracerIngestSecret]: trimmed });
  } else {
    await chrome.storage.local.remove([KEYS.tracerIngestSecret]);
  }
}

/** True iff EVERY value needed to run the job agent end-to-end is present. */
export async function isJobAgentReady(): Promise<boolean> {
  const [exa, url, secret, notion, b] = await Promise.all([
    getExaKey(),
    getTracerTriggerUrl(),
    getTracerIngestSecret(),
    getNotionToken(),
    getBootstrapState(),
  ]);
  return !!(
    exa &&
    url &&
    secret &&
    notion &&
    b.parentPageId &&
    b.agentPicksDbId &&
    b.jobLeadsDbId
  );
}
