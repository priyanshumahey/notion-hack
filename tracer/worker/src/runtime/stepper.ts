/**
 * `functionStepper` sync — owns the `Functions · Runs` database.
 *
 * Two-stage lifecycle per run:
 *
 *   1. **Adoption.** The trigger webhook pages.create's an "external"
 *      pending row. The stepper's next tick queries pending rows that
 *      AREN'T yet sync-tracked (i.e. the framework's internal upsert map
 *      hasn't seen their `Run ID`). It reads the row's data, archives it
 *      via `pages.update({archived:true})` (the one mutation the platform
 *      permits on sync-owned rows), and emits a SyncChange upsert with
 *      `key=runId` — that creates a sync-tracked row carrying the original
 *      properties + the result of running step 0.
 *
 *   2. **Advancement.** From tick 2 onwards the stepper queries
 *      pending/running rows that ARE sync-tracked (no archive needed; the
 *      sync owns them), runs the next step, and emits another upsert.
 *
 * Why this dance?
 *   - `pages.update` with property writes is rejected on sync-owned rows.
 *   - Sync upserts don't auto-adopt externally-created rows (matched by
 *     primary key, not by content), so the trigger's pages.create row and
 *     a stepper upsert with the same runId would produce two rows.
 *   - pages.update with `archived:true` alone IS allowed, which lets us
 *     retire the external row before claiming the runId via upsert.
 *
 * A sync upsert REPLACES the row's property bag, so every change must
 * re-state preserve-worthy properties (Name, Run ID, Trace ID, Function
 * relation, Sandbox relation, Input, Started At).
 */

import * as Builder from "@notionhq/workers/builder";
import type { Worker, SyncExecutionResult } from "@notionhq/workers";
import type { Client as NotionClient } from "@notionhq/client";

import {
  getNumber,
  getRelation,
  getRichText,
  getSelect,
  randHex,
  resolveRuntimeDbId,
  safeStringify,
  truncate,
} from "./notion.js";
import { executeStep, interpolateString } from "./steps.js";
import type {
  ControlStep,
  FunctionDefinition,
  RunState,
  SendEventStep,
  SleepUntilStep,
  StepOutput,
  WaitForEventStep,
  WorkStep,
} from "./types.js";
import { isControlStep } from "./types.js";

const MAX_RUNS_PER_TICK = 50;
const MAX_ATTEMPTS = 3;
/** Max concurrent run advancements within a single tick. Bounded to avoid
 *  hammering Notion's 3 req/s rate limit too hard; bursts up to ~20 req/s
 *  for a few seconds are tolerated, sustained higher gets 429'd. */
const TICK_CONCURRENCY = 12;
/** Max wake rows pulled per tick. Bounded so a flood of unmatched events
 *  doesn't blow up a single tick's work. Rows older than this window
 *  scroll off the page and are effectively ignored. */
const MAX_WAKES_PER_TICK = 100;

interface PendingWake {
  pageId: string;
  wakeId: string;
  eventName: string;
  eventId: string;
  data: unknown;
  createdAt: number;
}

interface TickCtx {
  wakesByEvent: Map<string, PendingWake[]>;
  consumedWakeIds: Set<string>;
}

type Status =
  | "pending"
  | "running"
  | "sleeping"
  | "waiting"
  | "succeeded"
  | "failed"
  | "cancelled";

interface LiveRun {
  pageId: string;
  runId: string;
  name: string;
  functionPageId: string | null;
  functionKey: string;
  sandboxKey: string | null;
  traceId: string;
  status: Status;
  stepCursor: number;
  attempt: number;
  inputJson: string;
  startedAt: string | null;
  currentStepId: string | null;
  sleepUntil: string | null;
  waitingForEvent: string | null;
  wakeAt: string | null;
  sourceEventId: string | null;
  state: RunState & {
    rootSpanId?: string;
    /** Filter expression persisted alongside a `waiting` parked run. */
    waitMatch?: { path: string; value: string | number | boolean };
    sourceEventId?: string;
  };
}

// SyncChange property bag for the FunctionRuns DB. We type it loosely
// because the Builder helpers return Builder-internal shapes that we cast
// to `never` at the SyncChange boundary (matches the project pattern).
type RunChangeProps = Record<string, unknown>;

