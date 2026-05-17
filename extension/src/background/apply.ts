// Apply a judged candidate's proposal to the NotionGateway.
//
//   1. Resolve target DB: use existing (by id) or create new from the proposal.
//   2. Coerce row against the DB's actual schema (drops invalid fields).
//   3. Create the page.
//   4. Persist applied-state back onto the candidate.
//
// Idempotent: if applied.status === "applied" we return the candidate as-is.

import { getCompletionStore } from "../lib/store";
import { getNotionGateway } from "../lib/notion/gateway";
import { coerceRow } from "../lib/notion/coerce";
import { makeLog } from "../lib/log";
import { isConnectorConnected } from "../lib/connectors";
import type { CompletionCandidate } from "../lib/types";
import type { NotionDatabase } from "../lib/notion/types";

const log = makeLog("bg");

export async function applyCandidate(
  id: string,
  opts: { auto?: boolean } = {},
): Promise<CompletionCandidate | null> {
  const store = getCompletionStore();
  const candidate = await store.get(id);
  if (!candidate) return null;

  if (candidate.applied?.status === "applied") {
    return candidate; // idempotent
  }
  if (!(await isConnectorConnected("notion"))) {
    candidate.applied = {
      status: "failed",
      errorMessage: "Notion connector is not connected.",
      appliedAt: Date.now(),
    };
    candidate.connectorRuns = [
      ...(candidate.connectorRuns ?? []),
      {
        connectorId: "notion",
        connectorLabel: "Notion",
        action: "Create page",
        status: "failed",
        message: "Notion connector is not connected.",
        ranAt: Date.now(),
        auto: opts.auto,
      },
    ];
    await store.update(candidate);
    return candidate;
  }
  if (!candidate.judgement?.proposal) {
    candidate.applied = {
      status: "failed",
      errorMessage: "no proposal to apply",
      appliedAt: Date.now(),
    };
    await store.update(candidate);
    return candidate;
  }

  // Mark pending so the popup reflects in-flight state immediately.
  candidate.applied = { status: "pending", appliedAt: Date.now(), auto: opts.auto };
  await store.update(candidate);

  const gw = getNotionGateway();
  const prop = candidate.judgement.proposal;

  try {
    // 1. Resolve target database.
    let database: NotionDatabase | null = null;
    if (prop.database.mode === "use-existing" && prop.database.existingId) {
      database = await gw.getDatabase(prop.database.existingId);
      if (!database) {
        log.warn("apply: existing db not found, falling back to create-new", prop.database.existingId);
      }
    }
    if (!database) {
      database = await gw.createDatabase({
        name: prop.database.name,
        description: prop.database.description,
        properties: prop.database.properties,
      });
    }

    // 2. Coerce the proposed row against the DB's actual schema.
    const coerced = coerceRow(prop.row, database.properties);

    // 3. Create the page.
    const page = await gw.createPage({
      databaseId: database.id,
      properties: coerced.values,
      sourceCandidateId: candidate.id,
    });

    candidate.status = "promoted";
    candidate.applied = {
      status: "applied",
      databaseId: database.id,
      pageId: page.id,
      pageUrl: page.url,
      droppedFields: coerced.dropped.length ? coerced.dropped : undefined,
      appliedAt: Date.now(),
      auto: opts.auto,
    };
    candidate.connectorRuns = [
      ...(candidate.connectorRuns ?? []),
      {
        connectorId: "notion",
        connectorLabel: "Notion",
        action: "Create page",
        status: "applied",
        message: `Saved to ${database.name}.`,
        url: page.url,
        ranAt: Date.now(),
        auto: opts.auto,
      },
    ];
    await store.update(candidate);
    log(opts.auto ? "auto-applied" : "applied", candidate.id, "→", database.name, page.id);
    return candidate;
  } catch (e) {
    const msg = (e as Error).message;
    log.error("apply failed", candidate.id, msg);
    candidate.applied = {
      status: "failed",
      errorMessage: msg,
      appliedAt: Date.now(),
    };
    await store.update(candidate);
    return candidate;
  }
}

/**
 * User explicitly denied the proposal. We mark the candidate dismissed so
 * the popup hides it from the active list AND so the ingest pipeline
 * suppresses future candidates from the same cluster (deny respected as a
 * cluster-level signal — see loadRepetitionThrottle in ingest.ts).
 */
export async function denyCandidate(id: string): Promise<CompletionCandidate | null> {
  const store = getCompletionStore();
  const c = await store.get(id);
  if (!c) return null;
  if (c.applied?.status === "applied") {
    // Already in Notion — don't bury it.
    return c;
  }
  c.status = "dismissed";
  c.applied = {
    status: "skipped",
    appliedAt: Date.now(),
  };
  await store.update(c);
  log("denied", c.id, c.reason, c.trigger.pageKey);
  return c;
}
