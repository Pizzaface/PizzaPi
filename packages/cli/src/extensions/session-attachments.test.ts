import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

// Override the storage root before importing the module
const testRoot = mkdtempSync(join(tmpdir(), "session-attachments-test-"));
process.env.PIZZAPI_SESSION_ATTACHMENTS_DIR = testRoot;

import {
    saveSessionAttachment,
    listSessionAttachments,
    cleanupSessionAttachments,
    getSessionAttachmentDir,
    sweepOrphanedAttachments,
} from "./session-attachments.js";

afterEach(() => {
    // Clean up test root between tests
    try {
        rmSync(testRoot, { recursive: true, force: true });
    } catch {}
});

describe("session-attachments", () => {
    describe("saveSessionAttachment", () => {
        test("saves a file and creates metadata sidecar", async () => {
            const data = Buffer.from("hello world");
            const result = await saveSessionAttachment(
                "session-123",
                "test.txt",
                "text/plain",
                data,
            );

            expect(result.filePath).toContain("session-123");
            expect(result.meta.filename).toBe("test.txt");
            expect(result.meta.mediaType).toBe("text/plain");
            expect(result.meta.size).toBe(11);
            expect(result.meta.storedAs).toBe("test.txt");
            expect(result.meta.savedAt).toBeTruthy();

            // Verify file contents
            const stored = readFileSync(result.filePath);
            expect(stored.toString()).toBe("hello world");

            // Verify metadata sidecar
            const metaPath = `${result.filePath}.meta.json`;
            const meta = JSON.parse(readFileSync(metaPath, "utf-8"));
            expect(meta.filename).toBe("test.txt");
            expect(meta.mediaType).toBe("text/plain");
        });

        test("sanitizes filenames", async () => {
            const data = Buffer.from("content");
            const result = await saveSessionAttachment(
                "session-123",
                "my file (1).txt",
                "text/plain",
                data,
            );

            expect(result.meta.storedAs).toBe("my_file__1_.txt");
            expect(result.meta.filename).toBe("my file (1).txt"); // original preserved in meta
        });

        test("deduplicates filenames", async () => {
            const data = Buffer.from("content");

            const first = await saveSessionAttachment("session-456", "photo.png", "image/png", data);
            const second = await saveSessionAttachment("session-456", "photo.png", "image/png", data);
            const third = await saveSessionAttachment("session-456", "photo.png", "image/png", data);

            expect(first.meta.storedAs).toBe("photo.png");
            expect(second.meta.storedAs).toBe("photo-2.png");
            expect(third.meta.storedAs).toBe("photo-3.png");
        });

        test("handles files without extensions", async () => {
            const data = Buffer.from("binary");
            const result = await saveSessionAttachment(
                "session-789",
                "Dockerfile",
                "application/octet-stream",
                data,
            );

            expect(result.meta.storedAs).toBe("Dockerfile");
        });

        test("uses fallback name when filename is empty", async () => {
            const data = Buffer.from("data");
            const result = await saveSessionAttachment(
                "session-abc",
                "",
                "image/png",
                data,
            );

            expect(result.meta.storedAs).toBe("attachment");
        });
    });

    describe("listSessionAttachments", () => {
        test("returns empty array for non-existent session", async () => {
            const result = await listSessionAttachments("no-such-session");
            expect(result).toEqual([]);
        });

        test("lists all saved attachments", async () => {
            await saveSessionAttachment("session-list", "a.txt", "text/plain", Buffer.from("aaa"));
            await saveSessionAttachment("session-list", "b.png", "image/png", Buffer.from("bbb"));

            const list = await listSessionAttachments("session-list");
            expect(list).toHaveLength(2);

            const filenames = list.map((m) => m.filename).sort();
            expect(filenames).toEqual(["a.txt", "b.png"]);
        });
    });

    describe("cleanupSessionAttachments", () => {
        test("removes the session attachment directory", async () => {
            await saveSessionAttachment("session-clean", "file.txt", "text/plain", Buffer.from("x"));
            const dir = getSessionAttachmentDir("session-clean");

            // Verify it exists
            expect(readdirSync(dir).length).toBeGreaterThan(0);

            await cleanupSessionAttachments("session-clean");

            // Verify it's gone
            expect(() => readdirSync(dir)).toThrow();
        });

        test("no-op for non-existent session", async () => {
            // Should not throw
            await cleanupSessionAttachments("does-not-exist");
        });
    });

    describe("getSessionAttachmentDir", () => {
        test("returns a path containing the session ID", () => {
            const dir = getSessionAttachmentDir("my-session-id");
            expect(dir).toContain("my-session-id");
        });
    });

    describe("concurrent saves (mutex)", () => {
        test("concurrent saves with same filename produce unique files", async () => {
            const sessionId = "session-concurrent";
            const data = Buffer.from("content");

            // Fire multiple saves concurrently with the same filename
            const results = await Promise.all([
                saveSessionAttachment(sessionId, "file.txt", "text/plain", data),
                saveSessionAttachment(sessionId, "file.txt", "text/plain", data),
                saveSessionAttachment(sessionId, "file.txt", "text/plain", data),
            ]);

            // Each should have a unique storedAs filename
            const storedNames = results.map((r) => r.meta.storedAs);
            const unique = new Set(storedNames);
            expect(unique.size).toBe(3);

            // All files should exist
            for (const result of results) {
                const stored = readFileSync(result.filePath);
                expect(stored.toString()).toBe("content");
            }
        });
    });

    describe("sweepOrphanedAttachments", () => {
        test("removes directories for sessions not in active set", async () => {
            // Create attachments for two sessions
            await saveSessionAttachment("session-alive", "f.txt", "text/plain", Buffer.from("a"));
            await saveSessionAttachment("session-dead", "f.txt", "text/plain", Buffer.from("b"));

            // Only session-alive is active
            const removed = await sweepOrphanedAttachments(new Set(["session-alive"]));
            expect(removed).toBe(1);

            // session-alive should still exist
            const alive = await listSessionAttachments("session-alive");
            expect(alive).toHaveLength(1);

            // session-dead should be gone
            const dead = await listSessionAttachments("session-dead");
            expect(dead).toHaveLength(0);
        });

        test("returns 0 when root directory does not exist", async () => {
            // Clean up root first
            rmSync(testRoot, { recursive: true, force: true });
            const removed = await sweepOrphanedAttachments(new Set());
            expect(removed).toBe(0);
        });

        test("removes all directories when no sessions are active", async () => {
            await saveSessionAttachment("session-x", "f.txt", "text/plain", Buffer.from("x"));
            await saveSessionAttachment("session-y", "f.txt", "text/plain", Buffer.from("y"));

            const removed = await sweepOrphanedAttachments(new Set());
            expect(removed).toBe(2);
        });

        test("no-op when all directories match active sessions", async () => {
            await saveSessionAttachment("session-a", "f.txt", "text/plain", Buffer.from("a"));
            await saveSessionAttachment("session-b", "f.txt", "text/plain", Buffer.from("b"));

            const removed = await sweepOrphanedAttachments(new Set(["session-a", "session-b"]));
            expect(removed).toBe(0);
        });

        test("preserves directories for active sessions whose IDs contain sanitized characters", async () => {
            // Session IDs with '/' or ':' get sanitized to '_' when stored as directory names.
            // The orphan sweep must compare sanitized IDs so that a running session like
            // "runner/abc:1" (stored as "runner_abc_1") is not falsely treated as an orphan.
            const rawId = "runner/abc:1";
            await saveSessionAttachment(rawId, "f.txt", "text/plain", Buffer.from("hi"));

            // Pass the raw (unsanitized) ID as active
            const removed = await sweepOrphanedAttachments(new Set([rawId]));
            expect(removed).toBe(0);

            // Directory should still be there
            const files = await listSessionAttachments(rawId);
            expect(files).toHaveLength(1);
        });
    });
});