export function registerStepperSync(
  worker: Worker,
  deps: { functionRunsDb: ReturnType<Worker["database"]> },
): void {
  worker.sync("functionStepper", {
    database: deps.functionRunsDb as never,
    mode: "incremental",
    schedule: "continuous",
    execute: async (
      _state,
      ctx,
    ): Promise<SyncExecutionResult<string>> => {
      let changes: Array<Record<string, unknown>> = [];
      try {
        changes = await tick(ctx.notion);
      } catch (err) {
        console.error(
          "[functionStepper] tick failed:",
          err instanceof Error ? err.stack : err,
        );
      }
      return {
        changes: changes as never,
        hasMore: false,
      };
    },
  });
}

async function tick(notion: NotionClient): Promise<Array<Record<string, unknown>>> {
  const changes: Array<Record<string, unknown>> = [];

  const runsDb = await resolveRuntimeDbId(notion, "functionRuns");
  if (!runsDb) {
    console.warn("[functionStepper] functionRuns DB not provisioned yet");
    return changes;
  }

  // Pull pending wakes — events delivered via `sendEvent` that haven't
  // yet been applied to a parked run. We piggy-back on Tracer · Events
  // (Type=signal rows) so wake delivery doesn't depend on a separate
  // managed DB being visible to the integration. Best-effort: if the
  // events DB isn't resolvable yet (fresh deploy, search index not
  // caught up), we skip event-driven wake this tick and parked runs
  // only resolve on timeout.
  const eventsDb = await resolveRuntimeDbId(notion, "events");
  const wakesByEvent = new Map<string, PendingWake[]>();
  if (eventsDb) {
    try {
      const wakes = await fetchRecentWakes(notion, eventsDb);
      for (const w of wakes) {
        const arr = wakesByEvent.get(w.eventName) ?? [];
        arr.push(w);
        wakesByEvent.set(w.eventName, arr);
      }
    } catch (err) {
      console.warn(
        "[functionStepper] failed to fetch wakes:",
        err instanceof Error ? err.message : err,
      );
    }
  }
  const consumedWakeIds = new Set<string>();

  // Advance live runs. We include sleeping/waiting runs so we can wake
  // them when their preconditions (timer / timeout / event) elapse.
  const res = await notion.databases.query({
    database_id: runsDb,
    filter: {
      and: [
        {
          or: [
            { property: "Status", select: { equals: "pending" } },
            { property: "Status", select: { equals: "running" } },
            { property: "Status", select: { equals: "sleeping" } },
            { property: "Status", select: { equals: "waiting" } },
          ],
        },
        { property: "Function", relation: { is_not_empty: true } },
      ],
    },
    page_size: MAX_RUNS_PER_TICK,
    sorts: [{ timestamp: "created_time", direction: "ascending" }],
  });

  // Track runIds seen this tick so we emit at most one upsert per key.
  // Dedup synchronously before kicking off parallel work.
  const seen = new Set<string>();
  const lives: LiveRun[] = [];
  for (const row of res.results) {
    if (!("properties" in row)) continue;
    const props = (row as { properties: Record<string, unknown> }).properties;
    const runId = getRichText(props, "Run ID");
    if (!runId || seen.has(runId)) continue;
    seen.add(runId);
    lives.push(readLiveRun(row.id, props));
  }

  // Process rows in parallel with a bounded pool. Each row's work is
  // independent (different runIds), so concurrency is safe. Bounded so we
  // don't exceed Notion's tolerance for burst RPS.
  const perRow = await runWithConcurrency(lives, TICK_CONCURRENCY, (live) =>
    processRun(notion, live, { wakesByEvent, consumedWakeIds }),
  );
  for (const arr of perRow) changes.push(...arr);

  return changes;
}

async function runWithConcurrency<T, R>(
  items: T[],
  limit: number,
  fn: (item: T) => Promise<R>,
): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let next = 0;
  const workers = Array.from(
    { length: Math.min(limit, items.length) },
    async () => {
      while (true) {
        const i = next++;
        if (i >= items.length) return;
        try {
          results[i] = await fn(items[i]!);
        } catch (err) {
          // Should not happen — processRun catches its own errors and emits
          // failure changes. Log defensively.
          console.error(
            "[functionStepper] runWithConcurrency: worker threw",
            err instanceof Error ? err.stack : err,
          );
          results[i] = [] as unknown as R;
        }
      }
    },
  );
  await Promise.all(workers);
  return results;
}

