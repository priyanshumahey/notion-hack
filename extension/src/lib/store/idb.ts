// IndexedDB-backed implementation of EventStore.
//
// One database (`notion-hack`), one object store (`events`), keyed by the
// event's own monotonic `id`. Secondary index on `ts` for fast recent() reads.
//
// We cap the store at MAX_EVENTS rows; older ones are evicted in batches when
// we exceed it. Cheap, predictable, no quota errors during long sessions.

import type { AppEvent } from "../types";
import { makeLog } from "../log";
import type { EventStore } from "./index";

const DB_NAME = "notion-hack";
const DB_VERSION = 1;
const STORE = "events";
const TS_INDEX = "ts";
const MAX_EVENTS = 20_000;
const EVICT_BATCH = 1_000;

const log = makeLog("store");

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE)) {
        const os = db.createObjectStore(STORE, { keyPath: "id" });
        os.createIndex(TS_INDEX, "ts", { unique: false });
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

export class IdbEventStore implements EventStore {
  private dbP: Promise<IDBDatabase> | null = null;
  private writesSinceEvictCheck = 0;

  private db(): Promise<IDBDatabase> {
    if (!this.dbP) this.dbP = openDb();
    return this.dbP;
  }

  async append(event: AppEvent): Promise<void> {
    const db = await this.db();
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(STORE, "readwrite");
      tx.objectStore(STORE).put(event);
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
    const db = await this.db();
    return new Promise<AppEvent[]>((resolve, reject) => {
      const tx = db.transaction(STORE, "readonly");
      const idx = tx.objectStore(STORE).index(TS_INDEX);
      const out: AppEvent[] = [];
      // openCursor with "prev" walks newest → oldest.
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
    const db = await this.db();
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(STORE, "readwrite");
      tx.objectStore(STORE).clear();
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
  }

  async count(): Promise<number> {
    const db = await this.db();
    return new Promise<number>((resolve, reject) => {
      const tx = db.transaction(STORE, "readonly");
      const req = tx.objectStore(STORE).count();
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  }

  /** If we're over MAX_EVENTS, delete the oldest EVICT_BATCH. */
  private async maybeEvict(): Promise<void> {
    const total = await this.count();
    if (total <= MAX_EVENTS) return;
    const toDelete = Math.max(EVICT_BATCH, total - MAX_EVENTS);
    const db = await this.db();
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(STORE, "readwrite");
      const idx = tx.objectStore(STORE).index(TS_INDEX);
      const req = idx.openCursor(null, "next"); // oldest first
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
