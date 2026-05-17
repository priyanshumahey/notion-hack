# Tracer — Agent tracing on Notion Workers

An Inngest/Trigger.dev-style event-driven background-function runtime + a
Laminar-style trace product, both hosted as a single Notion Worker. Trace
data and function state live in your Notion workspace. Notion AI reads it
through worker tools.

> **Plan & roadmap:** see [`PLAN.md`](./PLAN.md) for the full phased build.
> Status: **Phase 1 complete** — structured ingest with LLM/Tool projections,
> cost from a built-in pricing table, idempotent re-ingest, and an Events
> stream for errors and pricing gaps. **Phase 4 (workflows) shipped** with
> event-driven triggers, `sleepUntil`, `waitForEvent`, and `sendEvent`.

## Layout

```
tracer/
├── PLAN.md            ← the detailed plan & phase acceptance criteria
├── README.md          ← you are here
├── worker/            ← the Notion Worker package (deployed to Notion)
└── client/            ← the user-facing tracer SDK (drops into your agent)
```

## Databases created on first deploy

| Database | Phase | Purpose |
|---|---|---|
| Tracer · Sessions | 1 | Per-user / per-conversation grouping |
| Tracer · Traces | 0 | One row per trace; aggregate cost / tokens / status |
| Tracer · Spans | 0 | Raw span store, full fidelity |
| Tracer · LLM Calls | 1 | Typed projection of `kind=llm` spans (provider/model/tokens/cost) |
| Tracer · Tool Calls | 1 | Typed projection of `kind=tool` spans (args/result) |
| Tracer · Events | 1 | Errors, feedback signals, pricing notes |
| Functions · Sandboxes | 4 | Per-environment policy (allowed hosts, concurrency) |
| Functions · Catalog | 4 | Background-function definitions (JSON step lists) |
| Functions · Runs | 4 | Durable per-run state (one row per run) |
| Functions · Events | 4 | Inngest-style event log → fans out into runs |

## Quickstart

### 1. Install deps

```bash
cd tracer/worker && npm install
cd ../client && npm install
```

### 2. Authenticate and deploy the worker

```bash
cd tracer/worker
ntn auth login                          # one-time
ntn workers deploy                      # creates the Notion databases + webhook
ntn workers webhooks list               # copy the URL for the `ingest` webhook
```

### 3. Configure secrets

```bash
# A random shared secret for HMAC verification of incoming span batches.
ntn workers env set INGEST_SECRET=$(openssl rand -hex 32)

# An internal integration token with access to the worker's databases.
# Create one at https://www.notion.so/profile/integrations
ntn workers env set NOTION_API_TOKEN=secret_...
```

### 4. Optional: pin database IDs (skips a search round-trip per request)

After the first deploy, find the six databases in Notion. Open each,
click ⋯ → Copy link, and extract the 32-char database id from the URL.

```bash
ntn workers env set SESSIONS_DB_ID=<id>
ntn workers env set TRACES_DB_ID=<id>
ntn workers env set SPANS_DB_ID=<id>
ntn workers env set LLM_CALLS_DB_ID=<id>
ntn workers env set TOOL_CALLS_DB_ID=<id>
ntn workers env set EVENTS_DB_ID=<id>
```

If any are unset the worker discovers them by title on the first batch and
caches the IDs in-process. That works fine, just slower on cold start.

### 5. Send a trace from the client

**Phase 0 — smallest hello span:**

```bash
cd ../client
export TRACER_URL="https://www.notion.so/webhooks/worker/.../ingest"
export TRACER_SECRET="<same value you set as INGEST_SECRET>"
npx tsx examples/hello.ts
```

**Phase 1 — LLM + tool projection with cost:**

```bash
# Optional: set OPENAI_API_KEY=sk-... to make a real call.
# Otherwise a local mock is used so you can still see the pipeline.
npx tsx examples/openai-chat.ts
```

After either run, in Notion you should see:
- 1 new **Sessions** row.
- 1 new **Traces** row with `Total Tokens > 0` and `Cost (USD) > 0`.
- N new **Spans** rows, all linked back via the `Trace` relation.
- For `openai-chat.ts`: 1 new **LLM Calls** row and 1 new **Tool Calls** row.