async function processRun(
  notion: NotionClient,
  live: LiveRun,
  ctx: TickCtx,
): Promise<Array<Record<string, unknown>>> {
  const changes: Array<Record<string, unknown>> = [];

  let definition: FunctionDefinition;
  try {
    definition = await loadFunctionDefinition(notion, live);
  } catch (err) {
    changes.push(
      buildFailed(
        live,
        `Failed to load function definition: ${err instanceof Error ? err.message : err}`,
      ),
    );
    return changes;
  }

  const stepsTotal = definition.steps.length;

  // -- Wake/skip parked runs ---------------------------------------------
  if (live.status === "sleeping") {
    const due =
      !live.sleepUntil || Date.parse(live.sleepUntil) <= Date.now();
    if (!due) return changes;
    const stepId =
      live.currentStepId ?? definition.steps[live.stepCursor]?.id ?? null;
    if (stepId) {
      live.state.steps[stepId] = {
        status: "ok",
        result: { slept: true, until: live.sleepUntil },
        durationMs: 0,
      };
    }
    const nextCursor = live.stepCursor + 1;
    const completed = nextCursor >= stepsTotal;
    changes.push(
      buildProgress(
        { ...live, stepCursor: nextCursor, attempt: 0 },
        completed ? "succeeded" : "running",
        completed ? null : definition.steps[nextCursor]?.id ?? null,
        stepsTotal,
      ),
    );
    return changes;
  }

  if (live.status === "waiting") {
    const stepId =
      live.currentStepId ?? definition.steps[live.stepCursor]?.id ?? null;
    // Event-driven wake: scan the per-tick wake index for a wake row
    // whose event name matches this run's `waitingForEvent` AND (if a
    // waitMatch comparator is persisted in state) whose event data
    // satisfies the comparator. First match wins, and we mark it
    // consumed so other parallel workers in this tick skip it.
    if (live.waitingForEvent) {
      const candidates = ctx.wakesByEvent.get(live.waitingForEvent) ?? [];
      for (const wake of candidates) {
        if (ctx.consumedWakeIds.has(wake.wakeId)) continue;
        if (live.state.waitMatch) {
          const observed = lookupPath(wake.data, live.state.waitMatch.path);
          if (!matchValueLoose(observed, live.state.waitMatch.value)) continue;
        }
        ctx.consumedWakeIds.add(wake.wakeId);
        if (stepId) {
          live.state.steps[stepId] = {
            status: "ok",
            result: {
              event: {
                name: wake.eventName,
                id: wake.eventId,
                data: wake.data,
              },
              data: wake.data,
              timedOut: false,
            },
            durationMs: 0,
          };
        }
        delete live.state.waitMatch;
        const nextCursor = live.stepCursor + 1;
        const completed = nextCursor >= stepsTotal;
        changes.push(
          buildProgress(
            { ...live, stepCursor: nextCursor, attempt: 0 },
            completed ? "succeeded" : "running",
            completed ? null : definition.steps[nextCursor]?.id ?? null,
            stepsTotal,
          ),
        );
        return changes;
      }
    }
    // No matching wake this tick — fall back to timeout. The step
    // result is { timedOut: true } so userland can detect it.
    const timedOut =
      live.wakeAt && Date.parse(live.wakeAt) <= Date.now();
    if (timedOut && stepId) {
      live.state.steps[stepId] = {
        status: "ok",
        result: { timedOut: true },
        durationMs: 0,
      };
      delete live.state.waitMatch;
      const nextCursor = live.stepCursor + 1;
      const completed = nextCursor >= stepsTotal;
      changes.push(
        buildProgress(
          { ...live, stepCursor: nextCursor, attempt: 0 },
          completed ? "succeeded" : "running",
          completed ? null : definition.steps[nextCursor]?.id ?? null,
          stepsTotal,
        ),
      );
      return changes;
    }
    // Still waiting — do nothing this tick.
    return changes;
  }

  // -- pending / running: execute next step ------------------------------
  if (live.stepCursor >= stepsTotal) {
    changes.push(buildSucceeded(live, stepsTotal));
    return changes;
  }

  const step = definition.steps[live.stepCursor]!;

  // Control-flow steps need the Notion client / the run row, so they
  // run here in the stepper rather than in steps.ts.
  if (isControlStep(step)) {
    try {
      const ctlChange = await handleControlStep(
        notion,
        live,
        step as ControlStep,
        stepsTotal,
        definition,
      );
      if (ctlChange) changes.push(ctlChange);
    } catch (err) {
      changes.push(
        buildFailed(
          live,
          `Control step ${step.id} failed: ${
            err instanceof Error ? err.message : err
          }`,
        ),
      );
    }

    // External adoption: same dance as for work steps below.
    if (live.status === "pending" && live.stepCursor === 0) {
      await archiveExternal(notion, live.pageId);
    }
    return changes;
  }

  const workStep = step as WorkStep;
  const stepStartedAt = Date.now();
  const output: StepOutput = await executeStep(workStep, live.state, {
    runId: live.runId,
    traceId: live.traceId,
    openaiKey: process.env.OPENAI_API_KEY,
  });
  const stepDurationMs = Date.now() - stepStartedAt;

  console.log(
    `[functionStepper] ${live.functionKey} run=${live.runId} step=${workStep.id} ` +
      `type=${workStep.type} status=${output.status} dur=${stepDurationMs}ms`,
  );

  if (output.status === "ok") {
    live.state.steps[workStep.id] = output;
    const nextCursor = live.stepCursor + 1;
    const completed = nextCursor >= stepsTotal;
    changes.push(
      buildProgress(
        { ...live, stepCursor: nextCursor, attempt: 0 },
        completed ? "succeeded" : "running",
        completed ? null : definition.steps[nextCursor]?.id ?? null,
        stepsTotal,
      ),
    );
  } else {
    const nextAttempt = live.attempt + 1;
    if (nextAttempt >= MAX_ATTEMPTS) {
      changes.push(
        buildFailed(
          live,
          `Step ${workStep.id} failed after ${MAX_ATTEMPTS} attempts: ${output.error}`,
        ),
      );
    } else {
      live.state.steps[workStep.id] = output;
      changes.push(
        buildProgress(
          { ...live, attempt: nextAttempt },
          "running",
          workStep.id,
          stepsTotal,
        ),
      );
    }
  }

  // If this was the externally-created (trigger webhook / event router)
  // row, retire it so the sync upsert's new row becomes the sole row
  // for this runId.
  if (live.status === "pending" && live.stepCursor === 0) {
    await archiveExternal(notion, live.pageId);
  }

  return changes;
}

