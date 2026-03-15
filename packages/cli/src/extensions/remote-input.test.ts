import { describe, test, expect } from "bun:test";
import { normalizeRemoteInputAttachments, parseDataUrl } from "./remote-input.js";

describe("remote-input", () => {
    describe("normalizeRemoteInputAttachments", () => {
        test("returns empty array for non-array input", () => {
            expect(normalizeRemoteInputAttachments(null)).toEqual([]);
            expect(normalizeRemoteInputAttachments(undefined)).toEqual([]);
            expect(normalizeRemoteInputAttachments("not an array")).toEqual([]);
            expect(normalizeRemoteInputAttachments(42)).toEqual([]);
        });

        test("filters out items without attachmentId or url", () => {
            const result = normalizeRemoteInputAttachments([
                { mediaType: "image/png" }, // no id or url
                { attachmentId: "" }, // empty id
                { url: "" }, // empty url
            ]);
            expect(result).toEqual([]);
        });

        test("normalizes valid attachments", () => {
            const result = normalizeRemoteInputAttachments([
                { attachmentId: "abc123", mediaType: "image/png", filename: "test.png" },
                { url: "data:image/jpeg;base64,abc" },
            ]);
            expect(result).toHaveLength(2);
            expect(result[0].attachmentId).toBe("abc123");
            expect(result[0].mediaType).toBe("image/png");
            expect(result[1].url).toBe("data:image/jpeg;base64,abc");
        });

        test("ignores non-string fields", () => {
            const result = normalizeRemoteInputAttachments([
                { attachmentId: 42, url: "data:text/plain;base64,aGVsbG8=" },
            ]);
            expect(result).toHaveLength(1);
            expect(result[0].attachmentId).toBeUndefined();
            expect(result[0].url).toBe("data:text/plain;base64,aGVsbG8=");
        });
    });

    describe("parseDataUrl", () => {
        test("parses valid data URLs", () => {
            const result = parseDataUrl("data:image/png;base64,iVBOR...");
            expect(result).toEqual({
                mediaType: "image/png",
                data: "iVBOR...",
            });
        });

        test("returns null for non-data URLs", () => {
            expect(parseDataUrl("https://example.com/image.png")).toBeNull();
            expect(parseDataUrl("")).toBeNull();
            expect(parseDataUrl("data:nope")).toBeNull();
        });

        test("defaults media type to application/octet-stream", () => {
            const result = parseDataUrl("data:;base64,abc");
            expect(result).toEqual({
                mediaType: "application/octet-stream",
                data: "abc",
            });
        });
    });
});
