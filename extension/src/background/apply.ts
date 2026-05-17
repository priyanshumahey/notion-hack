// Apply a judged candidate's proposal to the user's REAL Notion workspace.
//
//   1. Resolve target DB:
//      - existing Notion DB id provided → fetch its real schema
//      - else find a DB under the Notion Dance parent matching proposal name
//      - else create a new DB under the Notion Dance parent
//   2. Coerce row against the DB's actual schema (drops invalid fields).
//   3. Create the destination row.
//   4. Write a Workflow row (status=active) capturing the trigger + schema.
//   5. Write a Run row (status=confirmed) linking workflow + created page.
//   6. Best-effort: mark contributing Observations rows promoted.
//   7. Persist applied-state back onto the candidate.
//
// Idempotent: if applied.status === "applied" we return the candidate as-is.
//
// Anything in steps 4–6 failing AFTER step 3 succeeded is non-fatal — the
// destination row is already written, so we still mark the candidate applied
// and log the secondary failure.

import { getCompletionStore } from "../lib/store";
import { coerceRow } from "../lib/notion/coerce";
import { makeLog } from "../lib/log";
import { getObservationsClient } from "../lib/notion/observations";
import { getNotionConnection } from "../lib/settings";
import { invalidateJudgeContext } from "./ingest";
import type { CompletionCandidate } from "../lib/types";
import type { NotionPropertySpec } from "../lib/types";

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

  const client = await getObservationsClient();
  const conn = await getNotionConnection();
  if (!client || !conn.bootstrapped) {
    candidate.applied = {
      status: "failed",
      errorMessage: "Notion not connected",
      appliedAt: Date.now(),
    };
    await store.update(candidate);
    return candidate;
  }

  // Mark pending so the popup reflects in-flight state immediately.
  candidate.applied = { status: "pending", appliedAt: Date.now(), auto: opts.auto };
  await store.update(candidate);

  const startedAt = Date.now();
  const prop = candidate.judgement.proposal;

  try {
    // 1. Resolve target database against REAL Notion.
    let dbId = "";
    let dbName = prop.database.name || "(untitled)";
    let dbSchema: NotionPropertySpec[] = prop.database.properties;

    // 1a. Try the proposal's "existing id" only if it actually exists in Notion.
    if (prop.database.mode === "use-existing" && prop.database.existingId) {
      const real = await client.getDatabaseSchema(prop.database.existingId);
      if (real) {
        dbId = real.id;
        dbName = real.name;
        dbSchema = real.properties;
        log("apply: reusing existing notion db", real.id, real.name);
      } else {
        log.warn(
          "apply: existing db id not found in notion, falling through",
          prop.database.existingId,
        );
      }
    }

    // 1b. Otherwise, look for a same-named DB under the Notion Dance parent.
    if (!dbId) {
      const match = await client.findDestinationDatabaseByName(
        conn.parentPageId,
        prop.database.name,
      );
      if (match) {
        const real = await client.getDatabaseSchema(match.id);
        if (real) {
          dbId = real.id;
          dbName = real.name;
          dbSchema = real.properties;
          log("apply: matched destination db by name", real.id, real.name);
        }
      }
    }

    // 1c. Last resort — create a new DB under Notion Dance with the proposed schema.
    if (!dbId) {
      const created = await client.createDestinationDatabase({
        parentPageId: conn.parentPageId,
        name: prop.database.name,
        description: prop.database.description,
        properties: prop.database.properties,
      });
      dbId = created.id;
      dbName = created.name;
      dbSchema = created.properties;
    }

    // 2. Coerce the proposed row against the DB's actual schema.
    const coerced = coerceRow(prop.row, dbSchema);

    // 2a. Dedup guard: if the destination DB has a URL property AND any
    //     row in it already points at this candidate's URL (trigger URL
    //     or canonical URL), short-circuit. Multiple triggers (rich-page
    //     + content-dwell + action-click) all converge on the same job /
    //     recipe / product — without this, each fires its own apply and
    //     creates duplicate rows.
    const dupUrls = collectCandidateUrls(candidate, coerced.values);
    const urlPropertyName = dbSchema.find((p) => p.type === "url")?.name ?? "";
    if (urlPropertyName && dupUrls.length) {
      try {
        const existing = await client.findRowByUrl(dbId, urlPropertyName, dupUrls);
        if (existing) {
          log("apply: dedup hit, row already exists", candidate.id, "→", existing.id);
          candidate.applied = {
            status: "skipped",
            databaseId: dbId,
            pageId: existing.id,
            pageUrl: existing.url,
            errorMessage: "duplicate URL — existing row reused",
            appliedAt: Date.now(),
            auto: opts.auto,
          };
          candidate.status = "promoted";
          await store.update(candidate);
          // Best-effort: log a `skipped` run so the user can see the dedup happened.
          try {
            await client.writeRun({
              workflowPageId: "",
              workflowName: inferWorkflowName(prop.database.name, candidate),
              triggeredAt: candidate.detectedAt,
              pageUrl: candidate.trigger.url,
              status: "skipped",
              userResponse: opts.auto ? "n/a" : "yes",
              createdPageId: existing.id,
              createdPageUrl: existing.url,
              extracted: coerced.values,
              error: "duplicate URL — existing row reused",
              latencyMs: Date.now() - startedAt,
            });
          } catch (e) {
            log.warn("apply: skipped-run write failed", (e as Error).message);
          }
          return candidate;
        }
      } catch (e) {
        // Dedup is best-effort — fall through and let the create proceed.
        log.warn("apply: dedup query failed, proceeding", (e as Error).message);
      }
    }

    // 3. Create the destination page.
    const page = await client.createPageInDatabase({
      databaseId: dbId,
      values: coerced.values,
    });

    // 4. Workflow row — best effort, non-fatal.
    let workflowPageId = "";
    let workflowPageUrl = "";
    try {
      const wfName = inferWorkflowName(prop.database.name, candidate);
      const wf = await client.writeWorkflow({
        name: wfName,
        status: "active",
        triggerSpec: buildTriggerSpec(candidate),
        sourceApps: uniqHosts(candidate),
        targetDatabaseId: dbId,
        targetDatabaseName: dbName,
        extractionSchema: { properties: dbSchema },
        runMode: "ask-each-time",
        confidenceFloor: candidate.judgement.confidence ?? 0.6,
        reasoning: candidate.judgement.reasoning ?? "",
        sourceCandidateId: candidate.id,
        sourceLocalEventIds: candidate.context.map((e) => e.id),
        approvedAt: Date.now(),
      });
      workflowPageId = wf.id;
      workflowPageUrl = wf.url;
    } catch (e) {
      log.warn("apply: workflow write failed", (e as Error).message);
    }

    // 5. Run row — best effort, non-fatal.
    try {
      await client.writeRun({
        workflowPageId,
        workflowName: inferWorkflowName(prop.database.name, candidate),
        triggeredAt: candidate.detectedAt,
        pageUrl: candidate.trigger.url,
        status: opts.auto ? "auto" : "confirmed",
        userResponse: opts.auto ? "n/a" : "yes",
        createdPageId: page.id,
        createdPageUrl: page.url,
        extracted: coerced.values,
        error: "",
        latencyMs: Date.now() - startedAt,
      });
    } catch (e) {
      log.warn("apply: run write failed", (e as Error).message);
    }

    // 6. Promote contributing observations — best effort, non-fatal.
    if (workflowPageId) {
      const ids = candidate.context.map((e) => e.id).slice(-25);
      for (const eid of ids) {
        try {
          await client.promoteObservationByLocalEventId(eid, workflowPageId);
        } catch (e) {
          log.warn("apply: promote obs failed", eid, (e as Error).message);
        }
      }
    }

    candidate.applied = {
      status: "applied",
      databaseId: dbId,
      pageId: page.id,
      pageUrl: page.url,
      droppedFields: coerced.dropped.length ? coerced.dropped : undefined,
      appliedAt: Date.now(),
      auto: opts.auto,
    };
    candidate.status = "promoted";
    await store.update(candidate);
    // Any subsequent judge call should see the new workflow + (possibly new)
    // destination DB immediately, not after the TTL.
    invalidateJudgeContext();
    log(
      opts.auto ? "auto-applied" : "applied",
      candidate.id,
      "→",
      dbName,
      page.id,
      workflowPageUrl ? `(workflow ${workflowPageId})` : "(no workflow)",
    );
    notifyRunCompleted({
      candidateId: candidate.id,
      databaseName: dbName,
      pageUrl: page.url,
      auto: !!opts.auto,
    }).catch((err) => log.warn("run notify failed", (err as Error).message));
    return candidate;
  } catch (e) {
    const msg = (e as Error).message;
    log.error("apply failed", candidate.id, msg);
    // Best-effort run row capturing the failure.
    try {
      await client.writeRun({
        workflowPageId: "",
        workflowName: inferWorkflowName(prop.database.name, candidate),
        triggeredAt: candidate.detectedAt,
        pageUrl: candidate.trigger.url,
        status: "failed",
        userResponse: opts.auto ? "n/a" : "yes",
        createdPageId: "",
        createdPageUrl: "",
        extracted: prop.row,
        error: msg,
        latencyMs: Date.now() - startedAt,
      });
    } catch {
      /* failing-to-log-the-failure is fine */
    }
    candidate.applied = {
      status: "failed",
      errorMessage: msg,
      appliedAt: Date.now(),
    };
    await store.update(candidate);
    return candidate;
  }
}

