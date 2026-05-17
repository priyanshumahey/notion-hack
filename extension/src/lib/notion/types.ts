// Notion gateway interface — the abstraction the rest of the codebase talks to.
//
// Two impls planned:
//   - MockNotionGateway   (this milestone) — backed by IndexedDB
//   - RealNotionGateway   (later)         — backed by api.notion.com
//
// Keep the interface tight: every method here will need to be implemented
// against real Notion. If you're tempted to add a mock-only convenience,
// don't.
//
// NB: Phase-1 observation traffic to real Notion does NOT go through this
// interface — see notion/observations.ts (ObservationsClient). The apply
// pipeline still uses NotionGateway against the mock IDB workspace.

import type { CompletionCandidate, NotionPropertySpec } from "../types";

/** Stored database record. */
export interface NotionDatabase {
  id: string;
  name: string;
  description: string;
  properties: NotionPropertySpec[];
  createdAt: number;
  updatedAt: number;
  /** Local denormalized count; bumped on createPage. Eventually consistent. */
  rowCount: number;
  workspace: "mock" | "notion";
}

/** Stored page (row) record. */
export interface NotionPage {
  id: string;
  databaseId: string;
  /** mock://… for mock, https://notion.so/… for real. */
  url: string;
  /** Keyed by property name (matches schema). */
  properties: Record<string, NotionPropertyValue>;
  createdAt: number;
  updatedAt: number;
  /** Back-reference to the CompletionCandidate that produced this page. */
  sourceCandidateId?: string;
}

/** Strongly-typed property value. Mirrors NotionPropertyType. */
export type NotionPropertyValue =
  | { type: "title";        value: string }
  | { type: "rich_text";    value: string }
  | { type: "url";          value: string }
  | { type: "date";         value: string }   // ISO 8601
  | { type: "select";       value: string }
  | { type: "multi_select"; value: string[] }
  | { type: "number";       value: number };

export interface CreateDatabaseInput {
  name: string;
  description: string;
  properties: NotionPropertySpec[];
}

export interface CreatePageInput {
  databaseId: string;
  properties: Record<string, NotionPropertyValue>;
  sourceCandidateId?: string;
}

export interface NotionGateway {
  kind(): "mock" | "notion";
  workspaceLabel(): string;

  // Databases
  createDatabase(input: CreateDatabaseInput): Promise<NotionDatabase>;
  getDatabase(id: string): Promise<NotionDatabase | null>;
  listDatabases(): Promise<NotionDatabase[]>;

  // Pages
  createPage(input: CreatePageInput): Promise<NotionPage>;
  listPages(databaseId: string, limit: number): Promise<NotionPage[]>;
  /** Exact match on string or array-membership. Used for dedup. */
  findPageByProperty(
    databaseId: string,
    propertyName: string,
    value: string,
  ): Promise<NotionPage | null>;

  // Admin
  clearAll(): Promise<void>;
}

// ---------------------------------------------------------------------------
// Phase-1 real-Notion surface (observations only)
//
// ObservationsClient lives in notion/observations.ts. The factory returns null
// when no token is configured. We keep this disjoint from NotionGateway so the
// apply pipeline can keep targeting the mock IDB while real-Notion observation
// writes happen in parallel.
// ---------------------------------------------------------------------------

export interface WhoAmI {
  /** Friendly name to show in Settings. */
  workspaceName: string;
  /** Bot user id (for diagnostics). */
  botUserId: string;
}

export interface ParentPageHit {
  id: string;
  title: string;
  /** notion.so URL if available. */
  url: string;
  /** Last edited iso string. */
  lastEditedAt?: string;
}

export interface ObservationInput {
  /** Short label rendered as the page title. */
  name: string;
  capturedAt: number;
  url: string;
  clusterKey: string;
  host: string;
  triggerKind: CompletionCandidate["reason"];
  pageType?: string;
  /** Best local guess at extracted JSON. May be empty. */
  extracted?: unknown;
  engagement?: {
    foregroundMs?: number;
    scrollPct?: number;
    interactions?: number;
  };
  /** 0..1 local heuristic. */
  confidence?: number;
  /** Cross-ref to the IDB AppEvent that triggered this observation. */
  localEventId: string;
}

export interface ObservationRecord {
  id: string;
  url: string;
}

/** Read-side shape used by the popup "Observations" tab. Subset of the row
 *  schema — we don't need engagement/extracted blobs at list time. */
export interface RecentObservation {
  id: string;
  url: string;
  name: string;
  /** ms epoch parsed from the row's "Captured At" date prop. */
  capturedAt: number;
  host: string;
  triggerKind: string;
  pageType: string;
  /** The original page URL from the row's URL prop (not the Notion page url). */
  sourceUrl: string;
  confidence: number | null;
  status: string;
}

// ---------------------------------------------------------------------------
// Workflows — write & read shapes
// ---------------------------------------------------------------------------

export interface WorkflowInput {
  name: string;
  status: "proposed" | "active" | "paused" | "archived";
  /** JSON-serializable trigger spec — stored as rich_text. */
  triggerSpec: unknown;
  /** Hosts (multi_select). */
  sourceApps: string[];
  targetDatabaseId: string;
  targetDatabaseName: string;
  /** JSON-serializable per-property extraction spec — stored as rich_text. */
  extractionSchema: unknown;
  runMode: "ask-each-time" | "auto-after-N" | "auto";
  confidenceFloor: number;
  reasoning: string;
  sourceCandidateId: string;
  sourceLocalEventIds: string[];
  approvedAt: number;
}

export interface WorkflowRecord {
  id: string;
  url: string;
}

export interface RecentWorkflow {
  id: string;
  url: string;
  name: string;
  status: string;
  runMode: string;
  targetDatabaseId: string;
  targetDatabaseName: string;
  sourceApps: string[];
  reasoning: string;
  approvedAt: number;
  lastTriggered: number;
  runCount: number;
}

// ---------------------------------------------------------------------------
// Runs — write & read shapes
// ---------------------------------------------------------------------------

export interface RunInput {
  workflowPageId: string;
  workflowName: string;
  triggeredAt: number;
  pageUrl: string;
  status: "proposed" | "confirmed" | "auto" | "dismissed" | "failed" | "skipped";
  userResponse: "yes" | "no" | "no-ask-again" | "n/a";
  createdPageId: string;
  createdPageUrl: string;
  /** JSON-serializable; stored as rich_text. */
  extracted: unknown;
  error: string;
  latencyMs: number;
}

export interface RunRecord {
  id: string;
  url: string;
}

export interface RecentRun {
  id: string;
  url: string;
  name: string;
  status: string;
  userResponse: string;
  workflowName: string;
  workflowPageId: string;
  pageUrl: string;
  createdPageUrl: string;
  triggeredAt: number;
  latencyMs: number | null;
  error: string;
}

export interface ObservationsClient {
  workspaceName(): string;
  whoAmI(): Promise<WhoAmI>;
  searchParentPages(query: string, limit: number): Promise<ParentPageHit[]>;
  /** Idempotently ensure the Observations DB exists. */
  bootstrapObservations(parentPageId: string): Promise<{ observationsDbId: string }>;
  createObservation(input: ObservationInput): Promise<ObservationRecord | null>;
  /** Most recent rows from the Observations DB, sorted by Captured At desc. */
  listRecentObservations(limit: number): Promise<RecentObservation[]>;
}

export class NotionGatewayError extends Error {
  constructor(public code: string, message: string) {
    super(message);
    this.name = "NotionGatewayError";
  }
}