async function archiveExternal(
  notion: NotionClient,
  pageId: string,
): Promise<void> {
  try {
    await notion.pages.update({
      page_id: pageId,
      archived: true,
    } as never);
  } catch (err) {
    console.warn(
      `[functionStepper] failed to archive external row ${pageId}: ${
        err instanceof Error ? err.message : err
      }`,
    );
  }
}

/* -------------------------------------------------------------------------- */
/* Control-flow steps                                                         */
/* -------------------------------------------------------------------------- */

async function handleControlStep(
  notion: NotionClient,
  live: LiveRun,
  step: ControlStep,
  stepsTotal: number,
  definition: FunctionDefinition,
): Promise<Record<string, unknown> | null> {
  switch (step.type) {
    case "sleepUntil":
      return handleSleepUntil(live, step, stepsTotal, definition);
    case "waitForEvent":
      return handleWaitForEvent(live, step, stepsTotal);
    case "sendEvent":
      return await handleSendEvent(notion, live, step, stepsTotal, definition);
  }
}

function handleSleepUntil(
  live: LiveRun,
  step: SleepUntilStep,
  stepsTotal: number,
  definition: FunctionDefinition,
): Record<string, unknown> {
  const target =
    step.until ??
    new Date(Date.now() + Math.max(0, step.ms ?? 0)).toISOString();
  // If the deadline is already in the past, skip parking and resolve now.
  if (Date.parse(target) <= Date.now()) {
    live.state.steps[step.id] = {
      status: "ok",
      result: { slept: true, until: target },
      durationMs: 0,
    };
    const nextCursor = live.stepCursor + 1;
    const completed = nextCursor >= stepsTotal;
    return buildProgress(
      { ...live, stepCursor: nextCursor, attempt: 0 },
      completed ? "succeeded" : "running",
      completed ? null : definition.steps[nextCursor]?.id ?? null,
      stepsTotal,
    );
  }
  return buildSleeping(live, step.id, target, stepsTotal);
}

