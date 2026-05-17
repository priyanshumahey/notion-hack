/**
 * Seed syncs for the workflow runtime.
 *
 * These syncs run in `replace` mode on a `manual` schedule. Trigger them
 * once after deploy to populate the canonical `Functions · Sandboxes` and
 * `Functions · Catalog` rows that other syncs reference via
 * `Builder.relation("<key>")`:
 *
 *   ntn workers sync trigger seedSandboxes
 *   ntn workers sync trigger seedFunctions
 *
 * Why syncs and not a one-off script? `Builder.relation(primaryKey)`
 * resolves PKs against the framework's internal upsert map — which only
 * tracks rows created by sync upserts. Externally pages.create'd rows are
 * invisible to relation resolution, so the seed *must* go through the
 * sync pipeline for `functionRuns` upserts to wire up their
 * Function/Sandbox relations correctly.
 */

import * as Builder from "@notionhq/workers/builder";
import type { Worker, SyncExecutionResult } from "@notionhq/workers";
import type { Databases } from "./databases.js";

export function registerSeedSyncs(worker: Worker, dbs: Databases): void {
  worker.sync("seedSandboxes", {
    database: dbs.sandboxes as never,
    mode: "replace",
    schedule: "manual",
    execute: async (): Promise<SyncExecutionResult<string>> => ({
      changes: [
        {
          type: "upsert",
          key: "dev-default",
          properties: {
            Name: Builder.title("Dev Default"),
            "Sandbox Key": Builder.richText("dev-default"),
            Description: Builder.richText(
              "Default sandbox for development. Allows api.github.com + api.openai.com.",
            ),
            Environment: Builder.select("dev"),
            "Allowed Hosts": Builder.richText("api.github.com, api.openai.com"),
            "Max Concurrent Runs": Builder.number(4),
            Active: Builder.checkbox(true),
          },
        },
      ] as never,
      hasMore: false,
    }),
  });

  worker.sync("seedFunctions", {
    database: dbs.functions as never,
    mode: "replace",
    schedule: "manual",
    execute: async (): Promise<SyncExecutionResult<string>> => ({
      changes: [
        {
          type: "upsert",
          key: "hello-zen",
          properties: {
            Name: Builder.title("Hello Zen"),
            "Function Key": Builder.richText("hello-zen"),
            Description: Builder.richText(
              "Fetches a GitHub Zen quote and pauses briefly. Pure http + delay demo.",
            ),
            Sandbox: [Builder.relation("dev-default")],
            Trigger: Builder.select("webhook"),
            Definition: Builder.richText(
              JSON.stringify({
                steps: [
                  { id: "wait", type: "delay", ms: 250 },
                  {
                    id: "zen",
                    type: "http",
                    url: "https://api.github.com/zen",
                    method: "GET",
                  },
                ],
              }),
            ),
            Enabled: Builder.checkbox(true),
          },
        },
        {
          type: "upsert",
          key: "pirate-zen",
          properties: {
            Name: Builder.title("Pirate Zen"),
            "Function Key": Builder.richText("pirate-zen"),
            Description: Builder.richText(
              "Fetches a Zen quote, then asks gpt-4o-mini to rewrite it in pirate speak. Requires OPENAI_API_KEY on the worker.",
            ),
            Sandbox: [Builder.relation("dev-default")],
            Trigger: Builder.select("webhook"),
            Definition: Builder.richText(
              JSON.stringify({
                steps: [
                  {
                    id: "zen",
                    type: "http",
                    url: "https://api.github.com/zen",
                    method: "GET",
                  },
                  {
                    id: "rewrite",
                    type: "llm",
                    model: "gpt-4o-mini",
                    system: "You are a friendly pirate.",
                    prompt:
                      "Rewrite this phrase in pirate speak in one short sentence: ${state.zen.body}",
                    maxTokens: 80,
                    temperature: 0.5,
                  },
                ],
              }),
            ),
            Enabled: Builder.checkbox(true),
          },
        },
        {
          // Inngest-style event-driven function:
          //   send `user.signup` from your app → this function fires →
          //   it sleeps 30s (durable: survives stepper ticks) → fetches a
          //   greeting and asks gpt-4o-mini to draft a welcome blurb.
          //
          // Try it from your shell:
          //   EVENT_NAME=user.signup INPUT_JSON='{"email":"x@y.com"}' \
          //     npm run send-event
          type: "upsert",
          key: "welcome-flow",
          properties: {
            Name: Builder.title("Welcome Flow"),
            "Function Key": Builder.richText("welcome-flow"),
            Description: Builder.richText(
              "Event-driven onboarding demo. Listens for `user.signup`, " +
                "sleeps 30s durably, then drafts a welcome blurb via LLM.",
            ),
            Sandbox: [Builder.relation("dev-default")],
            Trigger: Builder.select("event"),
            "Event Name": Builder.richText("user.signup"),
            Definition: Builder.richText(
              JSON.stringify({
                steps: [
                  { id: "pause", type: "sleepUntil", ms: 30_000 },
                  {
                    id: "zen",
                    type: "http",
                    url: "https://api.github.com/zen",
                    method: "GET",
                  },
                  {
                    id: "welcome",
                    type: "llm",
                    model: "gpt-4o-mini",
                    system: "You are a friendly onboarding assistant.",
                    prompt:
                      "Write a one-sentence welcome message for ${state.input.data.email}. " +
                      "Include this zen koan as inspiration: ${state.zen.body}",
                    maxTokens: 80,
                    temperature: 0.5,
                  },
                ],
              }),
            ),
            Enabled: Builder.checkbox(true),
          },
        },
        {
          // Approval workflow demo. Showcases event-driven `waitForEvent`:
          //
          //   1. App sends `approval.requested` with `data.requestId`.
          //   2. This function fans out, sleeps briefly to show start,
          //      then parks on `waitForEvent` filtered by requestId.
          //   3. Reviewer (or your client demo) sends `approval.decided`
          //      with the same requestId — the stepper matches the wake
          //      against the parked run and advances it.
          //   4. LLM drafts an audit-log entry.
          //
          // Try it from your shell:
          //   npm run approval-flow
          type: "upsert",
          key: "approval-flow",
          properties: {
            Name: Builder.title("Approval Flow"),
            "Function Key": Builder.richText("approval-flow"),
            Description: Builder.richText(
              "Approval workflow demo. Listens for `approval.requested`, " +
                "parks on `waitForEvent` filtered by requestId, then drafts " +
                "an audit log when the matching `approval.decided` arrives.",
            ),
            Sandbox: [Builder.relation("dev-default")],
            Trigger: Builder.select("event"),
            "Event Name": Builder.richText("approval.requested"),
            Definition: Builder.richText(
              JSON.stringify({
                steps: [
                  { id: "kickoff", type: "sleepUntil", ms: 250 },
                  {
                    id: "decision",
                    type: "waitForEvent",
                    event: "approval.decided",
                    match: {
                      path: "requestId",
                      value: "${state.input.data.requestId}",
                    },
                    timeoutMs: 24 * 60 * 60 * 1000,
                  },
                  {
                    id: "audit",
                    type: "llm",
                    model: "gpt-4o-mini",
                    system:
                      "You write terse one-sentence audit log entries " +
                      "for an expense-approval system.",
                    prompt:
                      "Approval request ${state.input.data.requestId} for " +
                      "$${state.input.data.amount} submitted by " +
                      "${state.input.data.requester} was " +
                      "${state.decision.data.decision} with reason: " +
                      "${state.decision.data.reason}. " +
                      "Write a single audit-log line.",
                    maxTokens: 80,
                    temperature: 0.3,
                  },
                ],
              }),
            ),
            Enabled: Builder.checkbox(true),
          },
        },
        {
          // Job-hunting agent. Triggered by the Notion Dance extension
          // when the user has been browsing jobs. Three-stage pipeline:
          //
          //   1. queryGen — turn the user's recent job titles into a
          //      focused Exa search query.
          //   2. search   — POST that query to Exa, biased toward common
          //      ATS domains (greenhouse / lever / ashby / wellfound).
          //   3. parse    — compress Exa's top 5 results into minified
          //      JSON {leads:[{title,company,url,score}]} so it fits in
          //      a Notion rich_text property.
          //   4. persist  — POST one row to the user's `Notion Dance ·
          //      Agent Picks` DB with the leads JSON inline. The
          //      extension polls that DB by Run ID and promotes
          //      individual leads into `Notion Dance · Job Leads`.
          //
          // Caller supplies in input:
          //   - exaKey            : Exa search API key
          //   - notionToken       : Notion integration token with access
          //                         to agentPicksDbId
          //   - agentPicksDbId    : Database ID for `Notion Dance ·
          //                         Agent Picks`
          //   - runId             : Caller-generated id, also passed to
          //                         triggerFunction for idempotency
          //   - visitedTitles[]   : Recent job titles the user viewed
          //   - visitedCompanies[]: Companies they were on
          //   - visitedUrls[]     : URLs to exclude as already-seen
          //   - locationHint?     : Free-text city/remote preference
          type: "upsert",
          key: "job-prospector",
          properties: {
            Name: Builder.title("Job Prospector"),
            "Function Key": Builder.richText("job-prospector"),
            Description: Builder.richText(
              "Picks up where a job-search session left off. Generates a " +
                "tailored Exa query, runs it against ATS domains, compresses " +
                "the top hits to JSON, and writes one row to the user's " +
                "`Notion Dance · Agent Picks` DB for the extension to fan " +
                "out into Job Leads.",
            ),
            Sandbox: [Builder.relation("dev-default")],
            Trigger: Builder.select("webhook"),
            Definition: Builder.richText(
              JSON.stringify({
                steps: [
                  {
                    id: "queryGen",
                    type: "llm",
                    model: "gpt-4o-mini",
                    system:
                      "You generate concise web search queries for job " +
                      "hunting. Output ONLY the bare search query text " +
                      "(10-20 words). No quotes, no boolean operators, no " +
                      "preamble, no explanation.",
                    prompt:
                      "Recent job listings this user viewed:\n" +
                      "${state.input.visitedTitles}\n\n" +
                      "At these companies:\n" +
                      "${state.input.visitedCompanies}\n\n" +
                      "Location preference: ${state.input.locationHint}\n\n" +
                      "Return ONE focused search query (10-20 words) that " +
                      "would surface 5-10 similar NEW openings on common " +
                      "ATS sites (greenhouse, lever, ashby, wellfound). " +
                      "Output ONLY the query.",
                    maxTokens: 60,
                    temperature: 0.3,
                  },
                  {
                    id: "search",
                    type: "http",
                    url: "https://api.exa.ai/search",
                    method: "POST",
                    headers: {
                      "x-api-key": "${state.input.exaKey}",
                      "content-type": "application/json",
                    },
                    body: {
                      query: "${state.queryGen.content}",
                      numResults: 6,
                      type: "auto",
                      includeDomains: [
                        "boards.greenhouse.io",
                        "jobs.lever.co",
                        "jobs.ashbyhq.com",
                        "wellfound.com",
                        "ycombinator.com",
                      ],
                    },
                  },
                  {
                    id: "parse",
                    type: "llm",
                    model: "gpt-4o-mini",
                    system:
                      "Extract job leads from Exa search results. Output " +
                      "ONLY a single-line minified JSON object of shape " +
                      '{"leads":[{"title":string,"company":string,' +
                      '"url":string,"score":number}]}. Up to 5 leads. ' +
                      "Title <=80 chars. Company <=40 chars. Score 0-100 " +
                      "(your confidence this is a real, applyable role). " +
                      "Skip aggregator pages. No commentary, no markdown.",
                    prompt:
                      "Exa search results:\n${state.search.body}\n\n" +
                      "Already-viewed URLs to exclude:\n" +
                      "${state.input.visitedUrls}\n\n" +
                      "Return the compressed JSON object now.",
                    maxTokens: 500,
                    temperature: 0.1,
                  },
                  {
                    id: "persist",
                    type: "http",
                    url: "https://api.notion.com/v1/pages",
                    method: "POST",
                    headers: {
                      authorization: "Bearer ${state.input.notionToken}",
                      "notion-version": "2022-06-28",
                      "content-type": "application/json",
                    },
                    body: {
                      parent: {
                        database_id: "${state.input.agentPicksDbId}",
                      },
                      properties: {
                        Name: {
                          title: [
                            {
                              type: "text",
                              text: { content: "${state.input.runId}" },
                            },
                          ],
                        },
                        "Run ID": {
                          rich_text: [
                            {
                              type: "text",
                              text: { content: "${state.input.runId}" },
                            },
                          ],
                        },
                        Query: {
                          rich_text: [
                            {
                              type: "text",
                              text: {
                                content: "${state.queryGen.content}",
                              },
                            },
                          ],
                        },
                        Leads: {
                          rich_text: [
                            {
                              type: "text",
                              text: {
                                content: "${state.parse.content}",
                              },
                            },
                          ],
                        },
                        Status: { select: { name: "ready" } },
                      },
                    },
                  },
                ],
              }),
            ),
            Enabled: Builder.checkbox(true),
          },
        },
      ] as never,
      hasMore: false,
    }),
  });
}
