// IndexedDB-backed mock of NotionGateway.
//
// Stores live in the same DB as events/completions (`notion-hack`):
//   - notion_databases (keyed by id)
//   - notion_pages     (keyed by id, indexed by databaseId)
//
// Behavior mirrors what real Notion will do:
//   - createDatabase requires exactly one title property.
//   - createPage requires the parent database to exist.
//   - findPageByProperty does exact string match (used for dedup).
//
// What's deliberately NOT here: rate limiting, batched inserts, content
// blocks. Mock is fast and clean; we exercise edge cases via tests instead.

import { openDb, STORES } from "../store/idb";
import { newId } from "../ids";
import { makeLog } from "../log";
import type {
  NotionGateway,
  NotionDatabase,
  NotionPage,
  CreateDatabaseInput,
  CreatePageInput,
} from "./types";
import { NotionGatewayError } from "./types";

const log = makeLog("store");

export class MockNotionGateway implements NotionGateway {
  kind(): "mock" {
    return "mock";
  }
  workspaceLabel(): string {
    return "Mock Notion";
  }

  async createDatabase(input: CreateDatabaseInput): Promise<NotionDatabase> {
    const titles = input.properties.filter((p) => p.type === "title");
    if (titles.length !== 1) {
      throw new NotionGatewayError(
        "validation_error",
        `database must have exactly one title property, got ${titles.length}`,
      );
    }
    const now = Date.now();
    const db: NotionDatabase = {
      id: newId(),
      name: input.name || "Untitled",
      description: input.description ?? "",
      properties: input.properties,
      createdAt: now,
      updatedAt: now,
      rowCount: 0,
      workspace: "mock",
    };
    await this.put(STORES.notionDatabases, db);
    log("mock-notion: created db", db.id, db.name);
    return db;
  }

  async getDatabase(id: string): Promise<NotionDatabase | null> {
    return (await this.get<NotionDatabase>(STORES.notionDatabases, id)) ?? null;
  }

  async listDatabases(): Promise<NotionDatabase[]> {
    const all = await this.all<NotionDatabase>(STORES.notionDatabases);
    return all.sort((a, b) => b.updatedAt - a.updatedAt);
  }

  async createPage(input: CreatePageInput): Promise<NotionPage> {
    const db = await this.getDatabase(input.databaseId);
    if (!db) {
      throw new NotionGatewayError("not_found", `database not found: ${input.databaseId}`);
    }
    const now = Date.now();
    const pageId = newId();
    const page: NotionPage = {
      id: pageId,
      databaseId: input.databaseId,
      url: `mock://db/${db.id}/page/${pageId}`,
      properties: input.properties,
      createdAt: now,
      updatedAt: now,
      sourceCandidateId: input.sourceCandidateId,
    };
    // Bump db.rowCount + updatedAt in the same transaction for consistency.
    const idb = await openDb();
    await new Promise<void>((resolve, reject) => {
      const tx = idb.transaction(
        [STORES.notionDatabases, STORES.notionPages],
        "readwrite",
      );
      tx.objectStore(STORES.notionPages).put(page);
      const dbUpdated: NotionDatabase = {
        ...db,
        rowCount: db.rowCount + 1,
        updatedAt: now,
      };
      tx.objectStore(STORES.notionDatabases).put(dbUpdated);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
    log("mock-notion: created page", page.id, "in", db.name);
    return page;
  }

  async listPages(databaseId: string, limit: number): Promise<NotionPage[]> {
    const idb = await openDb();
    return new Promise<NotionPage[]>((resolve, reject) => {
      const tx = idb.transaction(STORES.notionPages, "readonly");
      const idx = tx
        .objectStore(STORES.notionPages)
        .index(STORES.notionPagesDbIndex);
      const out: NotionPage[] = [];
      const req = idx.openCursor(IDBKeyRange.only(databaseId), "prev");
      req.onsuccess = () => {
        const cur = req.result;
        if (cur && out.length < limit) {
          out.push(cur.value as NotionPage);
          cur.continue();
        } else {
          // Sort newest first (cursor "prev" already gives reverse insert order;
          // explicit sort guards against any non-monotonic ids).
          out.sort((a, b) => b.createdAt - a.createdAt);
          resolve(out);
        }
      };
      req.onerror = () => reject(req.error);
    });
  }

  async findPageByProperty(
    databaseId: string,
    propertyName: string,
    value: string,
  ): Promise<NotionPage | null> {
    // Linear scan: mock DBs stay small, and dedup is rare.
    const pages = await this.listPages(databaseId, 10_000);
    const target = value.toLowerCase();
    for (const p of pages) {
      const v = p.properties[propertyName];
      if (!v) continue;
      if (typeof v.value === "string" && v.value.toLowerCase() === target) return p;
      if (Array.isArray(v.value) && v.value.some((s) => s.toLowerCase() === target)) {
        return p;
      }
    }
    return null;
  }

  async clearAll(): Promise<void> {
    const idb = await openDb();
    await new Promise<void>((resolve, reject) => {
      const tx = idb.transaction(
        [STORES.notionDatabases, STORES.notionPages],
        "readwrite",
      );
      tx.objectStore(STORES.notionDatabases).clear();
      tx.objectStore(STORES.notionPages).clear();
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
    log.warn("mock-notion: cleared all");
  }

  // ---- low-level helpers ----

  private async put(store: string, value: unknown): Promise<void> {
    const idb = await openDb();
    await new Promise<void>((resolve, reject) => {
      const tx = idb.transaction(store, "readwrite");
      tx.objectStore(store).put(value);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
  }

  private async get<T>(store: string, id: string): Promise<T | undefined> {
    const idb = await openDb();
    return new Promise<T | undefined>((resolve, reject) => {
      const tx = idb.transaction(store, "readonly");
      const req = tx.objectStore(store).get(id);
      req.onsuccess = () => resolve(req.result as T | undefined);
      req.onerror = () => reject(req.error);
    });
  }

  private async all<T>(store: string): Promise<T[]> {
    const idb = await openDb();
    return new Promise<T[]>((resolve, reject) => {
      const tx = idb.transaction(store, "readonly");
      const req = tx.objectStore(store).getAll();
      req.onsuccess = () => resolve(req.result as T[]);
      req.onerror = () => reject(req.error);
    });
  }
}
