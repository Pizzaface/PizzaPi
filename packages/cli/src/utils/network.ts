/**
 * Network utilities for CLI operations.
 * Provides timeout wrappers for fetch operations.
 */

/**
 * Default timeout for network operations (30 seconds).
 */
export const DEFAULT_TIMEOUT_MS = 30_000;

/**
 * Extended timeout for slow operations like large file transfers (60 seconds).
 */
export const SLOW_OPERATION_TIMEOUT_MS = 60_000;

/**
 * Error thrown when a network operation times out.
 */
export class NetworkTimeoutError extends Error {
    constructor(
        public readonly operation: string,
        public readonly timeoutMs: number
    ) {
        super(`Network operation "${operation}" timed out after ${timeoutMs}ms`);
        this.name = "NetworkTimeoutError";
    }
}

/**
 * Creates an AbortController with a timeout that automatically aborts.
 * Returns both the signal and a cleanup function to clear the timeout.
 *
 * @param timeoutMs - Timeout in milliseconds (default: DEFAULT_TIMEOUT_MS)
 * @param operation - Optional operation name for error messages
 * @returns Object containing the signal and cleanup function
 */
export function createTimeoutController(
    timeoutMs: number = DEFAULT_TIMEOUT_MS,
    operation?: string
): { signal: AbortSignal; cleanup: () => void; controller: AbortController } {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => {
        controller.abort(new NetworkTimeoutError(operation ?? "fetch", timeoutMs));
    }, timeoutMs);

    const cleanup = () => clearTimeout(timeoutId);

    return { signal: controller.signal, cleanup, controller };
}

/**
 * Wrapper around fetch that adds a timeout.
 *
 * @param url - URL to fetch
 * @param init - Fetch init options (signal will be overridden if timeout is used)
 * @param options - Timeout options
 * @returns Response from fetch
 * @throws NetworkTimeoutError if the request times out
 */
export async function fetchWithTimeout(
    url: string | URL,
    init?: RequestInit,
    options: {
        timeoutMs?: number;
        operation?: string;
        /** If true, combine timeout with existing signal via AbortSignal.any */
        combineSignals?: boolean;
    } = {}
): Promise<Response> {
    const { timeoutMs = DEFAULT_TIMEOUT_MS, operation, combineSignals = true } = options;

    const { signal: timeoutSignal, cleanup } = createTimeoutController(timeoutMs, operation);

    let signal: AbortSignal;
    if (init?.signal && combineSignals) {
        // Combine the timeout signal with any existing signal
        signal = AbortSignal.any([init.signal, timeoutSignal]);
    } else {
        signal = timeoutSignal;
    }

    try {
        return await fetch(url, { ...init, signal });
    } finally {
        cleanup();
    }
}

/**
 * Utility to check if an error is an abort error (either from timeout or user cancellation).
 */
export function isAbortError(error: unknown): boolean {
    if (error instanceof Error) {
        return error.name === "AbortError" || error instanceof NetworkTimeoutError;
    }
    return false;
}
