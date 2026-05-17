/**
 * Workflow runtime types.
 *
 * A "function" is a JSON document stored in the `Functions · Catalog`
 * Notion database. Each row's `Definition` cell holds a serialized
 * `FunctionDefinition`. The `functionStepper` sync executes one step per
 * tick per active run, persisting `RunState` between ticks so the engine
 * is fully crash-safe (Notion is the durable store).
 *
 * Step types in v1:
 *   - work steps (executed in `steps.ts`):
 *       http, llm, delay
 *   - control-flow steps (handled inline by the stepper because they need
 *     access to Notion / the run row):
 *       sleepUntil, waitForEvent, sendEvent
 *
 * Add more by extending `Step` and registering a handler in the right place.
 */

export type StepType =
  | "http"
  | "llm"
  | "delay"
  | "sleepUntil"
  | "waitForEvent"
  | "sendEvent";

export interface BaseStep {
  /** Stable id within this function. Used as a key in `state[stepId]`. */
  id: string;
  type: StepType;
}

export interface HttpStep extends BaseStep {
  type: "http";
  url: string;
  method?: "GET" | "POST" | "PUT" | "DELETE" | "PATCH";
  /** JSON-stringifiable body; will be `JSON.stringify`ed automatically. */
  body?: unknown;
  headers?: Record<string, string>;
  /** Per-request timeout. Default 15 000 ms. */
  timeoutMs?: number;
}

export interface LlmStep extends BaseStep {
  type: "llm";
  /** OpenAI model name. Other providers in a later patch. */
  model: string;
  /** May reference earlier-step state via `${state.<stepId>.<field>}`. */
  prompt: string;
  /** Optional system message. */
  system?: string;
  /** Max tokens for completion. Default 512. */
  maxTokens?: number;
  /** Default 0. */
  temperature?: number;
}

export interface DelayStep extends BaseStep {
  type: "delay";
  ms: number;
}

/**
 * Durable wall-clock sleep. Stepper parks the run in `sleeping` status
 * with `Sleep Until` set; subsequent ticks ignore it until that time.
 *
 * One of `ms` or `until` must be supplied. `until` is an ISO timestamp.
 * `ms` is added to "now" at the moment the step is reached.
 */
export interface SleepUntilStep extends BaseStep {
  type: "sleepUntil";
  ms?: number;
  until?: string;
}

/**
 * Park the run until a matching event arrives (Inngest's
 * `step.waitForEvent`).
 *
 * The event router fires this step's result when an event row with
 * `Event Name = event` is observed. If `match` is supplied, the event's
 * `Data` JSON is filtered:
 *   - `match.path` = dotted path into the event data (e.g. "order.id")
 *   - `match.value` = literal value to compare (string/number/boolean)
 *
 * If `timeoutMs` is supplied and elapses with no match, the step
 * completes with `result = { timedOut: true }` and the function
 * continues.
 */
export interface WaitForEventStep extends BaseStep {
  type: "waitForEvent";
  event: string;
  timeoutMs?: number;
  match?: { path: string; value: string | number | boolean };
}

/**
 * Emit a new event from within a function. Equivalent to calling
 * `tracer.sendEvent(...)` from user code, but runs in the worker so it
 * doesn't depend on caller availability. `data` may interpolate prior
 * step results via `${state.x.y}` like other steps.
 */
export interface SendEventStep extends BaseStep {
  type: "sendEvent";
  event: string;
  data?: Record<string, unknown>;
  /** Optional idempotency key for the emitted event. */
  idempotencyKey?: string;
}

export type Step =
  | HttpStep
  | LlmStep
  | DelayStep
  | SleepUntilStep
  | WaitForEventStep
  | SendEventStep;

export type WorkStep = HttpStep | LlmStep | DelayStep;
export type ControlStep = SleepUntilStep | WaitForEventStep | SendEventStep;

export function isControlStep(step: Step): step is ControlStep {
  return (
    step.type === "sleepUntil" ||
    step.type === "waitForEvent" ||
    step.type === "sendEvent"
  );
}

export interface FunctionDefinition {
  /** Optional schema description for the input passed at trigger time. */
  inputSchema?: Record<string, unknown>;
  steps: Step[];
}

/**
 * State persisted between stepper ticks on the FunctionRuns row.
 *
 * Trimmed to fit in Notion's per-fragment rich_text cap (~1800 chars after
 * truncation). For larger state, callers should write to a sidecar file
 * attachment (Phase 4.5 follow-up).
 */
export interface RunState {
  /** Original input to the function. */
  input: Record<string, unknown>;
  /** Output of each step, keyed by step id. */
  steps: Record<string, StepOutput>;
}

export interface StepOutput {
  status: "ok" | "error";
  /** Step-type-specific result body. Truncated if too large. */
  result?: unknown;
  /** Error message if status=error. */
  error?: string;
  /** ms elapsed inside the step's own work (not the tick boundary). */
  durationMs: number;
}

export interface RunRow {
  pageId: string;
  runId: string;
  functionKey: string;
  sandboxKey: string | null;
  traceId: string;
  status: "pending" | "running" | "sleeping" | "waiting" | "succeeded" | "failed" | "cancelled";
  stepCursor: number;
  attempt: number;
  state: RunState;
}

export interface StepExecutionContext {
  runId: string;
  traceId: string;
  /** OpenAI key from worker env. May be undefined if the LLM step isn't used. */
  openaiKey: string | undefined;
}
