/**
 * Step executors for the workflow runtime.
 *
 * Each executor receives the resolved step (after `${state.x.y}` interpolation)
 * and the current `StepExecutionContext`, and returns a `StepOutput`. The
 * stepper sync wraps each call with the execution span + retry bookkeeping;
 * executors only need to *do the work* and report `ok`/`error`.
 */

import type {
  HttpStep,
  LlmStep,
  DelayStep,
  Step,
  StepExecutionContext,
  StepOutput,
  RunState,
  WorkStep,
} from "./types.js";

const MAX_RESULT_BYTES = 16 * 1024; // 16 KB raw result bytes captured per step

export async function executeStep(
  step: WorkStep,
  state: RunState,
  ctx: StepExecutionContext,
): Promise<StepOutput> {
  const startedAt = Date.now();
  try {
    const resolved = interpolateStep(step, state) as WorkStep;
    switch (resolved.type) {
      case "http":
        return await runHttp(resolved, startedAt);
      case "llm":
        return await runLlm(resolved, ctx, startedAt);
      case "delay":
        return await runDelay(resolved, startedAt);
    }
  } catch (err) {
    return {
      status: "error",
      error: err instanceof Error ? err.message : String(err),
      durationMs: Date.now() - startedAt,
    };
  }
}

/* -------------------------------------------------------------------------- */
/* http                                                                       */
/* -------------------------------------------------------------------------- */

async function runHttp(step: HttpStep, startedAt: number): Promise<StepOutput> {
  const method = step.method ?? "GET";
  const timeoutMs = step.timeoutMs ?? 15_000;
  const ac = new AbortController();
  const t = setTimeout(() => ac.abort(), timeoutMs);
  try {
    const res = await fetch(step.url, {
      method,
      headers: {
        ...(step.body !== undefined ? { "content-type": "application/json" } : {}),
        ...(step.headers ?? {}),
      },
      body: step.body !== undefined ? JSON.stringify(step.body) : undefined,
      signal: ac.signal,
    });
    const text = await readWithLimit(res, MAX_RESULT_BYTES);
    const ok = res.status >= 200 && res.status < 300;
    return {
      status: ok ? "ok" : "error",
      durationMs: Date.now() - startedAt,
      result: { status: res.status, ok, body: text },
      ...(ok ? {} : { error: `HTTP ${res.status}` }),
    };
  } finally {
    clearTimeout(t);
  }
}

async function readWithLimit(res: Response, limit: number): Promise<string> {
  const text = await res.text();
  if (text.length <= limit) return text;
  return text.slice(0, limit) + ` ... [+${text.length - limit} bytes]`;
}

/* -------------------------------------------------------------------------- */
/* llm                                                                        */
/* -------------------------------------------------------------------------- */

interface OpenAIResponse {
  choices: Array<{ message: { content: string } }>;
  usage: { prompt_tokens: number; completion_tokens: number };
  model: string;
}

async function runLlm(
  step: LlmStep,
  ctx: StepExecutionContext,
  startedAt: number,
): Promise<StepOutput> {
  if (!ctx.openaiKey) {
    return {
      status: "error",
      error: "OPENAI_API_KEY not set on the worker — cannot run llm step.",
      durationMs: Date.now() - startedAt,
    };
  }

  const messages: Array<{ role: "system" | "user"; content: string }> = [];
  if (step.system) messages.push({ role: "system", content: step.system });
  messages.push({ role: "user", content: step.prompt });

  const res = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${ctx.openaiKey}`,
    },
    body: JSON.stringify({
      model: step.model,
      messages,
      max_tokens: step.maxTokens ?? 512,
      temperature: step.temperature ?? 0,
    }),
  });

  if (!res.ok) {
    return {
      status: "error",
      error: `OpenAI ${res.status}: ${await res.text()}`,
      durationMs: Date.now() - startedAt,
    };
  }

  const json = (await res.json()) as OpenAIResponse;
  const content = json.choices[0]?.message.content ?? "";
  return {
    status: "ok",
    durationMs: Date.now() - startedAt,
    result: {
      content,
      model: json.model,
      promptTokens: json.usage.prompt_tokens,
      completionTokens: json.usage.completion_tokens,
      totalTokens: json.usage.prompt_tokens + json.usage.completion_tokens,
    },
  };
}

/* -------------------------------------------------------------------------- */
/* delay                                                                      */
/* -------------------------------------------------------------------------- */

async function runDelay(step: DelayStep, startedAt: number): Promise<StepOutput> {
  const ms = Math.max(0, Math.min(step.ms, 60_000)); // clamp to 1 min
  await new Promise((r) => setTimeout(r, ms));
  return {
    status: "ok",
    durationMs: Date.now() - startedAt,
    result: { waited: ms },
  };
}

/* -------------------------------------------------------------------------- */
/* `${state.x.y}` interpolation                                               */
/* -------------------------------------------------------------------------- */

const TEMPLATE_RE = /\$\{state\.([a-zA-Z0-9_.-]+)\}/g;

export function interpolateStep(step: Step, state: RunState): Step {
  const replaced = JSON.parse(JSON.stringify(step)) as Step;
  walk(replaced, state);
  return replaced;
}

function walk(node: unknown, state: RunState): void {
  if (typeof node === "string") return; // strings replaced in their containing object below
  if (Array.isArray(node)) {
    for (let i = 0; i < node.length; i++) {
      if (typeof node[i] === "string") {
        node[i] = interpolateString(node[i] as string, state);
      } else {
        walk(node[i], state);
      }
    }
    return;
  }
  if (node && typeof node === "object") {
    const obj = node as Record<string, unknown>;
    for (const k of Object.keys(obj)) {
      const v = obj[k];
      if (typeof v === "string") {
        obj[k] = interpolateString(v, state);
      } else {
        walk(v, state);
      }
    }
  }
}

export function interpolateString(s: string, state: RunState): string {
  return s.replace(TEMPLATE_RE, (_, path: string) => {
    const v = lookup(state, path);
    if (v === undefined) return ""; // missing → empty string
    return typeof v === "string" ? v : JSON.stringify(v);
  });
}

function lookup(state: RunState, path: string): unknown {
  // path like "fetch.body" or "fetch.result.status" or "input.userId"
  const segments = path.split(".");
  let cur: unknown = path.startsWith("input")
    ? { input: state.input }
    : { ...state.steps, input: state.input };
  // The first segment is either a step id or "input"; everything after is
  // a dotted path into that step's result object. We treat step outputs as
  // their `.result` for ergonomics: `${state.fetch.body}` means
  // `state.steps.fetch.result.body`.
  for (let i = 0; i < segments.length; i++) {
    const seg = segments[i]!;
    if (cur == null || typeof cur !== "object") return undefined;
    cur = (cur as Record<string, unknown>)[seg];
    // After the first segment (step id) auto-descend into `.result` if the
    // value looks like a StepOutput (has `status` + `result`).
    if (
      i === 0 &&
      cur &&
      typeof cur === "object" &&
      "status" in (cur as object) &&
      "result" in (cur as object)
    ) {
      cur = (cur as { result: unknown }).result;
    }
  }
  return cur;
}
