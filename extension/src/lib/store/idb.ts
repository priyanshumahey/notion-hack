// IndexedDB-backed implementation of EventStore + CompletionStore + Notion mock.
//
// One database (`notion-hack`), four object stores:
//   - `events`            v1, keyed by id, indexed by ts          (high volume; capped + evicted)
//   - `completions`       v2, keyed by id, indexed by detectedAt  (low volume; no eviction)
//   - `notion_databases`  v3, keyed by id                          (mock Notion workspace)
//   - `notion_pages`      v3, keyed by id, indexed by databaseId  (mock Notion pages)

import type { AppEvent, CompletionCandidate } from "../types";
import { makeLog } from "../log";
import type { EventStore } from "./index";

const DB_NAME = "notion-hack";
const DB_VERSION = 3;
const EVENTS_STORE = "events";
const EVENTS_TS_INDEX = "ts";
const COMPLETIONS_STORE = "completions";
const COMPLETIONS_TS_INDEX = "detectedAt";
const NOTION_DATABASES_STORE = "notion_databases";
const NOTION_PAGES_STORE = "notion_pages";
const NOTION_PAGES_DB_INDEX = "databaseId";
const MAX_EVENTS = 20_000;
const EVICT_BATCH = 1_000;

export const STORES = {
  events: EVENTS_STORE,
  completions: COMPLETIONS_STORE,
  notionDatabases: NOTION_DATABASES_STORE,
  notionPages: NOTION_PAGES_STORE,
  notionPagesDbIndex: NOTION_PAGES_DB_INDEX,
} as const;

const log = makeLog("store");

let dbP: Promise<IDBDatabase> | null = null;

export function openDb(): Promise<IDBDatabase> {
  if (dbP) return dbP;
  dbP = new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = (event) => {
      const db = req.result;
      const oldVersion = (event as IDBVersionChangeEvent).oldVersion;
      if (oldVersion < 1) {
        const os = db.createObjectStore(EVENTS_STORE, { keyPath: "id" });
        os.createIndex(EVENTS_TS_INDEX, "ts", { unique: false });
      }
      if (oldVersion < 2) {
        const os = db.createObjectStore(COMPLETIONS_STORE, { keyPath: "id" });
        os.createIndex(COMPLETIONS_TS_INDEX, "detectedAt", { unique: false });
      }
      if (oldVersion < 3) {
        db.createObjectStore(NOTION_DATABASES_STORE, { keyPath: "id" });
        const pagesOs = db.createObjectStore(NOTION_PAGES_STORE, { keyPath: "id" });
        pagesOs.createIndex(NOTION_PAGES_DB_INDEX, "databaseId", { unique: false });
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  return dbP;
}

export class IdbEventStore implements EventStore {
  private writesSinceEvictCheck = 0;

  async append(event: AppEvent): Promise<void> {
    const db = await openDb();
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(EVENTS_STORE, "readwrite");
      tx.objectStore(EVENTS_STORE).put(event);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
    this.writesSinceEvictCheck++;
    if (this.writesSinceEvictCheck >= 200) {
      this.writesSinceEvictCheck = 0;
      this.maybeEvict().catch((e) => log.warn("evict failed", e));
    }
  }

  async recent(limit: number): Promise<AppEvent[]> {
    const db = await openDb();
    return new Promise<AppEvent[]>((resolve, reject) => {
      const tx = db.transaction(EVENTS_STORE, "readonly");
      const idx = tx.objectStore(EVENTS_STORE).index(EVENTS_TS_INDEX);
      const out: AppEvent[] = [];
      const req = idx.openCursor(null, "prev");
      req.onsuccess = () => {
        const cur = req.result;
        if (cur && out.length < limit) {
          out.push(cur.value as AppEvent);
          cur.continue();
        } else {
          resolve(out);
        }
      };
      req.onerror = () => reject(req.error);
    });
  }

  async clear(): Promise<void> {
    const db = await openDb();
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(EVENTS_STORE, "readwrite");
      tx.objectStore(EVENTS_STORE).clear();
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
  }

  async count(): Promise<number> {
    const db = await openDb();
    return new Promise<number>((resolve, reject) => {
      const tx = db.transaction(EVENTS_STORE, "readonly");
      const req = tx.objectStore(EVENTS_STORE).count();
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  }

  private async maybeEvict(): Promise<void> {
    const total = await this.count();
    if (total <= MAX_EVENTS) return;
    const toDelete = Math.max(EVICT_BATCH, total - MAX_EVENTS);
    const db = await openDb();
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(EVENTS_STORE, "readwrite");
      const idx = tx.objectStore(EVENTS_STORE).index(EVENTS_TS_INDEX);
      const req = idx.openCursor(null, "next");
      let deleted = 0;
      req.onsuccess = () => {
        const cur = req.result;
        if (cur && deleted < toDelete) {
          cur.delete();
          deleted++;
          cur.continue();
        }
      };
      tx.oncomplete = () => {
        log("evicted", deleted, "of", total);
        resolve();
      };
      tx.onerror = () => reject(tx.error);
    });
  }
}

// ---- Completions store ----------------------------------------------------

export class IdbCompletionStore {
  async append(c: CompletionCandidate): Promise<void> {
    const db = await openDb();
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(COMPLETIONS_STORE, "readwrite");
      tx.objectStore(COMPLETIONS_STORE).put(c);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
  }

  async update(c: CompletionCandidate): Promise<void> {
    return this.append(c); // put = upsert
  }

  async get(id: string): Promise<CompletionCandidate | undefined> {
    const db = await openDb();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(COMPLETIONS_STORE, "readonly");
      const req = tx.objectStore(COMPLETIONS_STORE).get(id);
      req.onsuccess = () => resolve(req.result as CompletionCandidate | undefined);
      req.onerror = () => reject(req.error);
    });
  }

  async recent(limit: number): Promise<CompletionCandidate[]> {
    const db = await openDb();
    return new Promise<CompletionCandidate[]>((resolve, reject) => {
      const tx = db.transaction(COMPLETIONS_STORE, "readonly");
      const idx = tx.objectStore(COMPLETIONS_STORE).index(COMPLETIONS_TS_INDEX);
      const out: CompletionCandidate[] = [];
      const req = idx.openCursor(null, "prev");
      req.onsuccess = () => {
        const cur = req.result;
        if (cur && out.length < limit) {
          out.push(cur.value as CompletionCandidate);
          cur.continue();
        } else {
          resolve(out);
        }
      };
      req.onerror = () => reject(req.error);
    });
  }

  async delete(id: string): Promise<void> {
    const db = await openDb();
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(COMPLETIONS_STORE, "readwrite");
      tx.objectStore(COMPLETIONS_STORE).delete(id);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
  }

  async clear(): Promise<void> {
    const db = await openDb();
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(COMPLETIONS_STORE, "readwrite");
      tx.objectStore(COMPLETIONS_STORE).clear();
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
  }

  async count(): Promise<number> {
    const db = await openDb();
    return new Promise<number>((resolve, reject) => {
      const tx = db.transaction(COMPLETIONS_STORE, "readonly");
      const req = tx.objectStore(COMPLETIONS_STORE).count();
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  }
}
