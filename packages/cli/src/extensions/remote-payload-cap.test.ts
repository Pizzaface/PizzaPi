import { describe, test, expect } from "bun:test";
import { estimateMessagesSize, needsChunkedDelivery, computeChunkBoundaries } from "./remote.js";

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
        // Within 50% — now iterates all messages, so very accurate
        expect(estimated).toBeGreaterThan(actual * 0.5);
        expect(estimated).toBeLessThan(actual * 2);
    });

    test("catches outlier-heavy distributions (few very large messages)", () => {
        // 1000 small messages + 6 x 2MB messages clustered at the end
        // Old sampling approach could miss these entirely
        const smallMsgs = Array.from({ length: 1000 }, (_, i) => ({
            role: "user",
            content: `msg ${i}`,
        }));
        const bigContent = "x".repeat(2_000_000);
        const bigMsgs = Array.from({ length: 6 }, () => ({
            role: "assistant",
            content: bigContent,
        }));
        const msgs = [...smallMsgs, ...bigMsgs];
        const estimated = estimateMessagesSize(msgs);
        const actual = JSON.stringify(msgs).length;
        // Must capture the ~12 MB of big messages — estimated should be >10 MB
        expect(estimated).toBeGreaterThan(10 * 1024 * 1024);
        // And within reasonable accuracy of actual
        expect(estimated).toBeGreaterThan(actual * 0.8);
        expect(estimated).toBeLessThan(actual * 1.5);
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

describe("computeChunkBoundaries", () => {
    test("returns single chunk for small messages", () => {
        const msgs = Array.from({ length: 5 }, (_, i) => ({ role: "user", content: `msg ${i}` }));
        const boundaries = computeChunkBoundaries(msgs);
        expect(boundaries).toEqual([[0, 5]]);
    });

    test("splits by message count at CHUNK_SIZE (200)", () => {
        const msgs = Array.from({ length: 450 }, (_, i) => ({ role: "user", content: `m${i}` }));
        const boundaries = computeChunkBoundaries(msgs);
        // 200 + 200 + 50 = 3 chunks
        expect(boundaries).toEqual([[0, 200], [200, 400], [400, 450]]);
    });

    test("splits by byte size when messages are large", () => {
        // 10 messages each ~2 MB — byte limit is 8 MB, so should get ~3 chunks
        const bigContent = "x".repeat(2_000_000);
        const msgs = Array.from({ length: 10 }, (_, i) => ({ role: "user", content: `${bigContent}-${i}` }));
        const boundaries = computeChunkBoundaries(msgs);

        // Should have more than 1 chunk (byte limit forces splits)
        expect(boundaries.length).toBeGreaterThan(1);

        // All messages should be covered
        const total = boundaries.reduce((sum, [s, e]) => sum + (e - s), 0);
        expect(total).toBe(10);

        // Each chunk should have ≤4 messages (each ~2 MB, limit 8 MB)
        for (const [start, end] of boundaries) {
            expect(end - start).toBeLessThanOrEqual(4);
        }
    });

    test("handles single message larger than byte limit", () => {
        // One message > 8 MB — must still produce a chunk (safety: advance by 1)
        const hugeContent = "x".repeat(10_000_000);
        const msgs = [{ role: "user", content: hugeContent }];
        const boundaries = computeChunkBoundaries(msgs);
        expect(boundaries).toEqual([[0, 1]]);
    });

    test("covers all messages without gaps", () => {
        const msgs = Array.from({ length: 500 }, (_, i) => ({ role: "user", content: `message-${i}` }));
        const boundaries = computeChunkBoundaries(msgs);

        // No gaps: each chunk starts where the previous ended
        for (let i = 1; i < boundaries.length; i++) {
            expect(boundaries[i][0]).toBe(boundaries[i - 1][1]);
        }
        // First starts at 0, last ends at length
        expect(boundaries[0][0]).toBe(0);
        expect(boundaries[boundaries.length - 1][1]).toBe(500);
    });
});
