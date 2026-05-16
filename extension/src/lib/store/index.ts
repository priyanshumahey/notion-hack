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

import type { AppEvent, CompletionCandidate } from "../types";

export interface EventStore {
  append(event: AppEvent): Promise<void>;
  /** Most recent events first. */
  recent(limit: number): Promise<AppEvent[]>;
  clear(): Promise<void>;
  count(): Promise<number>;
}

export interface CompletionStore {
  append(c: CompletionCandidate): Promise<void>;
  update(c: CompletionCandidate): Promise<void>;
  get(id: string): Promise<CompletionCandidate | undefined>;
  recent(limit: number): Promise<CompletionCandidate[]>;
  delete(id: string): Promise<void>;
  clear(): Promise<void>;
  count(): Promise<number>;
}

import { IdbEventStore, IdbCompletionStore } from "./idb";

let _events: EventStore | null = null;
let _completions: CompletionStore | null = null;

/** Singleton accessor — every caller in the bg context shares one connection. */
export function getEventStore(): EventStore {
  if (!_events) _events = new IdbEventStore();
  return _events;
}

export function getCompletionStore(): CompletionStore {
  if (!_completions) _completions = new IdbCompletionStore();
  return _completions;
}