function inferWorkflowName(
  dbName: string,
  candidate: CompletionCandidate,
): string {
  const verb = labelVerb(candidate.reason);
  if (dbName && dbName.trim()) return `${verb} → ${dbName}`.slice(0, 200);
  return `${verb} workflow`.slice(0, 200);
}

function labelVerb(reason: CompletionCandidate["reason"]): string {
  switch (reason) {
    case "activity":
      return "Save";
    case "form-submit":
      return "Capture form";
    case "terminal-nav":
      return "Save terminal page";
    case "content-dwell":
      return "Save read";
    case "repetition":
      return "Save repeated pages";
    case "action-click":
      return "Save action clicks";
    case "rich-page":
      return "Save rich pages";
  }
}

function buildTriggerSpec(candidate: CompletionCandidate): unknown {
  return {
    v: 1,
    kind: candidate.reason,
    hosts: uniqHosts(candidate),
    pageKeys: candidate.scope.pageKeys.slice(0, 10),
    triggerPageKey: candidate.trigger.pageKey,
  };
}

function uniqHosts(candidate: CompletionCandidate): string[] {
  return Array.from(new Set(candidate.scope.hosts.filter(Boolean))).slice(0, 20);
}

/**
 * Collect every URL the apply path might dedupe against:
 *   - the trigger event's URL (what the user was on when the candidate fired)
 *   - the trigger event's pageContext canonicalUrl (Notion stores canonical)
 *   - any URL value already present in the coerced row
 *
 * Deduplicated, trimmed, capped at 8 entries so the Notion filter doesn't
 * balloon.
 */
function collectCandidateUrls(
  candidate: CompletionCandidate,
  rowValues: Record<string, unknown>,
): string[] {
  const out = new Set<string>();
  const add = (v: unknown) => {
    if (typeof v === "string" && v.trim() && /^https?:/i.test(v.trim())) {
      out.add(v.trim());
    }
  };
  add(candidate.trigger.url);
  add(candidate.trigger.pageContext?.canonicalUrl);
  for (const v of Object.values(rowValues)) add(v);
  return Array.from(out).slice(0, 8);
}

/**
 * Surface a successful run to the OS notification center. The notification
 * id encodes the candidate id so the click handler in background/index.ts
 * can route the popup to the right place.
 */
async function notifyRunCompleted(args: {
  candidateId: string;
  databaseName: string;
  pageUrl: string;
  auto: boolean;
}): Promise<void> {
  if (!chrome.notifications?.create) return;
  const verb = args.auto ? "Auto-applied" : "Applied";
  await chrome.notifications.create(`run:${args.candidateId}`, {
    type: "basic",
    iconUrl: chrome.runtime.getURL("public/icon-128.png"),
    title: `Notion Hack — ${verb}`,
    message: `New row added to "${args.databaseName}". Click to view runs.`,
    priority: 0,
  });
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
