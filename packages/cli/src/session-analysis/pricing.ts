import type { Usage } from "./types.js";

const ANTHROPIC_PRICING_PER_M = [
  { pattern: /opus/i, input: 15, cacheRead: 1.5 },
  { pattern: /haiku/i, input: 0.8, cacheRead: 0.08 },
  { pattern: /sonnet/i, input: 3, cacheRead: 0.3 },
];

function anthropicPricingForModel(modelId: string | undefined): { input: number; cacheRead: number } | null {
  if (!modelId) return null;
  return ANTHROPIC_PRICING_PER_M.find((p) => p.pattern.test(modelId)) ?? null;
}

/**
 * Estimate savings from cache reads for a single assistant turn.
 *
 * Returns null when pricing/cost data is insufficient. This keeps session-level
 * savings from showing partial totals for mixed-provider or unknown-model data.
 */
export function estimateCacheReadSavings(
  provider: string | undefined,
  modelId: string | undefined,
  usage: Usage,
): number | null {
  if (!usage.cost) return null;

  const cacheReadTokens = usage.cacheRead ?? 0;
  const cost = usage.cost;

  if (
    cacheReadTokens > 0 &&
    typeof cost.input === "number" &&
    typeof cost.cacheRead === "number" &&
    usage.input > 0
  ) {
    const inferredInputPricePerToken = cost.input / usage.input;
    return Math.max(0, (cacheReadTokens * inferredInputPricePerToken) - cost.cacheRead);
  }

  if (provider !== "anthropic") return null;

  const pricing = anthropicPricingForModel(modelId);
  if (!pricing) return null;

  return (cacheReadTokens / 1_000_000) * (pricing.input - pricing.cacheRead);
}
