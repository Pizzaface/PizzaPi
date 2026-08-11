import type { Usage } from "./types.js";

/**
 * Estimate NET cache savings for one request from the provider's reported
 * costs: what the cache reads saved versus uncached input, minus the premium
 * paid to write the cache.
 *
 * Pi's cost fields are already normalized to the request's token counts, so
 * guessing a price from a model name is less reliable than returning unknown.
 * The result can be negative when cache writes cost more than reads saved.
 */
export function estimateCacheReadSavings(
  _provider: string | undefined,
  _modelId: string | undefined,
  usage: Usage,
): number | null {
  const cacheReadTokens = usage.cacheRead ?? 0;
  const cacheWriteTokens = usage.cacheWrite ?? 0;
  if (cacheReadTokens === 0 && cacheWriteTokens === 0) return 0;

  const cost = usage.cost;
  if (!cost || usage.input <= 0 || !isFiniteNumber(cost.input)) return null;
  const uncachedInputPricePerToken = cost.input / usage.input;

  let savings = 0;
  if (cacheReadTokens > 0) {
    if (!isFiniteNumber(cost.cacheRead)) return null;
    savings += cacheReadTokens * uncachedInputPricePerToken - cost.cacheRead;
  }
  if (cacheWriteTokens > 0) {
    if (!isFiniteNumber(cost.cacheWrite)) return null;
    // Premium paid over what the same tokens would cost as plain input.
    savings -= cost.cacheWrite - cacheWriteTokens * uncachedInputPricePerToken;
  }
  return savings;
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}
