/**
 * Focused lifecycle test: pruneSessionAttachments
 *
 * Verifies that when ephemeral sessions are pruned:
 * - Single-session uploads are deleted.
 * - Extracted images shared with a durable session are preserved.
 * - Extracted images referenced only by pruned sessions are deleted.
 *
 * No Redis required — uses SQLite + in-memory store only.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

const tempDir = mkdtempSync(join(tmpdir(), "pizzapi-prune-test-"));
process.env.AUTH_DB_PATH = join(tempDir, "prune.db");
process.env.PIZZAPI_ATTACHMENT_DIR = join(tempDir, "uploads");

const store = await import("./store.js");
const {
    storeSessionAttachment,
    storeExtractedImage,
    getStoredAttachment,
    ensureExtractedAttachmentTable,
    pruneSessionAttachments,
} = store;
const { createTestAuthContext, runWithAuthContext, getKysely } = await import("../auth.js");
const { ensureRelaySessionTables } = await import("../sessions/store.js");

const authContext = createTestAuthContext({ dbPath: process.env.AUTH_DB_PATH });
const withAuth = <T>(fn: () => Promise<T>): Promise<T> =>
    runWithAuthContext(authContext, fn);

beforeAll(async () => {
    await withAuth(async () => {
        await ensureRelaySessionTables();
        await ensureExtractedAttachmentTable();
    });
});

afterAll(async () => {
    await authContext.db.destroy();
    rmSync(tempDir, { recursive: true, force: true });
});

async function insertRelaySession(opts: {
    id: string;
    isEphemeral: 0 | 1;
    expiresAt: string | null;
    isPinned?: 0 | 1;
}): Promise<void> {
    const now = new Date().toISOString();
    await getKysely()
        .insertInto("relay_session")
        .values({
            id: opts.id,
            userId: "test-user",
            userName: null,
            cwd: "/test",
            shareUrl: `http://test/${opts.id}`,
            startedAt: now,
            lastActiveAt: now,
            endedAt: null,
            isEphemeral: opts.isEphemeral,
            expiresAt: opts.expiresAt,
            isPinned: opts.isPinned ?? 0,
            runnerId: null,
            runnerName: null,
            sessionName: null,
        })
        .execute();
}

describe("pruneSessionAttachments", () => {
    test("deletes single-session upload for pruned session", async () => {
        await withAuth(async () => {
            const sessionId = "prune-upload-session";

            const attachment = await storeSessionAttachment({
                sessionId,
                ownerUserId: "user-1",
                uploaderUserId: "user-1",
                file: new File(["hello world"], "test.txt", { type: "text/plain" }),
            });

            expect(existsSync(attachment.filePath)).toBe(true);
            expect(await getStoredAttachment(attachment.attachmentId)).not.toBeNull();

            await pruneSessionAttachments([sessionId]);

            expect(await getStoredAttachment(attachment.attachmentId)).toBeNull();
            expect(existsSync(attachment.filePath)).toBe(false);
        });
    });

    test("deletes extracted image when only pruned session references it", async () => {
        await withAuth(async () => {
            const prunedSession = "prune-extracted-solo-session";

            const img = await storeExtractedImage({
                attachmentId: crypto.randomUUID(),
                sessionId: prunedSession,
                ownerUserId: "user-1",
                mimeType: "image/png",
                base64Data: "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==",
            });

            expect(existsSync(img.filePath)).toBe(true);
            expect(await getStoredAttachment(img.attachmentId)).not.toBeNull();

            await pruneSessionAttachments([prunedSession]);

            expect(await getStoredAttachment(img.attachmentId)).toBeNull();
            expect(existsSync(img.filePath)).toBe(false);
        });
    });

    test("preserves extracted image still referenced by a durable session", async () => {
        await withAuth(async () => {
            const prunedSession = "prune-shared-ephemeral-session";
            const durableSession = "prune-shared-durable-session";

            // Insert the durable session into relay_session so getDurableSessionIds finds it.
            await insertRelaySession({
                id: durableSession,
                isEphemeral: 0,
                expiresAt: null, // never expires → durable
            });

            const attachmentId = crypto.randomUUID();

            // First reference: pruned (ephemeral) session
            const img = await storeExtractedImage({
                attachmentId,
                sessionId: prunedSession,
                ownerUserId: "user-1",
                mimeType: "image/png",
                base64Data: "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==",
            });

            // Second reference: durable session (same content-hashed ID → dedup path)
            await storeExtractedImage({
                attachmentId,
                sessionId: durableSession,
                ownerUserId: "user-1",
                mimeType: "image/png",
                base64Data: "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==",
            });

            expect(existsSync(img.filePath)).toBe(true);

            // Prune only the ephemeral session.
            await pruneSessionAttachments([prunedSession]);

            // File must still exist — durable session still references it.
            expect(existsSync(img.filePath)).toBe(true);
            expect(await getStoredAttachment(img.attachmentId)).not.toBeNull();
        });
    });

    test("no-ops gracefully when called with empty array", async () => {
        await withAuth(async () => {
            // Should not throw.
            await expect(pruneSessionAttachments([])).resolves.toBeUndefined();
        });
    });
});
