import { describe, test, expect } from "bun:test";
import { capMessagesPayload } from "./remote.js";

describe("capMessagesPayload", () => {
    test("returns original array when small", () => {
        const msgs = [
            { role: "user", content: "hello" },
            { role: "assistant", content: "hi" },
        ];
        const result = capMessagesPayload(msgs);
        expect(result).toBe(msgs); // same reference — no copy
    });

    test("returns original for empty array", () => {
        expect(capMessagesPayload([])).toEqual([]);
    });

    test("returns original for single message", () => {
        const msgs = [{ role: "user", content: "x" }];
        expect(capMessagesPayload(msgs)).toBe(msgs);
    });

    test("truncates oversized messages array and prepends marker", () => {
        // Create a large array — each message ~10 KB, 10_000 messages ≈ 100 MB estimated
        const bigContent = "x".repeat(10_000);
        const msgs = Array.from({ length: 10_000 }, (_, i) => ({
            role: i % 2 === 0 ? "user" : "assistant",
            content: `${bigContent}-${i}`,
        }));

        const result = capMessagesPayload(msgs);

        // Should be truncated
        expect(result.length).toBeLessThan(msgs.length);
        expect(result.length).toBeGreaterThan(1);

        // First element should be the truncation marker
        const marker = result[0] as { role: string; content: string };
        expect(marker.role).toBe("system");
        expect(marker.content).toContain("truncated");
        expect(marker.content).toContain(String(msgs.length));

        // Remaining elements should be from the END of the original array
        const lastOriginal = msgs[msgs.length - 1] as { content: string };
        const lastResult = result[result.length - 1] as { content: string };
        expect(lastResult.content).toBe(lastOriginal.content);
    });
});
