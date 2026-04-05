import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, writeFileSync, mkdirSync, rmSync, readFileSync, existsSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { tmpdir, homedir } from "node:os";

// Override HOME before importing the module so cache persistence goes to a temp dir
const originalHome = process.env.HOME;
const fakeHome = mkdtempSync(join(tmpdir(), "slc-home-"));
process.env.HOME = fakeHome;
mkdirSync(join(fakeHome, ".pizzapi"), { recursive: true });

// Dynamic import after HOME override
const { listSessionsCached, invalidateSessionListCache, flushSessionListCache } = await import("./session-list-cache.js");

// ── Helpers ──────────────────────────────────────────────────────────────────

function makeSessionDir(): string {
    const dir = mkdtempSync(join(tmpdir(), "slc-sessions-"));
    return dir;
}

function writeSessionFile(dir: string, filename: string, opts: {
    id?: string;
    cwd?: string;
    name?: string;
    messages?: Array<{ role: string; content: string }>;
} = {}): string {
    const id = opts.id ?? `session-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    const cwd = opts.cwd ?? "/tmp/test-project";
    const now = new Date().toISOString();

    const lines: string[] = [];

    // Header
    lines.push(JSON.stringify({
        type: "session",
        version: 3,
        id,
        timestamp: now,
        cwd,
    }));

    // Session name
    if (opts.name) {
        lines.push(JSON.stringify({
            type: "session_info",
            id: `info-${Date.now()}`,
            parentId: null,
            timestamp: now,
            name: opts.name,
        }));
    }

    // Messages
    for (const msg of opts.messages ?? []) {
        lines.push(JSON.stringify({
            type: "message",
            id: `msg-${Date.now()}-${Math.random().toString(36).slice(2)}`,
            parentId: null,
            timestamp: now,
            message: {
                role: msg.role,
                content: msg.content,
                timestamp: Date.now(),
            },
        }));
    }

    const filePath = join(dir, filename);
    writeFileSync(filePath, lines.join("\n") + "\n");
    return filePath;
}

// ── Tests ────────────────────────────────────────────────────────────────────

describe("session-list-cache", () => {
    let sessionDir: string;

    beforeEach(() => {
        invalidateSessionListCache();
        sessionDir = makeSessionDir();
    });

    afterEach(() => {
        try { rmSync(sessionDir, { recursive: true, force: true }); } catch {}
    });

    test("returns empty for nonexistent directory", async () => {
        const results = await listSessionsCached("/tmp/does-not-exist-slc-" + Date.now());
        expect(results).toEqual([]);
    });

    test("returns empty for empty directory", async () => {
        const results = await listSessionsCached(sessionDir);
        expect(results).toEqual([]);
    });

    test("parses a single session file", async () => {
        writeSessionFile(sessionDir, "session1.jsonl", {
            id: "test-id-1",
            name: "Test Session",
            messages: [
                { role: "user", content: "Hello world" },
                { role: "assistant", content: "Hi there" },
            ],
        });

        const results = await listSessionsCached(sessionDir);
        expect(results.length).toBe(1);
        expect(results[0].id).toBe("test-id-1");
        expect(results[0].name).toBe("Test Session");
        expect(results[0].firstMessage).toBe("Hello world");
        expect(results[0].messageCount).toBe(2);
    });

    test("cache hit on second call (no file changes)", async () => {
        writeSessionFile(sessionDir, "session1.jsonl", {
            id: "test-id-1",
            messages: [{ role: "user", content: "First call" }],
        });

        // First call — cold cache, parses the file
        const results1 = await listSessionsCached(sessionDir);
        expect(results1.length).toBe(1);

        // Second call — should be a cache hit (same mtime)
        const results2 = await listSessionsCached(sessionDir);
        expect(results2.length).toBe(1);
        expect(results2[0].id).toBe(results1[0].id);
        expect(results2[0].firstMessage).toBe(results1[0].firstMessage);
    });

    test("cache miss when file is modified", async () => {
        const filePath = writeSessionFile(sessionDir, "session1.jsonl", {
            id: "test-id-1",
            messages: [{ role: "user", content: "Original message" }],
        });

        const results1 = await listSessionsCached(sessionDir);
        expect(results1[0].firstMessage).toBe("Original message");

        // Wait a tick to ensure mtime changes, then modify
        await new Promise(r => setTimeout(r, 50));
        const lines = readFileSync(filePath, "utf-8").trim().split("\n");
        lines.push(JSON.stringify({
            type: "message",
            id: "msg-new",
            parentId: null,
            timestamp: new Date().toISOString(),
            message: { role: "user", content: "Updated message", timestamp: Date.now() },
        }));
        writeFileSync(filePath, lines.join("\n") + "\n");

        const results2 = await listSessionsCached(sessionDir);
        expect(results2.length).toBe(1);
        expect(results2[0].messageCount).toBe(2);
    });

    test("prunes deleted files from cache", async () => {
        const f1 = writeSessionFile(sessionDir, "session1.jsonl", {
            id: "keep-me",
            messages: [{ role: "user", content: "Keep" }],
        });
        const f2 = writeSessionFile(sessionDir, "session2.jsonl", {
            id: "delete-me",
            messages: [{ role: "user", content: "Delete" }],
        });

        const results1 = await listSessionsCached(sessionDir);
        expect(results1.length).toBe(2);

        // Delete one file
        unlinkSync(f2);

        const results2 = await listSessionsCached(sessionDir);
        expect(results2.length).toBe(1);
        expect(results2[0].id).toBe("keep-me");
    });

    test("handles multiple session files sorted by modified desc", async () => {
        writeSessionFile(sessionDir, "old.jsonl", {
            id: "old-session",
            messages: [{ role: "user", content: "Old message" }],
        });

        // Small delay so timestamps differ
        await new Promise(r => setTimeout(r, 50));

        writeSessionFile(sessionDir, "new.jsonl", {
            id: "new-session",
            messages: [{ role: "user", content: "New message" }],
        });

        const results = await listSessionsCached(sessionDir);
        expect(results.length).toBe(2);
        // Most recently modified should be first
        expect(results[0].id).toBe("new-session");
        expect(results[1].id).toBe("old-session");
    });

    test("skips non-jsonl files", async () => {
        writeSessionFile(sessionDir, "session1.jsonl", {
            id: "real-session",
            messages: [{ role: "user", content: "Hello" }],
        });
        writeFileSync(join(sessionDir, "notes.txt"), "not a session");
        writeFileSync(join(sessionDir, "data.json"), "{}");

        const results = await listSessionsCached(sessionDir);
        expect(results.length).toBe(1);
        expect(results[0].id).toBe("real-session");
    });

    test("skips malformed session files", async () => {
        writeSessionFile(sessionDir, "good.jsonl", {
            id: "good",
            messages: [{ role: "user", content: "Hello" }],
        });
        // File with no valid header
        writeFileSync(join(sessionDir, "bad.jsonl"), '{"type":"not-a-session"}\n');
        // Empty file
        writeFileSync(join(sessionDir, "empty.jsonl"), "");

        const results = await listSessionsCached(sessionDir);
        expect(results.length).toBe(1);
        expect(results[0].id).toBe("good");
    });

    test("persists cache to disk and reloads", async () => {
        writeSessionFile(sessionDir, "session1.jsonl", {
            id: "persist-test",
            name: "Persistent",
            messages: [{ role: "user", content: "Will this persist?" }],
        });

        // First call — populates cache, then flush to disk synchronously
        const results = await listSessionsCached(sessionDir);
        expect(results.length).toBe(1);
        flushSessionListCache();

        const cachePath = join(fakeHome, ".pizzapi", "session-list-cache.json");
        expect(existsSync(cachePath)).toBe(true);

        const cacheData = JSON.parse(readFileSync(cachePath, "utf-8"));
        expect(cacheData.version).toBe(1);
        expect(Object.keys(cacheData.entries).length).toBeGreaterThanOrEqual(1);

        // Verify the cached entry has the right fields
        const entry = Object.values(cacheData.entries)[0] as any;
        expect(entry.id).toBe("persist-test");
        expect(entry.name).toBe("Persistent");
        expect(entry.firstMessage).toBe("Will this persist?");
    });

    test("invalidateSessionListCache clears in-memory cache", async () => {
        writeSessionFile(sessionDir, "session1.jsonl", {
            id: "invalidate-test",
            messages: [{ role: "user", content: "Hello" }],
        });

        await listSessionsCached(sessionDir);
        invalidateSessionListCache();

        // After invalidation, next call should re-parse (still returns correct results)
        const results = await listSessionsCached(sessionDir);
        expect(results.length).toBe(1);
        expect(results[0].id).toBe("invalidate-test");
    });

    test("session with no messages returns (no messages)", async () => {
        writeSessionFile(sessionDir, "empty-session.jsonl", {
            id: "no-msgs",
            messages: [],
        });

        const results = await listSessionsCached(sessionDir);
        expect(results.length).toBe(1);
        expect(results[0].firstMessage).toBe("(no messages)");
        expect(results[0].messageCount).toBe(0);
    });

    test("truncates cached allMessagesText for very large sessions", async () => {
        const huge = "x".repeat(5000);
        writeSessionFile(sessionDir, "huge-session.jsonl", {
            id: "huge-session",
            messages: Array.from({ length: 30 }, (_, idx) => ({
                role: idx % 2 === 0 ? "user" : "assistant",
                content: huge,
            })),
        });

        const results = await listSessionsCached(sessionDir);
        expect(results).toHaveLength(1);
        expect(results[0].messageCount).toBe(30);
        expect(results[0].allMessagesText.length).toBeLessThanOrEqual(8192);
        expect(results[0].allMessagesText).toContain("x");
    });

    test("persists truncated allMessagesText to disk", async () => {
        const huge = "y".repeat(5000);
        writeSessionFile(sessionDir, "persist-huge.jsonl", {
            id: "persist-huge",
            messages: Array.from({ length: 30 }, (_, idx) => ({
                role: idx % 2 === 0 ? "user" : "assistant",
                content: huge,
            })),
        });

        await listSessionsCached(sessionDir);
        flushSessionListCache();

        const cachePath = join(fakeHome, ".pizzapi", "session-list-cache.json");
        const cacheData = JSON.parse(readFileSync(cachePath, "utf-8"));
        const entry = Object.values(cacheData.entries).find((candidate: any) => candidate.id === "persist-huge") as any;
        expect(entry).toBeDefined();
        expect(entry.allMessagesText.length).toBeLessThanOrEqual(8192);
    });
});

// Restore HOME after all tests complete
import { afterAll } from "bun:test";
afterAll(() => {
    process.env.HOME = originalHome;
});
