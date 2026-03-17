import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { normalizeRemoteInputAttachments, parseDataUrl, isTextMimeType, buildUserMessageFromRemoteInput } from "./remote-input.js";

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

    describe("isTextMimeType", () => {
        test("recognizes text/* MIME types", () => {
            expect(isTextMimeType("text/plain")).toBe(true);
            expect(isTextMimeType("text/html")).toBe(true);
            expect(isTextMimeType("text/csv")).toBe(true);
            expect(isTextMimeType("text/markdown")).toBe(true);
        });

        test("recognizes known text application types", () => {
            expect(isTextMimeType("application/json")).toBe(true);
            expect(isTextMimeType("application/xml")).toBe(true);
            expect(isTextMimeType("application/yaml")).toBe(true);
            expect(isTextMimeType("application/javascript")).toBe(true);
            expect(isTextMimeType("application/typescript")).toBe(true);
            expect(isTextMimeType("application/sql")).toBe(true);
        });

        test("rejects binary MIME types", () => {
            expect(isTextMimeType("application/octet-stream")).toBe(false);
            expect(isTextMimeType("application/pdf")).toBe(false);
            expect(isTextMimeType("application/zip")).toBe(false);
            expect(isTextMimeType("image/png")).toBe(false);
            expect(isTextMimeType("audio/mpeg")).toBe(false);
        });

        test("falls back to filename extension for generic MIME", () => {
            expect(isTextMimeType("application/octet-stream", "config.json")).toBe(true);
            expect(isTextMimeType("application/octet-stream", "script.py")).toBe(true);
            expect(isTextMimeType("application/octet-stream", "README.md")).toBe(true);
            expect(isTextMimeType("application/octet-stream", "styles.css")).toBe(true);
            expect(isTextMimeType("application/octet-stream", "Dockerfile")).toBe(false); // no extension
            expect(isTextMimeType("application/octet-stream", "archive.zip")).toBe(false);
        });

        test("is case-insensitive for MIME types", () => {
            expect(isTextMimeType("TEXT/PLAIN")).toBe(true);
            expect(isTextMimeType("Application/JSON")).toBe(true);
        });

        test("is case-insensitive for file extensions", () => {
            expect(isTextMimeType("application/octet-stream", "DATA.JSON")).toBe(true);
            expect(isTextMimeType("application/octet-stream", "CODE.PY")).toBe(true);
        });
    });

    describe("buildUserMessageFromRemoteInput", () => {
        test("returns plain text when no attachments", async () => {
            const result = await buildUserMessageFromRemoteInput("hello", [], "", "");
            expect(result).toBe("hello");
        });

        test("includes image attachments as image parts", async () => {
            const attachments = [{ url: "data:image/png;base64,iVBOR" }];
            const result = await buildUserMessageFromRemoteInput("look", attachments, "", "");
            expect(result).toEqual([
                { type: "text", text: "look" },
                { type: "image", mimeType: "image/png", data: "iVBOR" },
            ]);
        });

        // --- Fallback (no sessionId): text files are inlined ---

        test("inlines text file content when no sessionId provided", async () => {
            const content = Buffer.from("hello world").toString("base64");
            const attachments = [{ url: `data:text/plain;base64,${content}`, filename: "notes.txt" }];
            const result = await buildUserMessageFromRemoteInput("see this", attachments, "", "");
            expect(result).toEqual([
                { type: "text", text: "see this" },
                { type: "text", text: "--- notes.txt ---\nhello world\n--- end notes.txt ---" },
            ]);
        });

        test("inlines JSON attachment via application/json MIME when no sessionId", async () => {
            const json = JSON.stringify({ key: "value" });
            const content = Buffer.from(json).toString("base64");
            const attachments = [{ url: `data:application/json;base64,${content}`, filename: "data.json" }];
            const result = await buildUserMessageFromRemoteInput("", attachments, "", "");
            expect(result).toEqual([
                { type: "text", text: `--- data.json ---\n${json}\n--- end data.json ---` },
            ]);
        });

        test("inlines text file by extension when MIME is generic and no sessionId", async () => {
            const content = Buffer.from("print('hi')").toString("base64");
            const attachments = [{ url: `data:application/octet-stream;base64,${content}`, filename: "script.py" }];
            const result = await buildUserMessageFromRemoteInput("run this", attachments, "", "");
            expect(result).toEqual([
                { type: "text", text: "run this" },
                { type: "text", text: "--- script.py ---\nprint('hi')\n--- end script.py ---" },
            ]);
        });

        // --- With sessionId: text files are saved to runner and referenced by path ---

        describe("with sessionId (file saved to runner)", () => {
            let tmpDir: string;

            beforeEach(() => {
                tmpDir = mkdtempSync(join(tmpdir(), "pizzapi-remote-input-test-"));
                process.env.PIZZAPI_SESSION_ATTACHMENTS_DIR = tmpDir;
            });

            afterEach(() => {
                delete process.env.PIZZAPI_SESSION_ATTACHMENTS_DIR;
                try { rmSync(tmpDir, { recursive: true, force: true }); } catch {}
            });

            test("references saved path instead of inlining text file content", async () => {
                const content = Buffer.from("hello world").toString("base64");
                const attachments = [{ url: `data:text/plain;base64,${content}`, filename: "notes.txt" }];
                const result = await buildUserMessageFromRemoteInput("see this", attachments, "", "", "test-session-123");
                expect(result).toEqual([
                    { type: "text", text: "see this" },
                    { type: "text", text: expect.stringContaining("[Attached file saved to runner:") },
                ]);
                const msg = (result as any[])[1].text as string;
                expect(msg).toContain("notes.txt");
                expect(msg).not.toContain("hello world");
            });

            test("references saved path for markdown files", async () => {
                const content = Buffer.from("# My Agent\nDoes stuff.").toString("base64");
                const attachments = [{ url: `data:text/markdown;base64,${content}`, filename: "agent.md" }];
                const result = await buildUserMessageFromRemoteInput("use this", attachments, "", "", "sess-abc");
                const parts = result as any[];
                expect(parts).toHaveLength(2);
                expect(parts[1].text).toContain("[Attached file saved to runner:");
                expect(parts[1].text).toContain("agent.md");
                expect(parts[1].text).not.toContain("My Agent");
            });

            test("still sends images as base64 image parts even with sessionId", async () => {
                const attachments = [{ url: "data:image/png;base64,iVBOR" }];
                const result = await buildUserMessageFromRemoteInput("look", attachments, "", "", "sess-img");
                expect(result).toEqual([
                    { type: "text", text: "look" },
                    { type: "image", mimeType: "image/png", data: "iVBOR" },
                ]);
            });

            test("binary files still get placeholder even with sessionId", async () => {
                const content = Buffer.from([0x50, 0x4b, 0x03, 0x04]).toString("base64");
                const attachments = [{ url: `data:application/zip;base64,${content}`, filename: "archive.zip" }];
                const result = await buildUserMessageFromRemoteInput("", attachments, "", "", "sess-bin");
                expect(result).toEqual([
                    { type: "text", text: "[Attachment provided by web client: archive.zip — binary content not included]" },
                ]);
            });
        });

        test("shows binary placeholder for non-text non-image files", async () => {
            const content = Buffer.from([0x50, 0x4b, 0x03, 0x04]).toString("base64"); // zip magic bytes
            const attachments = [{ url: `data:application/zip;base64,${content}`, filename: "archive.zip" }];
            const result = await buildUserMessageFromRemoteInput("", attachments, "", "");
            expect(result).toEqual([
                { type: "text", text: "[Attachment provided by web client: archive.zip — binary content not included]" },
            ]);
        });

        test("handles mix of image, text, and binary attachments", async () => {
            const textContent = Buffer.from("# README").toString("base64");
            const attachments = [
                { url: "data:image/jpeg;base64,/9j/4" },
                { url: `data:text/markdown;base64,${textContent}`, filename: "README.md" },
                { url: `data:application/pdf;base64,JVBERi`, filename: "doc.pdf" },
            ];
            const result = await buildUserMessageFromRemoteInput("files", attachments, "", "") as unknown[];
            expect(result).toHaveLength(4);
            expect((result[0] as any).type).toBe("text");
            expect((result[1] as any).type).toBe("image");
            expect((result[2] as any).text).toContain("# README");
            expect((result[3] as any).text).toContain("binary content not included");
        });
    });
});
