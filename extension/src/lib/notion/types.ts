// Notion gateway interface — the abstraction the rest of the codebase talks to.
//
// Two impls planned:
//   - MockNotionGateway   (this milestone) — backed by IndexedDB
//   - RealNotionGateway   (later)         — backed by api.notion.com
//
// Keep the interface tight: every method here will need to be implemented
// against real Notion. If you're tempted to add a mock-only convenience,
// don't.

import type { NotionPropertySpec } from "../types";

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

export class NotionGatewayError extends Error {
  constructor(public code: string, message: string) {
    super(message);
    this.name = "NotionGatewayError";
  }
}
