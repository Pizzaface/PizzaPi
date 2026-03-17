import { describe, test, expect } from "bun:test";
import { extractImages, estimateBase64Bytes } from "./strip-images.js";

// ── estimateBase64Bytes ──────────────────────────────────────────────────────

describe("estimateBase64Bytes", () => {
    test("estimates bytes for simple base64", () => {
        // "aGVsbG8=" decodes to "hello" (5 bytes)
        expect(estimateBase64Bytes("aGVsbG8=")).toBe(5);
    });

    test("handles data URI prefix", () => {
        expect(estimateBase64Bytes("data:image/png;base64,aGVsbG8=")).toBe(5);
    });

    test("returns 0 for empty string", () => {
        expect(estimateBase64Bytes("")).toBe(0);
    });
});

// ── extractImages ────────────────────────────────────────────────────────────

// Helper to create a fake base64 string of a given decoded byte size
function fakeBase64(decodedBytes: number): string {
    // Each 3 bytes encodes to 4 base64 chars. Use 'A' (zero byte in base64).
    const chars = Math.ceil((decodedBytes * 4) / 3);
    return "A".repeat(chars);
}

describe("extractImages", () => {
    test("returns original messages when no images present", () => {
        const messages = [
            { role: "user", content: [{ type: "text", text: "hello" }] },
            { role: "assistant", content: [{ type: "text", text: "hi" }] },
        ];
        const result = extractImages(messages, "session-1");
        expect(result.extracted).toHaveLength(0);
        expect(result.savedBytes).toBe(0);
        // Should return the exact same references (no copy)
        expect(result.messages[0]).toBe(messages[0]);
        expect(result.messages[1]).toBe(messages[1]);
    });

    test("skips small images below threshold", () => {
        const smallBase64 = fakeBase64(5000); // 5 KB — below 10 KB threshold
        const messages = [
            {
                role: "user",
                content: [
                    { type: "image", source: { type: "base64", media_type: "image/png", data: smallBase64 } },
                ],
            },
        ];
        const result = extractImages(messages, "session-1");
        expect(result.extracted).toHaveLength(0);
    });

    test("extracts large images from source.data", () => {
        const largeBase64 = fakeBase64(50_000); // 50 KB
        const messages = [
            {
                role: "user",
                content: [
                    { type: "text", text: "check this screenshot" },
                    {
                        type: "image",
                        source: { type: "base64", media_type: "image/png", data: largeBase64 },
                    },
                ],
            },
        ];
        const result = extractImages(messages, "session-1");

        expect(result.extracted).toHaveLength(1);
        expect(result.extracted[0].mimeType).toBe("image/png");
        expect(result.extracted[0].base64Data).toBe(largeBase64);
        expect(result.savedBytes).toBeGreaterThan(0);

        // Check replacement block
        const content = (result.messages[0] as any).content;
        expect(content[0].type).toBe("text"); // text block unchanged
        const imgBlock = content[1];
        expect(imgBlock.type).toBe("image");
        expect(imgBlock.source.extracted).toBe(true);
        expect(imgBlock.source.url).toMatch(/^\/api\/attachments\//);
        expect(imgBlock.source.data).toBeUndefined();
        expect(imgBlock.source.originalSizeBytes).toBeGreaterThan(0);
    });

    test("extracts images from top-level b.data field", () => {
        const largeBase64 = fakeBase64(50_000);
        const messages = [
            {
                role: "assistant",
                content: [
                    { type: "image", data: largeBase64, mimeType: "image/jpeg" },
                ],
            },
        ];
        const result = extractImages(messages, "session-1");

        expect(result.extracted).toHaveLength(1);
        expect(result.extracted[0].mimeType).toBe("image/jpeg");

        const imgBlock = (result.messages[0] as any).content[0];
        expect(imgBlock.data).toBeUndefined();
        expect(imgBlock.source.extracted).toBe(true);
        expect(imgBlock.source.url).toBeDefined();
    });

    test("skips already-extracted images", () => {
        const messages = [
            {
                role: "assistant",
                content: [
                    {
                        type: "image",
                        source: {
                            type: "url",
                            url: "/api/attachments/some-id",
                            extracted: true,
                        },
                    },
                ],
            },
        ];
        const result = extractImages(messages, "session-1");
        expect(result.extracted).toHaveLength(0);
        expect(result.messages[0]).toBe(messages[0]); // same reference
    });

    test("handles multiple images across multiple messages", () => {
        const img1 = fakeBase64(100_000);
        const img2 = fakeBase64(200_000);
        const messages = [
            {
                role: "user",
                content: [
                    { type: "image", source: { type: "base64", media_type: "image/png", data: img1 } },
                ],
            },
            {
                role: "assistant",
                content: [
                    { type: "text", text: "I see it" },
                ],
            },
            {
                role: "user",
                content: [
                    { type: "image", source: { type: "base64", media_type: "image/jpeg", data: img2 } },
                ],
            },
        ];
        const result = extractImages(messages, "session-1");

        expect(result.extracted).toHaveLength(2);
        // Middle message (text only) should be unchanged reference
        expect(result.messages[1]).toBe(messages[1]);
    });

    test("handles messages without content array", () => {
        const messages = [
            { role: "system", text: "You are helpful" },
            null,
            "bare string",
            42,
        ];
        const result = extractImages(messages as unknown[], "session-1");
        expect(result.extracted).toHaveLength(0);
        // All returned as-is
        expect(result.messages[0]).toBe(messages[0]);
        expect(result.messages[1]).toBe(messages[1]);
    });

    test("preserves all non-image content blocks", () => {
        const largeBase64 = fakeBase64(50_000);
        const messages = [
            {
                role: "assistant",
                content: [
                    { type: "text", text: "Here's the screenshot:" },
                    { type: "image", source: { type: "base64", media_type: "image/png", data: largeBase64 } },
                    { type: "tool_use", id: "tool-1", name: "bash", input: { command: "ls" } },
                ],
            },
        ];
        const result = extractImages(messages, "session-1");
        const content = (result.messages[0] as any).content;

        expect(content).toHaveLength(3);
        expect(content[0]).toEqual({ type: "text", text: "Here's the screenshot:" });
        expect(content[1].source.extracted).toBe(true);
        expect(content[2]).toEqual({ type: "tool_use", id: "tool-1", name: "bash", input: { command: "ls" } });
    });

    test("defaults to image/png when no mime type specified", () => {
        const largeBase64 = fakeBase64(50_000);
        const messages = [
            {
                role: "user",
                content: [
                    { type: "image", source: { type: "base64", data: largeBase64 } },
                ],
            },
        ];
        const result = extractImages(messages, "session-1");
        expect(result.extracted[0].mimeType).toBe("image/png");
    });
});
