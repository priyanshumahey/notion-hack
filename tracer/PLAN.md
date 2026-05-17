# Tracer — Agent Tracing on Notion Workers

> An Inngest/Temporal-style workflow + Laminar-style trace product, hosted as a
> single Notion Worker. Trace data lives in managed Notion databases. Notion
> Custom Agents read and analyse those traces through a set of worker tools.

---

## 1. Vision

A developer building an LLM agent:

1. `npm install @notion-tracer/client`
2. Wraps their agent run with `tracer.span("agent.run", async (s) => ...)`
3. Spans (LLM calls, tool calls, errors) are POSTed in HMAC-signed batches to
   their **own** Notion Worker's ingest webhook.
4. The worker upserts those spans into Notion databases inside their workspace.
5. They open Notion, see a Traces database that looks like a flight recorder.
6. They ask Notion AI: *"Why did trace `t_abc123` fail?"* — a worker tool fetches
   the trace tree and returns it as structured context so the agent can answer.

The differentiator is **(6)**. Trace data in Notion + Notion AI is a real
debugging experience nobody else ships.

## 2. Non-goals

- **No customer-hosted code execution.** A Notion Worker can only run its own
  code; we cannot offer "register your TypeScript function and we'll run it
  durably" the way Inngest does. Customer agents run wherever they already
  run; we ingest spans from them.
- **No sub-second live dashboards.** Notion DB writes have latency. Targeting
  "minutes-fresh" rollups, not real-time SRE dashboards.
- **No browser session replay.** No blob/video store in scope.
- **Not multi-tenant SaaS.** Each customer deploys their own copy of the worker
  into their own Notion workspace. The product is distributed as a template.

## 3. System overview

```
  ┌───────────────────────────┐         ┌────────────────────────────────────┐
  │  Customer agent process   │         │           Notion Worker            │
  │                           │  HTTPS  │                                    │
  │  @notion-tracer/client    │ ──────► │  webhook("ingest")                 │
  │   ├ tracer.span(...)      │  HMAC   │     ├ verify HMAC                  │
  │   ├ tracer.llm(...)       │ batch   │     ├ idempotent upsert            │
  │   └ flushes on shutdown   │         │     └ writes to managed DBs ──┐    │
  └───────────────────────────┘         │                               │    │
                                        │  tool("getTrace") ◄── Notion  │    │
                                        │  tool("findTraces")   Custom  │    │
                                        │  tool("summarizeTrace") Agent │    │
                                        │  tool("explainError")         │    │
                                        │                               │    │
                                        │  sync("costRollup")           │    │
                                        │  sync("errorClassifier")      │    │
                                        │  sync("p95LatencyDaily")      │    │
                                        └───────────────────────────────┼────┘
                                                                        │
                                        ┌───────────────────────────────▼────┐
                                        │       Notion managed databases     │
                                        │  Sessions · Traces · Spans         │
                                        │  LLM Calls · Tool Calls · Events   │
                                        │  Workflows · Workflow Runs         │
                                        │  Rollups: Cost/Day, Errors/Day     │
                                        └────────────────────────────────────┘
```

## 4. Data model

All databases use `type: "managed"` and have a stable string `primaryKeyProperty`
so re-ingest is idempotent.

### 4.1 Sessions
| Property | Type | Notes |
|---|---|---|
| Name | title | User-friendly, e.g. "user@x.com / 2026-05-16T14:22" |
| Session ID | richText (PK) | Customer-supplied; e.g. `s_...` |
| User ID | richText | Optional |
| Started At | date | First seen |
| Last Seen At | date | Updated by ingest |
| Trace Count | number | Maintained by `sync("sessionStats")` |

### 4.2 Traces
| Property | Type | Notes |
|---|---|---|
| Name | title | Root span name + short trace id |
| Trace ID | richText (PK) | OTel trace_id (32 hex) or short `t_...` |
| Session | relation → Sessions | twoWay, prop "Traces" |
| Root Span Name | richText | |
| Status | select | ok / error / running |
| Started At | date | |
| Ended At | date | |
| Duration (ms) | number | |
| Span Count | number | |
| Error Count | number | |
| Total Tokens | number | sum across all LLM spans |
| Cost (USD) | number | sum across all LLM spans |
| Tags | multi_select | Free-form; e.g. `prod`, `eval-set-42` |