**Re-run the same example.** Row counts should NOT change — every projection
upserts by `Span ID` (or deterministic `Event ID`).

### 6. Ask Notion AI about it

In Notion, open a Custom Agent that has the worker's tools enabled, and ask:

> *"Use the `getTrace` tool to fetch trace `t_...` and tell me what happened."*

The agent calls `getTrace` and produces a structured answer that names the
actual span names, statuses, and the LLM call.

### 7. Event-driven background functions

The worker also ships an Inngest-style background-function runtime. Define
a function as a JSON step list in the `Functions · Catalog` Notion DB, set
`Trigger = event` and an `Event Name`, then `POST` events to the
`sendEvent` webhook — every matching enabled function fans out into a row
in `Functions · Runs` that advances one step per minute.

**Run the seeded `welcome-flow` example:**

```bash
# Populate the catalog (one-time):
cd worker
ntn workers sync trigger seedSandboxes
ntn workers sync trigger seedFunctions
ntn workers webhooks list   # copy the `sendEvent` URL

# Fire the event:
cd ../client
export SEND_EVENT_URL=https://www.notion.so/webhooks/worker/.../sendEvent
export TRACER_SECRET=<same as INGEST_SECRET>
npx tsx examples/welcome-flow.ts
```

Open `Functions · Runs` in Notion and filter by Run ID to watch the row
advance: `pending → running → sleeping → running → sendEvent → waiting →
running → succeeded`.

**Step types supported by the runtime:**

| Type | Purpose |
|---|---|
| `http` | Fetch a URL (GET/POST/...), capture body in step state. |
| `llm` | Call OpenAI Chat Completions, capture content + token usage. |
| `delay` | Inline `setTimeout` (synchronous, ≤ 60s). |
| `sleepUntil` | Durable wall-clock sleep. Row parks in `sleeping`. |
| `waitForEvent` | Park until a matching event arrives. Optional `timeoutMs` + `match.{path,value}` filter. |
| `sendEvent` | Emit a new event from inside the function. Fans out further. |

All step results are addressable from later steps via
`${state.<stepId>.<dotted.path>}`.

**Emit events from your own code:**

```ts
import { sendEvent } from "@notion-tracer/client";

await sendEvent({
  url: process.env.SEND_EVENT_URL!,
  secret: process.env.TRACER_SECRET!,
  name: "user.signup",
  data: { email: "alice@example.com", plan: "pro" },
  // Optional: idempotencyKey rejects duplicates regardless of id.
  idempotencyKey: "signup:alice@example.com",
});
```

## Cost / pricing notes

Pricing is computed inside the worker from a hard-coded table in
[`worker/src/pricing.ts`](./worker/src/pricing.ts). When the worker sees a
model it doesn't recognise:

1. `Cost (USD)` for that LLM Call is set to `0`.
2. A row appears in **Events** with `Type = note`, `Category = pricing.unknown`,
   `Severity = warn`, and a summary that names the model.

The fix is to add the new model to `pricing.ts` and redeploy. Filter Events
by `Category = pricing.unknown` to see what's missing.

## What's next

Phase 2 adds `findTraces`, `summarizeTrace`, `explainError`. Phase 3 adds
scheduled rollup syncs (cost daily, error classifier, p95 latency). Phase 4
adds in-worker workflows. See [`PLAN.md`](./PLAN.md) for details.

## Troubleshooting

- **`ingest: signature mismatch`** — `INGEST_SECRET` on the worker and
  `TRACER_SECRET` on the client must be identical.
- **`No trace found...`** — confirm the worker's `NOTION_API_TOKEN` has access
  to every database; in each DB, open Connections and add the integration.
- **No rows appear** — `ntn workers runs list --plain | head` to see if the
  webhook ran. `ntn workers runs logs <run-id>` for details.
- **Notion disabled the webhook** — happens after 5 consecutive HMAC failures.
  `ntn workers deploy` again to re-enable.
- **Trace shows `Cost (USD) = 0`** but `Total Tokens > 0` — check
  `Tracer · Events` filtered by `Category = pricing.unknown`. Add the model
  to `worker/src/pricing.ts` and redeploy.
