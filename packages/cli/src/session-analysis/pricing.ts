import type { Usage } from "./types.js";

/**
 * Estimate cache-read savings from the provider's reported costs.
 *
 * Pi's cost fields are already normalized to the request's token counts, so
 * guessing a price from a model name is less reliable than returning unknown.
 */
export function estimateCacheReadSavings(
  _provider: string | undefined,
  _modelId: string | undefined,
  usage: Usage,
): number | null {
  const cacheReadTokens = usage.cacheRead ?? 0;
  if (cacheReadTokens === 0) return 0;

  const cost = usage.cost;
  if (
    !cost ||
    usage.input <= 0 ||
    typeof cost.input !== "number" ||
    typeof cost.cacheRead !== "number" ||
    !Number.isFinite(cost.input) ||
    !Number.isFinite(cost.cacheRead)
  ) {
    return null;
  }

  const uncachedInputPricePerToken = cost.input / usage.input;
  return Math.max(0, cacheReadTokens * uncachedInputPricePerToken - cost.cacheRead);
}
