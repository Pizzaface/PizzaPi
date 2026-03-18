import { describe, test, expect } from "bun:test";
import { estimateMessagesSize, needsChunkedDelivery } from "./remote.js";

describe("estimateMessagesSize", () => {
    test("returns 2 for empty array", () => {
        expect(estimateMessagesSize([])).toBe(2);
    });

    test("estimates size for small messages", () => {
        const msgs = [
            { role: "user", content: "hello" },
            { role: "assistant", content: "hi" },
        ];
        const estimated = estimateMessagesSize(msgs);
        const actual = JSON.stringify(msgs).length;
        // Should be within 50% of actual (sampling adds overhead estimation)
        expect(estimated).toBeGreaterThan(actual * 0.5);
        expect(estimated).toBeLessThan(actual * 2);
    });

    test("estimates size for large messages with reasonable accuracy", () => {
        const bigContent = "x".repeat(10_000);
        const msgs = Array.from({ length: 100 }, (_, i) => ({
            role: i % 2 === 0 ? "user" : "assistant",
            content: `${bigContent}-${i}`,
        }));
        const estimated = estimateMessagesSize(msgs);
        const actual = JSON.stringify(msgs).length;
        // Within 50% — sampling is approximate
        expect(estimated).toBeGreaterThan(actual * 0.5);
        expect(estimated).toBeLessThan(actual * 2);
    });
});

describe("needsChunkedDelivery", () => {
    test("returns false for empty array", () => {
        expect(needsChunkedDelivery([])).toBe(false);
    });

    test("returns false for single message", () => {
        expect(needsChunkedDelivery([{ role: "user", content: "x" }])).toBe(false);
    });

    test("returns false for small messages", () => {
        const msgs = Array.from({ length: 10 }, (_, i) => ({
            role: "user",
            content: `message ${i}`,
        }));
        expect(needsChunkedDelivery(msgs)).toBe(false);
    });

    test("returns true for messages exceeding 10 MB threshold", () => {
        // Each message ~10 KB, 2000 messages ≈ 20 MB > 10 MB threshold
        const bigContent = "x".repeat(10_000);
        const msgs = Array.from({ length: 2000 }, (_, i) => ({
            role: i % 2 === 0 ? "user" : "assistant",
            content: `${bigContent}-${i}`,
        }));
        expect(needsChunkedDelivery(msgs)).toBe(true);
    });
});