function handleWaitForEvent(
  live: LiveRun,
  step: WaitForEventStep,
  stepsTotal: number,
): Record<string, unknown> {
  const wakeAt = step.timeoutMs
    ? new Date(Date.now() + step.timeoutMs).toISOString()
    : null;
  if (step.match) {
    // Interpolate `${state.input...}` (etc.) into the match value at the
    // moment we park, so the comparator stored on the run is the concrete
    // requestId / orderId / etc. we'll actually compare against incoming
    // wake event data.
    let value = step.match.value;
    if (typeof value === "string") {
      value = interpolateString(value, live.state);
    }
    live.state.waitMatch = { path: step.match.path, value };
  } else {
    delete live.state.waitMatch;
  }
  return buildWaiting(live, step.id, step.event, wakeAt, stepsTotal);
}

async function handleSendEvent(
  _notion: NotionClient,
  live: LiveRun,
  step: SendEventStep,
  _stepsTotal: number,
  _definition: FunctionDefinition,
): Promise<Record<string, unknown>> {
  // Cross-run event chaining (sendEvent step → fan-out → wake other runs)
  // is not yet wired in the simplified design. Fail loudly so the run
  // shows up red in Notion instead of silently stalling.
  return buildFailed(
    live,
    `sendEvent step ${step.id} (event="${step.event}"): not yet supported. ` +
      `Send events from outside the worker via the sendEvent webhook instead.`,
  );
}

/* -------------------------------------------------------------------------- */
/* Reading                                                                    */
/* -------------------------------------------------------------------------- */

/** Pull recent `signal`-typed rows from Tracer · Events. These are the
 *  wake rows written by the `sendEvent` webhook. Bounded by
 *  MAX_WAKES_PER_TICK so a flood of unmatched events doesn't blow up a
 *  single tick. Sorted by `At` ascending so older wakes get a chance to
 *  be consumed before newer ones (FIFO). */
async function fetchRecentWakes(
  notion: NotionClient,
  eventsDb: string,
): Promise<PendingWake[]> {
  const out: PendingWake[] = [];
  const res = await notion.databases.query({
    database_id: eventsDb,
    filter: { property: "Type", select: { equals: "signal" } },
    page_size: MAX_WAKES_PER_TICK,
    sorts: [{ property: "At", direction: "ascending" }],
  });
  for (const row of res.results) {
    if (!("properties" in row)) continue;
    const r = row as {
      id: string;
      archived?: boolean;
      in_trash?: boolean;
      properties: Record<string, unknown>;
      created_time?: string;
    };
    if (r.archived || r.in_trash) continue;
    const wakeId = getRichText(r.properties, "Event ID");
    const eventName = getRichText(r.properties, "Category");
    if (!wakeId || !eventName) continue;
    const eventId = getRichText(r.properties, "Summary");
    const dataJson = getRichText(r.properties, "Detail");
    let data: unknown = {};
    if (dataJson) {
      try {
        data = JSON.parse(dataJson);
      } catch {
        data = {};
      }
    }
    const createdAt = r.created_time ? Date.parse(r.created_time) : Date.now();
    out.push({
      pageId: r.id,
      wakeId,
      eventName,
      eventId: eventId ?? "",
      data,
      createdAt,
    });
  }
  return out;
}

function lookupPath(obj: unknown, path: string): unknown {
  if (!path) return obj;
  const parts = path.split(".");
  let cur: unknown = obj;
  for (const part of parts) {
    if (cur && typeof cur === "object") {
      cur = (cur as Record<string, unknown>)[part];
    } else {
      return undefined;
    }
  }
  return cur;
}

