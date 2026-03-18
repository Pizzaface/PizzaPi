import { describe, test, expect } from "bun:test";
import { computeBackoffDelay } from "./backoff.js";

describe("computeBackoffDelay", () => {
    test("first attempt returns approximately baseMs (±25% jitter by default)", () => {
        // With jitter ±25%, result should be in [750, 1250]
        for (let i = 0; i < 50; i++) {
            const delay = computeBackoffDelay(0);
            expect(delay).toBeGreaterThanOrEqual(750);
            expect(delay).toBeLessThanOrEqual(1250);
        }
    });

    test("second attempt returns approximately 2×baseMs (±25%)", () => {
        // 1000 * 2^1 = 2000, with ±25%: [1500, 2500]
        for (let i = 0; i < 50; i++) {
            const delay = computeBackoffDelay(1);
            expect(delay).toBeGreaterThanOrEqual(1500);
            expect(delay).toBeLessThanOrEqual(2500);
        }
    });

    test("third attempt returns approximately 4×baseMs (±25%)", () => {
        // 1000 * 2^2 = 4000, with ±25%: [3000, 5000]
        for (let i = 0; i < 50; i++) {
            const delay = computeBackoffDelay(2);
            expect(delay).toBeGreaterThanOrEqual(3000);
            expect(delay).toBeLessThanOrEqual(5000);
        }
    });

    test("caps at maxMs regardless of attempt count", () => {
        // At attempt 10, 1000 * 2^10 = 1_024_000 >> 30_000
        // With ±25% jitter: max is 30_000 * 1.25 = 37_500
        for (let i = 0; i < 50; i++) {
            const delay = computeBackoffDelay(10);
            expect(delay).toBeLessThanOrEqual(37_500);
        }
    });

    test("caps at maxMs for extreme attempt counts", () => {
        for (let i = 0; i < 50; i++) {
            const delay = computeBackoffDelay(100);
            expect(delay).toBeLessThanOrEqual(37_500);
        }
    });

    test("respects custom baseMs", () => {
        for (let i = 0; i < 50; i++) {
            const delay = computeBackoffDelay(0, { baseMs: 500 });
            expect(delay).toBeGreaterThanOrEqual(375); // 500 * 0.75
            expect(delay).toBeLessThanOrEqual(625);    // 500 * 1.25
        }
    });

    test("respects custom maxMs", () => {
        for (let i = 0; i < 50; i++) {
            const delay = computeBackoffDelay(10, { maxMs: 5_000 });
            expect(delay).toBeLessThanOrEqual(6_250); // 5000 * 1.25
        }
    });

    test("zero jitterFactor produces deterministic exponential values", () => {
        expect(computeBackoffDelay(0, { jitterFactor: 0 })).toBe(1000);
        expect(computeBackoffDelay(1, { jitterFactor: 0 })).toBe(2000);
        expect(computeBackoffDelay(2, { jitterFactor: 0 })).toBe(4000);
        expect(computeBackoffDelay(3, { jitterFactor: 0 })).toBe(8000);
        expect(computeBackoffDelay(4, { jitterFactor: 0 })).toBe(16_000);
        expect(computeBackoffDelay(5, { jitterFactor: 0 })).toBe(30_000); // capped at maxMs
        expect(computeBackoffDelay(6, { jitterFactor: 0 })).toBe(30_000);
    });

    test("never returns negative values even with extreme jitter", () => {
        for (let i = 0; i < 100; i++) {
            expect(computeBackoffDelay(0, { jitterFactor: 1.0 })).toBeGreaterThanOrEqual(0);
        }
    });

    test("returns integer milliseconds (Math.round)", () => {
        for (let i = 0; i < 20; i++) {
            const delay = computeBackoffDelay(0);
            expect(Number.isInteger(delay)).toBe(true);
        }
    });

    test("grows monotonically in the median (no jitter)", () => {
        const delays = [0, 1, 2, 3, 4, 5].map((a) => computeBackoffDelay(a, { jitterFactor: 0 }));
        for (let i = 1; i < delays.length - 1; i++) {
            // Each uncapped step should be 2× previous
            if (delays[i] < 30_000) {
                expect(delays[i]).toBe(delays[i - 1] * 2);
            }
        }
    });
});
