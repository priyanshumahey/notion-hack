// Abstract storage interface for events.
//
// The whole point of this file is so we can swap IndexedDB out for a Notion-
// backed (or hybrid) store later without touching anything in background/ or
// popup/. Today there's exactly one impl: IDB. Tomorrow there's likely two:
//
//   - "events" (high volume, raw)   → IDB (always local)
//   - "workflows" / "tracked items" → Notion (user-facing)
//
// We deliberately keep the API tiny. Add operations only when something
// needs them.

import type { AppEvent } from "../types";

export interface EventStore {
  append(event: AppEvent): Promise<void>;
  /** Most recent events first. */
  recent(limit: number): Promise<AppEvent[]>;
  clear(): Promise<void>;
  count(): Promise<number>;
}

import { IdbEventStore } from "./idb";

let _store: EventStore | null = null;

/** Singleton accessor — every caller in the bg context shares one connection. */
export function getEventStore(): EventStore {
  if (!_store) _store = new IdbEventStore();
  return _store;
}