function matchValueLoose(
  a: unknown,
  b: string | number | boolean,
): boolean {
  if (a === b) return true;
  if (typeof a === "string" || typeof b === "string") {
    return String(a) === String(b);
  }
  return false;
}

function readLiveRun(
  pageId: string,
  props: Record<string, unknown>,
): LiveRun {
  const stateJson = getRichText(props, "Run State");
  let state: LiveRun["state"] = { input: {}, steps: {} };
  if (stateJson) {
    try {
      const parsed = JSON.parse(stateJson) as Partial<RunState> & {
        rootSpanId?: string;
        waitMatch?: { path: string; value: string | number | boolean };
        sourceEventId?: string;
      };
      state = {
        input: parsed.input ?? {},
        steps: parsed.steps ?? {},
        ...(parsed.rootSpanId ? { rootSpanId: parsed.rootSpanId } : {}),
        ...(parsed.waitMatch ? { waitMatch: parsed.waitMatch } : {}),
        ...(parsed.sourceEventId
          ? { sourceEventId: parsed.sourceEventId }
          : {}),
      };
    } catch {
      // keep default
    }
  }

  return {
    pageId,
    runId: getRichText(props, "Run ID"),
    name: extractTitle(props) || getRichText(props, "Run ID"),
    functionPageId: getRelation(props, "Function")[0] ?? null,
    functionKey: "",
    sandboxKey: null,
    traceId: getRichText(props, "Trace ID") || randHex(16),
    status: (getSelect(props, "Status") ?? "pending") as Status,
    stepCursor: getNumber(props, "Step Cursor") ?? 0,
    attempt: getNumber(props, "Attempt") ?? 0,
    inputJson: getRichText(props, "Input") || "{}",
    startedAt: getDateStart(props, "Started At"),
    currentStepId: getRichText(props, "Current Step") || null,
    sleepUntil: getDateStart(props, "Sleep Until"),
    waitingForEvent: getRichText(props, "Waiting For Event") || null,
    wakeAt: getDateStart(props, "Wake At"),
    sourceEventId: getRichText(props, "Source Event ID") || null,
    state,
  };
}

function extractTitle(props: Record<string, unknown>): string {
  const t = props["Name"] as { title?: Array<{ plain_text?: string }> } | undefined;
  if (!t?.title) return "";
  return t.title.map((x) => x.plain_text ?? "").join("");
}

function getDateStart(
  props: Record<string, unknown>,
  key: string,
): string | null {
  const v = props[key] as { date?: { start?: string } } | undefined;
  return v?.date?.start ?? null;
}

async function loadFunctionDefinition(
  notion: NotionClient,
  live: LiveRun,
): Promise<FunctionDefinition> {
  if (!live.functionPageId) {
    throw new Error("Run row has no Function relation.");
  }
  const fnPage = await notion.pages.retrieve({ page_id: live.functionPageId });
  if (!("properties" in fnPage)) {
    throw new Error("Function page has no properties.");
  }
  const fnProps = (fnPage as { properties: Record<string, unknown> }).properties;
  const defText = getRichText(fnProps, "Definition");
  if (!defText) {
    throw new Error("Function has empty Definition.");
  }
  live.functionKey = getRichText(fnProps, "Function Key") || "";
  // Try to resolve sandbox key from the function's Sandbox relation.
  const sandboxRel = getRelation(fnProps, "Sandbox")[0];
  if (sandboxRel) {
    try {
      const sbxPage = await notion.pages.retrieve({ page_id: sandboxRel });
      if ("properties" in sbxPage) {
        const sbxProps = (sbxPage as { properties: Record<string, unknown> })
          .properties;
        live.sandboxKey = getRichText(sbxProps, "Sandbox Key") || null;
      }
    } catch {
      // optional
    }
  }
  return JSON.parse(defText) as FunctionDefinition;
}

/* -------------------------------------------------------------------------- */
/* SyncChange builders                                                        */
/* -------------------------------------------------------------------------- */

