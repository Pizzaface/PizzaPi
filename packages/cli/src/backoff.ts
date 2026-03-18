/**
 * Exponential backoff with jitter for relay WebSocket reconnections.
 *
 * Used to configure Socket.IO's built-in reconnection delays and also
 * available as a standalone utility for tests and future use.
 */

export interface BackoffOptions {
    /** Initial delay in milliseconds. Default: 1000 (1 s) */
    baseMs?: number;
    /** Maximum delay in milliseconds. Default: 30_000 (30 s) */
    maxMs?: number;
    /**
     * Jitter factor as a fraction of the computed base delay.
     * `0.25` means ±25% randomization. Default: 0.25
     */
    jitterFactor?: number;
}

/**
 * Compute the delay for a reconnection attempt using exponential backoff with jitter.
 *
 * @param attempt - 0-indexed attempt number (0 = first retry)
 * @param options - Backoff configuration overrides
 * @returns Delay in milliseconds, always ≥ 0 and rounded to integer
 *
 * Algorithm:
 *   base   = min(baseMs × 2^attempt, maxMs)
 *   jitter = base × jitterFactor × random(−1, 1)
 *   result = round(max(0, base + jitter))
 */
export function computeBackoffDelay(attempt: number, options?: BackoffOptions): number {
    const baseMs = options?.baseMs ?? 1000;
    const maxMs = options?.maxMs ?? 30_000;
    const jitterFactor = options?.jitterFactor ?? 0.25;

    const exponential = baseMs * Math.pow(2, attempt);
    const base = Math.min(exponential, maxMs);
    const jitter = base * jitterFactor * (Math.random() * 2 - 1);
    return Math.round(Math.max(0, base + jitter));
}

/**
 * Default backoff parameters used for the CLI relay Socket.IO connection.
 * These values are passed directly to Socket.IO's reconnection config.
 */
export const RELAY_BACKOFF_DEFAULTS = {
    /** Base reconnection delay (ms). Socket.IO: reconnectionDelay */
    baseMs: 1000,
    /** Maximum reconnection delay (ms). Socket.IO: reconnectionDelayMax */
    maxMs: 30_000,
    /**
     * Jitter factor (0–1). Socket.IO: randomizationFactor
     * 0.25 = ±25% randomization applied to each computed delay.
     */
    jitterFactor: 0.25,
} as const;
