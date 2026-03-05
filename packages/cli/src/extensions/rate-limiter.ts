/**
 * Simple sliding-window rate limiter.
 *
 * Tracks event timestamps within a configurable window and rejects events
 * when the count exceeds the maximum. Used for both completion hook emissions
 * and message injections (PizzaPi-7x0.3 / 7x0.4).
 */
export class RateLimiter {
    private timestamps: number[] = [];

    constructor(
        /** Maximum number of events allowed within the window. */
        readonly maxEvents: number = 5,
        /** Window duration in milliseconds. */
        readonly windowMs: number = 60_000,
    ) {}

    /** Returns true if the next event would exceed the rate limit. */
    isLimited(): boolean {
        this.prune();
        return this.timestamps.length >= this.maxEvents;
    }

    /** Record that an event occurred now. */
    record(): void {
        this.timestamps.push(Date.now());
    }

    /** Check if limited, and if not, record the event. Returns true if the event was allowed. */
    tryRecord(): boolean {
        if (this.isLimited()) return false;
        this.record();
        return true;
    }

    /** Reset all tracked events. */
    reset(): void {
        this.timestamps = [];
    }

    /** Number of events in the current window. */
    get count(): number {
        this.prune();
        return this.timestamps.length;
    }

    private prune(): void {
        const cutoff = Date.now() - this.windowMs;
        while (this.timestamps.length > 0 && this.timestamps[0] <= cutoff) {
            this.timestamps.shift();
        }
    }
}