### 4.3 Spans
| Property | Type | Notes |
|---|---|---|
| Name | title | `{span.name} · {short id}` |
| Span ID | richText (PK) | |
| Trace ID | richText | denormalised for cheap querying |
| Trace | relation → Traces | twoWay, prop "Spans" |
| Parent Span ID | richText | nullable; root spans leave blank |
| Kind | select | `internal`, `llm`, `tool`, `http`, `db`, `agent`, `other` |
| Status | select | `ok`, `error`, `unset` |
| Started At | date | |
| Ended At | date | |
| Duration (ms) | number | |
| Attributes | richText | JSON-stringified, truncated to ~1800 chars |
| Events | richText | JSON-stringified |
| Error Message | richText | nullable |
| Attachment | files | full payload when too big for rich text (Phase 2) |

### 4.4 LLM Calls (a typed projection of `Spans` where `kind = "llm"`)
Stored as a separate DB to make cost/usage rollups simple and so users can
view LLM-only timelines.

| Property | Type | Notes |
|---|---|---|
| Name | title | `{model} · {short span id}` |
| Span ID | richText (PK) | Same id as the source Span row |
| Trace | relation → Traces | |
| Provider | select | `openai`, `anthropic`, `google`, `azure`, `other` |
| Model | richText | e.g. `gpt-4o-2024-08-06` |
| Prompt Tokens | number | |
| Completion Tokens | number | |
| Total Tokens | number | |
| Cost (USD) | number | computed from a price table in code |
| Latency (ms) | number | |
| Prompt | richText | truncated |
| Completion | richText | truncated |

### 4.5 Tool Calls (typed projection of `Spans` where `kind = "tool"`)
| Property | Type | Notes |
|---|---|---|
| Name | title | tool name |
| Span ID | richText (PK) | |
| Trace | relation → Traces | |
| Tool Name | richText | |
| Args | richText | JSON, truncated |
| Result | richText | JSON, truncated |
| Status | select | `ok`, `error` |
| Latency (ms) | number | |

### 4.6 Events
Errors, feedback, signal hits.

| Property | Type | Notes |
|---|---|---|
| Name | title | event type + short id |
| Event ID | richText (PK) | |
| Trace | relation → Traces | |
| Span ID | richText | optional |
| Type | select | `error`, `feedback`, `signal`, `note` |
| Severity | select | `info`, `warn`, `error` |
| Category | richText | filled by `errorClassifier` sync |
| Summary | richText | filled by `errorClassifier` sync |
| Detail | richText | |
| At | date | |

### 4.7 Workflows / Workflow Runs (Phase 3)
| Workflows | |
|---|---|
| Name | title |
| Workflow Key | richText (PK) |
| Trigger | select (`webhook`, `schedule`, `manual`) |
| Definition | richText (JSON) |
| Enabled | checkbox |

| Workflow Runs | |
|---|---|
| Name | title |
| Run ID | richText (PK) |
| Workflow | relation → Workflows |
| Trace ID | richText | links to a Trace |
| Status | select (`pending`, `running`, `succeeded`, `failed`, `cancelled`) |
| Step Cursor | number |
| State | richText (JSON) |
| Started At | date |
| Ended At | date |

## 5. Wire format

We accept **OTLP/JSON-compatible** span batches with a permissive parser.
Minimum viable envelope (matches OTel `ResourceSpans` shape, lightly relaxed):

```json
{
  "resource": { "service.name": "my-agent" },
  "session": { "id": "s_abc", "user_id": "u_42", "tags": ["prod"] },
  "spans": [
    {
      "trace_id": "t_abc",
      "span_id":  "sp_root",
      "parent_span_id": null,
      "name": "agent.run",
      "kind": "internal",
      "status": { "code": "ok" },
      "start_time_unix_nano": 1747432200000000000,
      "end_time_unix_nano":   1747432212000000000,
      "attributes": { "user.id": "u_42" },
      "events": []
    },
    {
      "trace_id": "t_abc",
      "span_id":  "sp_llm_1",
      "parent_span_id": "sp_root",
      "name": "openai.chat",
      "kind": "llm",
      "status": { "code": "ok" },
      "start_time_unix_nano": 1747432201000000000,
      "end_time_unix_nano":   1747432203500000000,
      "attributes": {
        "gen_ai.system": "openai",
        "gen_ai.request.model": "gpt-4o-2024-08-06",
        "gen_ai.usage.prompt_tokens": 812,
        "gen_ai.usage.completion_tokens": 119,
        "gen_ai.prompt": "...",
        "gen_ai.completion": "..."
      }
    }
  ]
}
```

All POSTs are signed:

```
X-Tracer-Signature: sha256=<hex hmac of raw body, key = INGEST_SECRET>
```

Why OTel-flavoured: lets the customer point any existing OpenTelemetry SDK at
our webhook URL later with a thin shim, instead of locking them into our client.

## 6. Phases

