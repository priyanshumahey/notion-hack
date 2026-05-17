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
import { withHybridActionPlan } from "../lib/notion/action-plan";
import { makeLog } from "../lib/log";
import type { CompletionCandidate } from "../lib/types";
import type { NotionDatabase, NotionPropertyValue } from "../lib/notion/types";

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
  const prop = withHybridActionPlan(candidate.judgement.proposal, candidate);

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

    // 2.1. Belt-and-suspenders: any date field whose name reads as "when did
    //      I save this" gets stamped with the candidate's detection time.
    //      The LLM still hallucinates these from JSON-LD datePosted etc.
    //      Source dates (datePosted, published, event date) are left alone.
    stampSaveDates(coerced.values, database, candidate.detectedAt);

    // 2.5. Duplicate-row guard. If the proposed row has a URL-typed field
    //      that matches an existing page in the target DB, skip insert and
    //      mark the candidate as applied pointing at the existing page. This
    //      saves the user from accumulating duplicate "Smoky Grilled Pork
    //      Chops" rows on every revisit to the same recipe.
    const dup = await findDuplicate(database, coerced.values, candidate.trigger.url);
    if (dup) {
      candidate.applied = {
        status: "applied",
        databaseId: database.id,
        pageId: dup.id,
        pageUrl: dup.url,
        droppedFields: coerced.dropped.length ? coerced.dropped : undefined,
        appliedAt: Date.now(),
        auto: opts.auto,
        deduped: true,
      };
      await store.update(candidate);
      log(opts.auto ? "auto-applied (dedup)" : "applied (dedup)", candidate.id, "→", database.name, dup.id);
      return candidate;
    }

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

/**
 * Look for an existing page in `db` that matches the proposed row by any
 * URL-typed property OR by the candidate's trigger URL. Returns the
 * existing page if found.
 *
 * Strategy:
 *   1. For each url-typed property in the row, lookup by exact value.
 *   2. Also try the trigger URL against every url-typed schema property.
 * First match wins.
 */
async function findDuplicate(
  db: NotionDatabase,
  values: Record<string, NotionPropertyValue>,
  triggerUrl: string,
): Promise<{ id: string; url: string } | null> {
  const gw = getNotionGateway();
  const urlPropNames = db.properties.filter((p) => p.type === "url").map((p) => p.name);
  if (urlPropNames.length === 0) return null;

  const candidates: Array<{ prop: string; value: string }> = [];
  for (const name of urlPropNames) {
    const v = values[name];
    if (v && v.type === "url" && typeof v.value === "string" && v.value) {
      candidates.push({ prop: name, value: v.value });
    }
  }
  // Always also try the trigger URL against every url-typed property.
  for (const name of urlPropNames) {
    if (triggerUrl) candidates.push({ prop: name, value: triggerUrl });
  }

  for (const { prop, value } of candidates) {
    const hit = await gw.findPageByProperty(db.id, prop, value);
    if (hit) return { id: hit.id, url: hit.url };
  }
  return null;
}

/**
 * Override "save-time"-style date fields with the candidate's detection
 * timestamp. We match by property name: any date-typed prop whose name
 * reads as "when did I save / add / bookmark this" gets overridden, even
 * if the LLM already filled it in (it often hallucinates source dates).
 *
 * Properties named like "Date Posted", "Published", "Event Date", etc.
 * are left alone — those are source-data fields where the LLM's JSON-LD
 * extraction is what we want.
 */
const SAVE_DATE_NAME_RE = /(saved|added|bookmark|created|stored|captured|favorited)/i;

function stampSaveDates(
  values: Record<string, NotionPropertyValue>,
  db: NotionDatabase,
  nowMs: number,
): void {
  const iso = new Date(nowMs).toISOString();
  for (const spec of db.properties) {
    if (spec.type !== "date") continue;
    if (!SAVE_DATE_NAME_RE.test(spec.name)) continue;
    values[spec.name] = { type: "date", value: iso };
  }
}
