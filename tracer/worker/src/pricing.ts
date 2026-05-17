/**
 * LLM pricing table.
 *
 * Prices are USD per 1M tokens, separately for prompt (input) and completion
 * (output). Kept as a flat map keyed by *normalized* model name so callers
 * can pass the raw `gen_ai.request.model` attribute and get a match.
 *
 * Unknown models return `{ usd: 0, known: false }`. Callers should emit a
 * `pricing.unknown` Event when this happens so users notice missing pricing
 * and can either supply a price or accept the zero.
 *
 * Numbers reflect public list prices for the model family — known to drift.
 * Update this file when a new model ships; do not depend on it for billing.
 */

export type Provider = "openai" | "anthropic" | "google" | "azure" | "other";

export interface PriceEntry {
  provider: Provider;
  /** USD per 1M prompt/input tokens. */
  inputPer1M: number;
  /** USD per 1M completion/output tokens. */
  outputPer1M: number;
}

const PRICES: Record<string, PriceEntry> = {
  // ----- OpenAI -----
  "gpt-4o": { provider: "openai", inputPer1M: 2.5, outputPer1M: 10.0 },
  "gpt-4o-2024-08-06": { provider: "openai", inputPer1M: 2.5, outputPer1M: 10.0 },
  "gpt-4o-2024-11-20": { provider: "openai", inputPer1M: 2.5, outputPer1M: 10.0 },
  "gpt-4o-mini": { provider: "openai", inputPer1M: 0.15, outputPer1M: 0.6 },
  "gpt-4-turbo": { provider: "openai", inputPer1M: 10.0, outputPer1M: 30.0 },
  "gpt-3.5-turbo": { provider: "openai", inputPer1M: 0.5, outputPer1M: 1.5 },
  o1: { provider: "openai", inputPer1M: 15.0, outputPer1M: 60.0 },
  "o1-mini": { provider: "openai", inputPer1M: 3.0, outputPer1M: 12.0 },
  "o3-mini": { provider: "openai", inputPer1M: 1.1, outputPer1M: 4.4 },

  // ----- Anthropic -----
  "claude-3-5-sonnet": { provider: "anthropic", inputPer1M: 3.0, outputPer1M: 15.0 },
  "claude-3-5-sonnet-20241022": {
    provider: "anthropic",
    inputPer1M: 3.0,
    outputPer1M: 15.0,
  },
  "claude-3-5-haiku": { provider: "anthropic", inputPer1M: 0.8, outputPer1M: 4.0 },
  "claude-3-5-haiku-20241022": {
    provider: "anthropic",
    inputPer1M: 0.8,
    outputPer1M: 4.0,
  },
  "claude-3-opus": { provider: "anthropic", inputPer1M: 15.0, outputPer1M: 75.0 },
  "claude-3-opus-20240229": {
    provider: "anthropic",
    inputPer1M: 15.0,
    outputPer1M: 75.0,
  },
  "claude-3-haiku-20240307": {
    provider: "anthropic",
    inputPer1M: 0.25,
    outputPer1M: 1.25,
  },

  // ----- Google -----
  "gemini-1.5-pro": { provider: "google", inputPer1M: 1.25, outputPer1M: 5.0 },
  "gemini-1.5-flash": { provider: "google", inputPer1M: 0.075, outputPer1M: 0.3 },
  "gemini-2.0-flash": { provider: "google", inputPer1M: 0.1, outputPer1M: 0.4 },
  "gemini-2.0-flash-exp": { provider: "google", inputPer1M: 0.1, outputPer1M: 0.4 },
};

export interface CostResult {
  /** Computed USD cost; 0 for unknown models. */
  usd: number;
  /** Whether the model was in the price table. */
  known: boolean;
  /** Normalized lookup key used (lowercase, fallback). */
  modelKey: string;
  /** Provider as classified from the lookup or the supplied hint. */
  provider: Provider;
}

/**
 * Compute LLM cost.
 *
 * `model` can be the raw `gen_ai.request.model` (e.g. `gpt-4o-2024-08-06`)
 * or a family name (`gpt-4o`). We attempt an exact match first; if that
 * fails, we strip date suffixes (`-YYYYMMDD` or `-YYYY-MM-DD`) and try
 * again. If still no match, returns known=false and 0 cost.
 *
 * `providerHint` is what the caller asserted (from `gen_ai.system`). We
 * prefer the price entry's provider when the lookup hits; otherwise we
 * keep the hint.
 */
export function costFor(
  model: string | undefined | null,
  promptTokens: number,
  completionTokens: number,
  providerHint: Provider = "other",
): CostResult {
  const raw = (model ?? "").trim().toLowerCase();
  if (!raw) {
    return { usd: 0, known: false, modelKey: "", provider: providerHint };
  }

  let entry = PRICES[raw];
  let modelKey = raw;

  if (!entry) {
    // Strip trailing date suffix: gpt-4o-2024-08-06 -> gpt-4o
    const stripped = raw.replace(/-\d{8}$/, "").replace(/-\d{4}-\d{2}-\d{2}$/, "");
    if (stripped !== raw && PRICES[stripped]) {
      entry = PRICES[stripped];
      modelKey = stripped;
    }
  }

  if (!entry) {
    return { usd: 0, known: false, modelKey: raw, provider: providerHint };
  }

  const input = Math.max(0, promptTokens);
  const output = Math.max(0, completionTokens);
  const usd = (input * entry.inputPer1M + output * entry.outputPer1M) / 1_000_000;
  // Round to 8 decimals — fine-grained enough for fractional-cent calls,
  // and prevents Notion's number formatter from showing absurd precision.
  const rounded = Math.round(usd * 1e8) / 1e8;
  return { usd: rounded, known: true, modelKey, provider: entry.provider };
}

export function normalizeProvider(s: unknown): Provider {
  const v = String(s ?? "").toLowerCase().trim();
  if (v === "openai") return "openai";
  if (v === "anthropic" || v === "claude") return "anthropic";
  if (v === "google" || v === "gemini" || v === "vertex") return "google";
  if (v === "azure" || v === "azure_openai" || v === "azure-openai") return "azure";
  return "other";
}