Each phase is **independently deployable** and has a concrete acceptance test
an engineer can run from the shell. Phases build on each other but earlier
phases stay green; a regression in Phase 3 must not break Phase 1.

### Phase 0 — Hello span (smallest vertical slice)

**Goal:** prove the round-trip. POST a span, see it in Notion.

**Scope:**
- `worker.database("traces", ...)` and `worker.database("spans", ...)` with the
  minimal columns from §4.2 / §4.3 (no LLM/Tool projection DBs yet).
- `worker.webhook("ingest", ...)` accepting `{ spans: [...] }`, HMAC-verified.
- One `worker.tool("getTrace", ...)` that takes a `traceId` and returns the
  trace row + child spans, ordered by `Started At`.
- Client SDK with just `tracer.span(name, fn)`. No auto-instrumentation.

**Acceptance:**
1. `cd worker && npm install && npm run typecheck` — passes.
2. `ntn workers deploy` — succeeds; CLI prints a webhook URL.
3. `ntn workers env set INGEST_SECRET=<dev-secret>`.
4. From `client/examples/hello.ts`:
   ```bash
   TRACER_URL=<url> TRACER_SECRET=<secret> npx tsx examples/hello.ts
   ```
   produces one trace with three spans (`agent.run`, `step.plan`, `step.act`).
5. In the Notion workspace, the **Traces** DB has a new row whose Trace ID
   matches, and the **Spans** DB has three rows linked to it via the relation.
6. From a Notion Custom Agent: *"Use the get trace tool to fetch trace `<id>`"*
   returns a structured tree.

**Out of scope:** projections, syncs, file attachments, multi-LLM cost.

---

### Phase 1 — Real schemas + LLM/Tool projections **(shipped)**

**Goal:** ingest is structured enough that rollups and tools have something
real to work on.

**Scope:**
- Add `Sessions`, `LLM Calls`, `Tool Calls`, `Events` databases (§4.1 / 4.4 / 4.5 / 4.6). **✅**
- Ingest classifies spans by `kind` and, for `llm` / `tool` spans, writes a
  *second* row into the projection DB (with the same `Span ID` so they remain
  joinable). The base `Spans` row is still written for full-fidelity replay. **✅**
- Cost computation from a hard-coded price table keyed by `(provider, model)`.
  Living in `worker/src/pricing.ts`. Unknown models default to 0 cost and a
  `pricing.unknown` event. **✅**
- Truncation helper: any field > 1800 chars is truncated with a trailing
  `... [+N chars]`. **✅** Full payload kept in a JSON file attachment via the
  Notion file-upload API. **(deferred to Phase 1.5 — see below)**
- Idempotency: re-POSTing the same `span_id` updates the existing row instead
  of duplicating. **✅** Events use deterministic IDs (`e_err_<spanId>`,
  `e_pricing_<spanId>`) so they're idempotent too.

**Acceptance:**
1. `client/examples/openai-chat.ts` makes a real call to OpenAI (key in env),
   wraps it with `tracer.llm(...)`, and ships the span. Falls back to a local
   mock when `OPENAI_API_KEY` is unset.
2. In Notion: one row in `Sessions`, `Traces`, `Spans`, `LLM Calls`, and
   `Tool Calls`. The `LLM Calls` row shows model, both token counts,
   computed cost, latency.
3. POSTing the same batch a second time changes nothing (no duplicate rows).
4. ~~POSTing a span with a 50KB `prompt` attribute writes a truncated value to~~
   ~~`Prompt` and uploads the full body as an attachment.~~ **(see Phase 1.5)**

### Phase 1.5 — Full-payload attachments **(deferred)**

The Notion file-upload API requires a multi-step flow (create upload → PUT
parts → finalize → attach to a `files` property). It's straightforward but
adds a meaningful chunk of code and an extra round-trip per truncated field.
Deferred until Phase 2 surfaces an actual need (e.g. `explainError` wants
the full prompt to reason about an error).

Acceptance when picked up:
- Add a `Full Prompt` and `Full Completion` files property to `LLM Calls`.
- Add a `Full Attributes` files property to `Spans`.
- When any of those source fields exceeds `MAX_TEXT`, upload the full body
  as `<spanId>.json` and attach.

---

### Phase 2 — Read-only agent tools

**Goal:** Notion AI can answer real questions about the traces.

**Scope:** four `readOnlyHint: true` tools:

| Tool | Input | Returns |
|---|---|---|
| `findTraces` | `{ status?, since?, model?, tag?, limit? }` | array of trace summaries |
| `getTrace` | `{ traceId, includeAttributes? }` | trace + ordered span tree |
| `summarizeTrace` | `{ traceId }` | trace summary + LLM-generated narrative |
| `explainError` | `{ spanId or eventId }` | nearby context + LLM-generated cause hypothesis |

