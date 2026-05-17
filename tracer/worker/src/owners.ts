/**
 * No-op "owner" syncs.
 *
 * `worker.database()` declares a schema, but the platform only provisions a
 * managed Notion database on deploy when at least one sync references it.
 * For databases that aren't otherwise written to by a sync (e.g. our trace
 * DBs are populated by the ingest webhook), we attach a manual-schedule sync
 * here whose `execute` returns no changes. That gives the database an owner
 * for provisioning purposes without ever triggering writes.
 *
 * `schedule: "manual"` means the sync will only run if `ntn workers sync run`
 * is invoked explicitly, which we never do for these placeholders.
 */

import type { Worker, SyncExecutionResult } from "@notionhq/workers";
import type { Databases } from "./databases.js";

export function registerOwnerSyncs(worker: Worker, dbs: Databases): void {
  const noopExecute = async (): Promise<SyncExecutionResult<string>> => ({
    changes: [],
    hasMore: false,
  });

  const owners: Array<{ key: string; db: keyof Databases }> = [
    { key: "sessionsOwner", db: "sessions" },
    { key: "tracesOwner", db: "traces" },
    { key: "spansOwner", db: "spans" },
    { key: "llmCallsOwner", db: "llmCalls" },
    { key: "toolCallsOwner", db: "toolCalls" },
    { key: "eventsOwner", db: "events" },
    // sandboxes & functions are owned by seedSandboxes / seedFunctions
    // in src/seed-syncs.ts (those syncs emit upserts populating the rows).
    { key: "wakesOwner", db: "wakes" },
  ];

  for (const { key, db } of owners) {
    worker.sync(key, {
      database: dbs[db] as never,
      mode: "incremental",
      schedule: "manual",
      execute: noopExecute,
    });
  }
}
