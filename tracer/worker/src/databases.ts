/**
 * Tracer database schemas.
 *
 * Each database is `type: "managed"` so Notion owns the schema; ingest writes
 * via `context.notion` page create/update. Primary keys are stable string
 * IDs so re-ingest is idempotent (upsert by key).
 *
 * Phase 0: Traces, Spans.
 * Phase 1: Sessions, LLM Calls, Tool Calls, Events.
 *
 * Two-way relations are wired so users browsing Notion can navigate
 * Session → Traces, Trace → Spans / LLM Calls / Tool Calls / Events.
 *
 * Property names use Title Case + spaces (Notion convention). Primary key
 * property names exactly match `primaryKeyProperty` and queries.
 */

import type { Worker } from "@notionhq/workers";
import * as Schema from "@notionhq/workers/schema";

export function declareDatabases(worker: Worker) {
  const sessions = worker.database("sessions", {
    type: "managed",
    initialTitle: "Tracer · Sessions",
    primaryKeyProperty: "Session ID",
    schema: {
      properties: {
        Name: Schema.title(),
        "Session ID": Schema.richText(),
        "User ID": Schema.richText(),
        "Started At": Schema.date(),
        "Last Seen At": Schema.date(),
        "Trace Count": Schema.number(),
      },
    },
  });

  const traces = worker.database("traces", {
    type: "managed",
    initialTitle: "Tracer · Traces",
    primaryKeyProperty: "Trace ID",
    schema: {
      properties: {
        Name: Schema.title(),
        "Trace ID": Schema.richText(),
        "Root Span Name": Schema.richText(),
        Status: Schema.select([
          { name: "ok", color: "green" },
          { name: "error", color: "red" },
          { name: "running", color: "blue" },
        ]),
        "Started At": Schema.date(),
        "Ended At": Schema.date(),
        "Duration (ms)": Schema.number(),
        "Span Count": Schema.number(),
        "Error Count": Schema.number(),
        "Total Tokens": Schema.number(),
        "Cost (USD)": Schema.number(),
        Service: Schema.richText(),
        "Session ID": Schema.richText(),
        Session: Schema.relation("sessions", {
          twoWay: true,
          relatedPropertyName: "Traces",
        }),
        Tags: Schema.multiSelect([
          // Empty options list; users can add freely from the Notion UI.
          // Pre-seeding a few common tags makes them discoverable.
          { name: "prod", color: "green" },
          { name: "dev", color: "gray" },
          { name: "eval", color: "purple" },
        ]),
      },
    },
  });

  const spans = worker.database("spans", {
    type: "managed",
    initialTitle: "Tracer · Spans",
    primaryKeyProperty: "Span ID",
    schema: {
      properties: {
        Name: Schema.title(),
        "Span ID": Schema.richText(),
        "Trace ID": Schema.richText(),
        Trace: Schema.relation("traces", {
          twoWay: true,
          relatedPropertyName: "Spans",
        }),
        "Parent Span ID": Schema.richText(),
        Kind: Schema.select([
          { name: "internal", color: "default" },
          { name: "llm", color: "purple" },
          { name: "tool", color: "blue" },
          { name: "http", color: "yellow" },
          { name: "db", color: "orange" },
          { name: "agent", color: "pink" },
          { name: "other", color: "gray" },
        ]),
        Status: Schema.select([
          { name: "ok", color: "green" },
          { name: "error", color: "red" },
          { name: "unset", color: "gray" },
        ]),
        "Started At": Schema.date(),
        "Ended At": Schema.date(),
        "Duration (ms)": Schema.number(),
        Attributes: Schema.richText(),
        Events: Schema.richText(),
        "Error Message": Schema.richText(),
      },
    },
  });

  const llmCalls = worker.database("llmCalls", {
    type: "managed",
    initialTitle: "Tracer · LLM Calls",
    primaryKeyProperty: "Span ID",
    schema: {
      properties: {
        Name: Schema.title(),
        "Span ID": Schema.richText(),
        "Trace ID": Schema.richText(),
        Trace: Schema.relation("traces", {
          twoWay: true,
          relatedPropertyName: "LLM Calls",
        }),
        Provider: Schema.select([
          { name: "openai", color: "green" },
          { name: "anthropic", color: "orange" },
          { name: "google", color: "blue" },
          { name: "azure", color: "purple" },
          { name: "other", color: "gray" },
        ]),
        Model: Schema.richText(),
        "Prompt Tokens": Schema.number(),
        "Completion Tokens": Schema.number(),
        "Total Tokens": Schema.number(),
        "Cost (USD)": Schema.number(),
        "Latency (ms)": Schema.number(),
        Prompt: Schema.richText(),
        Completion: Schema.richText(),
        Status: Schema.select([
          { name: "ok", color: "green" },
          { name: "error", color: "red" },
        ]),
      },
    },
  });

  const toolCalls = worker.database("toolCalls", {
    type: "managed",
    initialTitle: "Tracer · Tool Calls",
    primaryKeyProperty: "Span ID",
    schema: {
      properties: {
        Name: Schema.title(),
        "Span ID": Schema.richText(),
        "Trace ID": Schema.richText(),
        Trace: Schema.relation("traces", {
          twoWay: true,
          relatedPropertyName: "Tool Calls",
        }),
        "Tool Name": Schema.richText(),
        Args: Schema.richText(),
        Result: Schema.richText(),
        Status: Schema.select([
          { name: "ok", color: "green" },
          { name: "error", color: "red" },
        ]),
        "Latency (ms)": Schema.number(),
      },
    },
  });

  const events = worker.database("events", {
    type: "managed",
    initialTitle: "Tracer · Events",
    primaryKeyProperty: "Event ID",
    schema: {
      properties: {
        Name: Schema.title(),
        "Event ID": Schema.richText(),
        "Trace ID": Schema.richText(),
        Trace: Schema.relation("traces", {
          twoWay: true,
          relatedPropertyName: "Events",
        }),
        "Span ID": Schema.richText(),
        Type: Schema.select([
          { name: "error", color: "red" },
          { name: "feedback", color: "purple" },
          { name: "signal", color: "blue" },
          { name: "note", color: "gray" },
        ]),
        Severity: Schema.select([
          { name: "info", color: "blue" },
          { name: "warn", color: "yellow" },
          { name: "error", color: "red" },
        ]),
        Category: Schema.richText(),
        Summary: Schema.richText(),
        Detail: Schema.richText(),
        At: Schema.date(),
      },
    },
  });

  /* ----------------------------------------------------------------------- */
  /* Workflow runtime (Functions / Sandboxes / Function Runs)                */
  /* ----------------------------------------------------------------------- */

  const sandboxes = worker.database("sandboxes", {
    type: "managed",
    initialTitle: "Functions · Sandboxes",
    primaryKeyProperty: "Sandbox Key",
    schema: {
      properties: {
        Name: Schema.title(),
        "Sandbox Key": Schema.richText(),
        Description: Schema.richText(),
        Environment: Schema.select([
          { name: "prod", color: "red" },
          { name: "staging", color: "yellow" },
          { name: "dev", color: "green" },
        ]),
        "Allowed Hosts": Schema.richText(),
        "Max Concurrent Runs": Schema.number(),
        Active: Schema.checkbox(),
      },
    },
  });

  const functions = worker.database("functions", {
    type: "managed",
    initialTitle: "Functions · Catalog",
    primaryKeyProperty: "Function Key",
    schema: {
      properties: {
        Name: Schema.title(),
        "Function Key": Schema.richText(),
        Description: Schema.richText(),
        Sandbox: Schema.relation("sandboxes", {
          twoWay: true,
          relatedPropertyName: "Functions",
        }),
        Trigger: Schema.select([
          { name: "manual", color: "default" },
          { name: "webhook", color: "blue" },
          { name: "event", color: "green" },
          { name: "schedule", color: "purple" },
        ]),
        // Inngest-style event binding. If `Trigger = "event"`, this is the
        // event name the function listens for. Supports an exact match
        // (e.g. `user.signup`) or a `*` wildcard suffix (e.g. `user.*`).
        // Multiple functions can listen to the same event — each gets its
        // own run.
        "Event Name": Schema.richText(),
        Definition: Schema.richText(),
        Enabled: Schema.checkbox(),
        "Last Run At": Schema.date(),
        "Run Count": Schema.number(),
        "Failure Count": Schema.number(),
      },
    },
  });

  const functionRuns = worker.database("functionRuns", {
    type: "managed",
    initialTitle: "Functions · Runs",
    // The trigger webhook creates rows here via pages.create (external
    // rows). The functionStepper sync queries those external rows on its
    // next tick, archives them via pages.update({archived:true}), and emits
    // a SyncChange upsert with the same Run ID. That upsert creates a
    // sync-tracked row that the stepper can subsequently advance on every
    // tick. This dance is needed because the Notion Workers framework does
    // NOT auto-adopt externally-created rows into sync upsert tracking,
    // and pages.update with property writes is rejected on sync-owned DBs.
    primaryKeyProperty: "Run ID",
    schema: {
      properties: {
        Name: Schema.title(),
        "Run ID": Schema.richText(),
        Function: Schema.relation("functions", {
          twoWay: true,
          relatedPropertyName: "Runs",
        }),
        Sandbox: Schema.relation("sandboxes", {
          twoWay: true,
          relatedPropertyName: "Runs",
        }),
        "Trace ID": Schema.richText(),
        Trace: Schema.relation("traces", {
          twoWay: true,
          relatedPropertyName: "Function Run",
        }),
        Status: Schema.select([
          { name: "pending", color: "gray" },
          { name: "running", color: "blue" },
          { name: "sleeping", color: "purple" },
          { name: "waiting", color: "yellow" },
          { name: "succeeded", color: "green" },
          { name: "failed", color: "red" },
          { name: "cancelled", color: "orange" },
        ]),
        "Step Cursor": Schema.number(),
        "Step Count": Schema.number(),
        "Current Step": Schema.richText(),
        Attempt: Schema.number(),
        Input: Schema.richText(),
        "Run State": Schema.richText(),
        Output: Schema.richText(),
        Error: Schema.richText(),
        "Started At": Schema.date(),
        "Ended At": Schema.date(),
        "Duration (ms)": Schema.number(),
        // Set when the run is parked in `sleeping` status; stepper resumes
        // once `now >= Sleep Until`.
        "Sleep Until": Schema.date(),
        // Set when the run is parked in `waiting` status; cleared once the
        // event arrives. Matched verbatim against incoming event names.
        "Waiting For Event": Schema.richText(),
        // Optional timeout deadline for a `waitForEvent` step. If set and
        // the time passes without a match, the wait resolves with no event
        // payload and the step completes (state.<stepId>.result = null).
        "Wake At": Schema.date(),
        // Event ID of the event that fanned this run out (null for runs
        // started via the manual triggerFunction webhook).
        "Source Event ID": Schema.richText(),
      },
    },
  });

  /* ----------------------------------------------------------------------- */
  /* Wakes — ephemeral event delivery for event-driven waitForEvent          */
  /* ----------------------------------------------------------------------- */
  //
  // The `sendEvent` webhook writes one row here per incoming event. The
  // `functionStepper` reads recent wakes on each tick, matches them
  // against `waiting` runs (by event name + optional waitMatch filter on
  // the event's Data JSON), advances each matched run past its
  // `waitForEvent` step, and archives the consumed wake row. Wakes that
  // don't match any waiter expire via a TTL (archived after WAKE_TTL_MS).
  const wakes = worker.database("wakes", {
    type: "managed",
    initialTitle: "Functions · Wakes",
    primaryKeyProperty: "Wake ID",
    schema: {
      properties: {
        Name: Schema.title(),
        "Wake ID": Schema.richText(),
        "Event Name": Schema.richText(),
        "Event ID": Schema.richText(),
        "Event Data": Schema.richText(),
        "Created At": Schema.date(),
      },
    },
  });

  return {
    sessions,
    traces,
    spans,
    llmCalls,
    toolCalls,
    events,
    sandboxes,
    functions,
    functionRuns,
    wakes,
  };
}

export type Databases = ReturnType<typeof declareDatabases>;