Implementation notes:
- `summarizeTrace` and `explainError` make an outbound LLM call. Use a single
  `worker.pacer("llm", { allowedRequests: 10, intervalMs: 1000 })`.
- All tools cap returned span trees at 200 nodes; if larger, return a
  skeleton (depth=2) and instruct the agent to drill in via subsequent tool calls.
- Tool descriptions follow the docs' "instruction-boundary" style:
  *"Use this when the user asks why a trace failed."* — not generic blurbs.

**Acceptance:**
1. `ntn workers exec findTraces -d '{"status":"error","limit":5}'` returns a list.
2. In Notion AI: *"Show me the most recent failed traces"* — agent calls
   `findTraces` and renders the result.
3. In Notion AI: *"Why did the last trace fail?"* — agent calls `findTraces`
   then `explainError` and produces a coherent answer that names the actual
   error message from the span.

---

### Phase 3 — Rollups & Signals

**Goal:** turn the firehose into a small set of useful dashboards.

**Scope:**
- New databases `Cost Daily`, `Errors Daily` populated by syncs.
- `sync("costRollup", { schedule: "1h", mode: "incremental" })` aggregates
  `LLM Calls` per day per model into `Cost Daily`.
- `sync("errorClassifier", { schedule: "15m" })` finds new `Events` rows with
  `Type = error` and no `Category` yet, batches 20 at a time, calls an LLM
  with a strict classifier prompt, writes back `Category` and `Summary`.
  Pacer-protected. Cost-capped via a `MAX_CLASSIFIER_SPEND_USD` env var.
- `sync("p95LatencyDaily", { schedule: "1d" })` writes `Latency Daily` with
  p50/p95/p99 per `kind`.
- A Notion page template `Dashboard` is shipped (markdown checked into the
  worker repo, instructions in README) that embeds filtered views.

**Acceptance:**
1. After 1h of traffic, `Cost Daily` has rows summing to within 0.5% of the
   sum of `Cost (USD)` in `LLM Calls`.
2. After 15m, every previously-uncategorised error has a `Category` filled in
   from the closed enum `{ rate_limit, auth, timeout, validation, logic, tool_error, unknown }`.
3. Trigger the sync manually with `ntn workers sync trigger errorClassifier --preview`
   to inspect output before writes.

---

### Phase 4 — Workflows (the Inngest-style piece you can actually build)

**Goal:** durable step-functions whose state lives in Notion and whose runs
emit spans into the same trace tree as your customer's agents.

**Scope:**
- A workflow definition is a JSON document stored in the `Workflows` DB:
  ```json
  {
    "key": "weekly-report",
    "trigger": { "type": "schedule", "schedule": "1d" },
    "steps": [
      { "id": "fetch",   "type": "http",  "url": "https://...", "method": "GET" },
      { "id": "summarise","type": "llm",  "model": "gpt-4o-mini", "prompt": "..." },
      { "id": "post",    "type": "http",  "url": "https://hooks.slack.com/..." }
    ]
  }
  ```
- `worker.webhook("triggerWorkflow", ...)` enqueues a `Workflow Runs` row.
- `worker.sync("workflowStepper", { schedule: "5m" })` is the runtime:
  - picks up all `Workflow Runs` with `Status = pending` or `running`,
  - executes the next step (one per tick to stay well under run timeouts),
  - persists `State` and `Step Cursor` back to Notion,
  - emits a Span for the step into the customer's Trace tree
    (so workflows show up in the same trace UI for free),
  - retries up to 3 times on failure (backoff stored in `State`).
- Step types in v1: `http`, `llm`, `delay`, `branch`, `notion`.

**Acceptance:**
1. Insert a row into `Workflows` from Notion's UI with the JSON above.
2. POST to `triggerWorkflow` (or wait for the daily schedule).
3. Within 6 stepper ticks (~30m), a `Workflow Runs` row goes
   `pending → running → succeeded`, and a Trace appears with one span per step.
4. Killing an HTTP endpoint mid-run produces a `failed` run after 3 retries,
   with all attempts visible as spans.

---

### Phase 5 — Polish & distribution

**Goal:** make it easy for a stranger to deploy.

**Scope:**
- OAuth capability for GitHub: a tool `openIssueFromError` that opens a GitHub
  issue from a high-severity Event. Token via `worker.oauth(...)`.
- A `README.md` quickstart with copy-pastable shell snippets.
- A `tracer init` CLI command in the client package that prints curl examples
  pointed at the deployed webhook URL.
