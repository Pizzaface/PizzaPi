/**
 * Usage-limit error classifier.
 *
 * Identifies provider errors that indicate the session has hit a hard usage
 * ceiling — as opposed to transient/retryable errors or unrelated failures.
 *
 * Design constraints:
 *  - No bare `includes("rate")` — that matches "generate", "elaborate", etc.
 *  - All matching is case-insensitive.
 *  - Phrase patterns are matched as full sub-phrases (not word-by-word) to
 *    avoid split false-positives.
 *  - Single-word patterns use word boundaries (\b) to avoid infix matches.
 */

/**
 * Known phrases that indicate a hard usage / quota limit from a provider.
 * Ordered from most specific to least specific.
 */
const USAGE_LIMIT_PHRASES: ReadonlyArray<RegExp> = [
    // Multi-word phrases — match literally (no \b needed; they're long enough)
    /usage\s+limit/i,
    /rate\s+limit/i,
    /quota[\s_]+exceeded/i, // matches "quota exceeded" and gRPC "QUOTA_EXCEEDED"
    /resource[\s_]+exhausted/i, // matches "resource exhausted" and gRPC "RESOURCE_EXHAUSTED"
    /tokens\s+per\s+minute/i,
    /requests\s+per\s+minute/i,
    /output\s+tokens\s+per/i,
    /context\s+window/i,
    // Single-word patterns with word boundaries
    /\bquota\b/i,
];

/**
 * Known phrases that indicate provider-side capacity saturation (as opposed
 * to a hard quota). These are retried by the agent core; once retries are
 * exhausted, consumers such as the fallback-model extension may switch to an
 * alternate configured model.
 *
 * Matches Anthropic's `overloaded_error`, HTTP 529 overload responses, and
 * generic throttling/backpressure wording.
 */
const PROVIDER_CAPACITY_PHRASES: ReadonlyArray<RegExp> = [
    // Anthropic's explicit stream error type, e.g. "overloaded_error: Overloaded"
    /\boverloaded/i,
    // HTTP 529 / "Error 529: overloaded"
    /\b529\b/i,
    // Throttled / throttling backpressure
    /\bthrottl/i,
];

/**
 * Returns true if the error message indicates a hard provider usage limit.
 *
 * Examples that should match:
 *   "You have exceeded your usage limit"
 *   "Rate limit reached for requests per minute"
 *   "Quota exceeded for your current plan"
 *   "Resource exhausted: RESOURCE_EXHAUSTED"
 *   "grpc status RESOURCE_EXHAUSTED"          — gRPC/Gemini quota error
 *   "grpc status QUOTA_EXCEEDED"              — gRPC quota variant
 *   "Tokens per minute limit reached"
 *   "Service capacity exceeded"
 *
 * Examples that must NOT match:
 *   "Failed to generate a response"   — contains "rate" as infix of "generate"
 *   "Elaborate on the topic"          — contains "rate" as infix of "elaborate"
 *   "Error processing request"        — generic error, no quota meaning
 */
export function isUsageLimitError(message: string): boolean {
    for (const pattern of USAGE_LIMIT_PHRASES) {
        if (pattern.test(message)) {
            return true;
        }
    }
    return false;
}

/**
 * Returns true if the error message indicates provider capacity saturation
 * rather than a hard usage/quota limit.
 *
 * Examples that should match:
 *   "overloaded_error: Overloaded [status=200; ...]"
 *   "Error 529: overloaded"
 *   "Request throttled due to high traffic"
 *
 * Examples that must NOT match:
 *   "Failed to generate a response"   — unrelated
 *   "Service capacity exceeded"       — already covered by isUsageLimitError
 */
export function isProviderCapacityError(message: string): boolean {
    for (const pattern of PROVIDER_CAPACITY_PHRASES) {
        if (pattern.test(message)) {
            return true;
        }
    }
    return false;
}
