// Build the lookback context window for a completion candidate.
//
// Strategy: same tab as the trigger, walking backwards in time. Stop when
// any of these are true:
//   - we hit `MAX_EVENTS`
//   - the event is older than `WINDOW_MS` before the trigger
//   - we walked past a hard topic switch (host change that never returns)
//
// Result is ordered oldest → newest and includes the trigger itself as the
// final element.

import type { AppEvent } from "../types";

export interface LookbackOptions {
  windowMs?: number;     // default 5 min
  maxEvents?: number;    // default 100
}

const DEFAULT_WINDOW_MS = 5 * 60 * 1000;
const DEFAULT_MAX_EVENTS = 100;

/**
 * @param events  All recent events for this tab, ordered NEWEST → OLDEST
 *                (this matches what IDB `recent()` returns; cheaper than
 *                re-sorting).
 * @param trigger The completion-triggering event. Must appear in `events`.
 */
export function buildLookback(
  events: AppEvent[],
  trigger: AppEvent,
  opts: LookbackOptions = {},
): AppEvent[] {
  const windowMs = opts.windowMs ?? DEFAULT_WINDOW_MS;
  const maxEvents = opts.maxEvents ?? DEFAULT_MAX_EVENTS;
  const cutoffTs = trigger.ts - windowMs;

  // Filter to same-tab events at or before the trigger.
  const sameTab = events.filter(
    (e) => e.tabId === trigger.tabId && e.ts <= trigger.ts,
  );

  // events is newest→oldest, so walk from index 0 backward in time.
  const out: AppEvent[] = [];
  let lastHost: string | null = null;
  for (const e of sameTab) {
    if (e.ts < cutoffTs) break;
    if (out.length >= maxEvents) break;

    const host = hostOf(e.pageKey);
    if (lastHost && host && host !== lastHost) {
      // Topic switch: we've crossed onto a different host walking backward.
      // For v1 we stop here. (A more permissive rule: keep going if the host
      // appears again later in the chain — deferred.)
      break;
    }
    if (host) lastHost = host;
    out.push(e);
  }

  // out is newest→oldest including trigger; flip to oldest→newest.
  out.reverse();
  return out;
}

function hostOf(pageKey: string): string | null {
  if (!pageKey) return null;
  const slash = pageKey.indexOf("/");
  return slash === -1 ? pageKey : pageKey.slice(0, slash);
}