- An evals mini-feature: a `runEval` tool that re-executes a chosen workflow
  against a `Datasets` DB and writes scored results to `Eval Runs`.

**Acceptance:**
1. A new contributor clones the repo, runs `npm install && ntn workers deploy`,
   and within 10 minutes has a working ingest + tools setup.
2. `openIssueFromError` creates a GitHub issue whose body includes the trace URL.

## 7. Risks & mitigations

| Risk | Mitigation |
|---|---|
| 5m sync schedule floor → slow workflow steps | Acceptable for v1; add webhook-re-entry trick in v2 if needed. |
| Notion API rate limits during bursty ingest | `worker.pacer("notion", { allowedRequests: 3, intervalMs: 1000 })`; batch upserts of up to 10 spans per Notion call. |
| Tool synchronous timeout on huge traces | Cap span tree depth/breadth in tool output; offer drill-down tools instead of one giant fetch. |
| Webhook URL leak = anyone can write garbage | HMAC over body with `INGEST_SECRET`; reject unsigned. After 5 verification failures Notion disables the webhook anyway — recovery is `ntn workers deploy`. |
| LLM classifier cost runs away | Hard `MAX_CLASSIFIER_SPEND_USD` env cap, checked before each batch. |
| Notion rich-text size limits | 1800-char truncation + file-upload fallback for full payload. |
| Span attribute keys collide with Notion property naming | Internal normaliser maps OTel keys → flat camelCase JSON inside the `Attributes` column; we don't try to project arbitrary attributes onto Notion properties. |

## 8. Decisions

- **D1 — Wire format:** OTLP/JSON-compatible permissive parser.
- **D2 — Multi-tenancy:** none. Distribute as a template; each customer deploys
  into their own workspace.
- **D3 — Large payload storage:** Notion file-upload API (no external blob store).
- **D4 — Workflow runtime:** sync-driven (5m tick floor) for v1. No webhook re-entry until proven necessary.
- **D5 — Auth on ingest:** HMAC-SHA256 over raw body. Secret in `INGEST_SECRET`.
- **D6 — Idempotency key:** `span_id` (and `trace_id` for trace upserts). Re-ingest is safe.
- **D7 — Notion API client in tools:** Use `context.notion` (worker-provided, auth'd as the calling agent). For syncs & webhooks, `NOTION_API_TOKEN` env var (internal integration token).

## 9. Repository layout

```
tracer/
├── PLAN.md                      ← you are here
├── README.md                    ← quickstart
├── worker/                      ← the Notion Worker package
│   ├── package.json
│   ├── tsconfig.json
│   ├── .env.example
│   └── src/
│       ├── index.ts             ← entry: registers capabilities
│       ├── databases.ts         ← managed DB declarations
│       ├── pricing.ts           ← model price table (Phase 1)
│       ├── ingest/
│       │   ├── webhook.ts
│       │   ├── verify.ts        ← HMAC
│       │   ├── parse.ts         ← OTLP-permissive parser
│       │   └── upsert.ts        ← spans → Notion changes
│       ├── tools/
│       │   ├── getTrace.ts
│       │   ├── findTraces.ts    (Phase 2)
│       │   ├── summarizeTrace.ts (Phase 2)
│       │   └── explainError.ts  (Phase 2)
│       ├── syncs/               (Phase 3)
│       │   ├── costRollup.ts
│       │   ├── errorClassifier.ts
│       │   └── p95LatencyDaily.ts
│       └── workflows/           (Phase 4)
│           ├── stepper.ts
│           └── steps/
└── client/                      ← user-facing tracer SDK
    ├── package.json
    ├── tsconfig.json
    ├── src/
    │   ├── index.ts             ← public API
    │   ├── tracer.ts            ← span() context manager
    │   ├── transport.ts         ← HMAC + batched POST
    │   └── instrumentation/     (Phase 1+)
    │       ├── openai.ts
    │       └── anthropic.ts
    └── examples/
        ├── hello.ts             ← Phase 0 smoke test
        └── openai-chat.ts       (Phase 1)
```

## 10. Definition of done (whole product, all phases)

A developer can:

1. Clone the repo, run `npm install && ntn workers deploy`, set
   `INGEST_SECRET` and `NOTION_API_TOKEN`, and have a working tracer in
   ≤10 minutes.
2. Drop the client into an agent and see spans in Notion within 60 seconds.
3. Ask Notion AI "why did this trace fail" and get a useful answer that
   names the real error.
4. See per-day cost and error category rollups update without manual work.
5. Author a 3-step workflow in JSON and watch it run on a schedule, with
   every step traced.