function basePropsFor(live: LiveRun): RunChangeProps {
  const props: RunChangeProps = {
    Name: Builder.title(live.runId),
    "Run ID": Builder.richText(live.runId),
    "Trace ID": Builder.richText(live.traceId),
    Input: Builder.richText(live.inputJson),
  };
  if (live.functionKey) {
    props["Function"] = [Builder.relation(live.functionKey)];
  }
  if (live.sandboxKey) {
    props["Sandbox"] = [Builder.relation(live.sandboxKey)];
  }
  if (live.startedAt) {
    props["Started At"] = Builder.dateTime(live.startedAt);
  } else {
    props["Started At"] = Builder.dateTime(new Date().toISOString());
  }
  if (live.sourceEventId) {
    props["Source Event ID"] = Builder.richText(live.sourceEventId);
  }
  return props;
}

function buildProgress(
  live: LiveRun,
  nextStatus: "running" | "succeeded",
  currentStepId: string | null,
  stepCount: number,
): Record<string, unknown> {
  const stateJson = truncate(safeStringify(live.state));
  const props: RunChangeProps = {
    ...basePropsFor(live),
    Status: Builder.select(nextStatus),
    "Step Cursor": Builder.number(live.stepCursor),
    "Step Count": Builder.number(stepCount),
    Attempt: Builder.number(live.attempt),
    "Run State": Builder.richText(stateJson),
  };
  if (currentStepId) {
    props["Current Step"] = Builder.richText(currentStepId);
  }
  if (nextStatus === "succeeded") {
    props["Ended At"] = Builder.dateTime(new Date().toISOString());
    props["Output"] = Builder.richText(
      truncate(safeStringify(live.state.steps)),
    );
  }
  return {
    type: "upsert",
    key: live.runId,
    properties: props,
  };
}

function buildSucceeded(live: LiveRun, stepCount: number): Record<string, unknown> {
  return {
    type: "upsert",
    key: live.runId,
    properties: {
      ...basePropsFor(live),
      Status: Builder.select("succeeded"),
      "Step Cursor": Builder.number(live.stepCursor),
      "Step Count": Builder.number(stepCount),
      Attempt: Builder.number(live.attempt),
      "Run State": Builder.richText(truncate(safeStringify(live.state))),
      "Ended At": Builder.dateTime(new Date().toISOString()),
      Output: Builder.richText(truncate(safeStringify(live.state.steps))),
    },
  };
}

function buildFailed(live: LiveRun, error: string): Record<string, unknown> {
  return {
    type: "upsert",
    key: live.runId,
    properties: {
      ...basePropsFor(live),
      Status: Builder.select("failed"),
      "Step Cursor": Builder.number(live.stepCursor),
      Attempt: Builder.number(live.attempt),
      "Run State": Builder.richText(truncate(safeStringify(live.state))),
      "Ended At": Builder.dateTime(new Date().toISOString()),
      Error: Builder.richText(truncate(error)),
    },
  };
}

function buildSleeping(
  live: LiveRun,
  stepId: string,
  sleepUntil: string,
  stepCount: number,
): Record<string, unknown> {
  return {
    type: "upsert",
    key: live.runId,
    properties: {
      ...basePropsFor(live),
      Status: Builder.select("sleeping"),
      "Step Cursor": Builder.number(live.stepCursor),
      "Step Count": Builder.number(stepCount),
      "Current Step": Builder.richText(stepId),
      Attempt: Builder.number(live.attempt),
      "Run State": Builder.richText(truncate(safeStringify(live.state))),
      "Sleep Until": Builder.dateTime(sleepUntil),
    },
  };
}

function buildWaiting(
  live: LiveRun,
  stepId: string,
  eventName: string,
  wakeAt: string | null,
  stepCount: number,
): Record<string, unknown> {
  const props: RunChangeProps = {
    ...basePropsFor(live),
    Status: Builder.select("waiting"),
    "Step Cursor": Builder.number(live.stepCursor),
    "Step Count": Builder.number(stepCount),
    "Current Step": Builder.richText(stepId),
    Attempt: Builder.number(live.attempt),
    "Run State": Builder.richText(truncate(safeStringify(live.state))),
    "Waiting For Event": Builder.richText(eventName),
  };
  if (wakeAt) {
    props["Wake At"] = Builder.dateTime(wakeAt);
  }
  return {
    type: "upsert",
    key: live.runId,
    properties: props,
  };
}
