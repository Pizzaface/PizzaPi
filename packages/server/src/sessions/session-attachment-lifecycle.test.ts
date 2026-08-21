import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

const tempDir = mkdtempSync(join(tmpdir(), "pizzapi-session-attachment-lifecycle-"));
process.env.AUTH_DB_PATH = join(tempDir, "auth.db");
process.env.PIZZAPI_ATTACHMENT_DIR = join(tempDir, "uploads");

const { createTestAuthContext, getKysely, runWithAuthContext } = await import("../auth.js");
const authContext = createTestAuthContext({ dbPath: process.env.AUTH_DB_PATH });
const withAuth = <T>(fn: () => T): T => runWithAuthContext(authContext, fn);

const { ensureRelaySessionTables, pruneExpiredRelaySessions } = await import("./store.js");
const attachments = await import("../attachments/store.js");
const { ensureExtractedAttachmentTable, storeSessionAttachment, getStoredAttachment, storeExtractedImage } = attachments;

const TEST_USER = "user-lifecycle";

function currentIso(offsetMs: number = 0): string {
    return new Date(Date.now() + offsetMs).toISOString();
}

async function insertExpiredSession(sessionId: string, userId: string = TEST_USER) {
    const now = currentIso(-60_000);
    await getKysely()
        .insertInto("relay_session")
        .values({
            id: sessionId,
            userId,
            userName: null,
            cwd: "/test",
            shareUrl: `http://test/${sessionId}`,
            startedAt: now,
            lastActiveAt: now,
            endedAt: null,
            isEphemeral: 1,
            expiresAt: currentIso(-30_000), // already expired
            isPinned: 0,
            runnerId: null,
            runnerName: null,
            sessionName: null,
        })
        .execute();
}

beforeAll(async () => {
    await withAuth(async () => {
        await ensureRelaySessionTables();
        await ensureExtractedAttachmentTable();
    });
});

beforeEach(async () => {
    await withAuth(async () => {
        await getKysely().deleteFrom("relay_session_state").execute();
        await getKysely().deleteFrom("relay_session").execute();
        await getKysely().deleteFrom("attachment" as any).execute();
        await getKysely().deleteFrom("extracted_attachment" as any).execute();
        await getKysely().deleteFrom("extracted_attachment_session" as any).execute();
    });
    // Wipe the in-memory attachment registry between tests.
    for (const id of Array.from((attachments as any).attachments?.keys?.() ?? [])) {
        (attachments as any).attachments.delete(id);
    }
});

afterAll(() => {
    rmSync(tempDir, { recursive: true, force: true });
});

describe("session pruning attachment lifecycle", () => {
    test("uploaded attachments are deleted when their owning ephemeral session is pruned", async () => {
        await withAuth(async () => {
            const sessionId = "s-expired-with-attachment";
            await insertExpiredSession(sessionId);

            const stored = await storeSessionAttachment({
                sessionId,
                ownerUserId: TEST_USER,
                uploaderUserId: TEST_USER,
                file: new File(["sensitive ephemeral content"], "secret.txt", { type: "text/plain" }),
            });

            // Precondition: session and attachment exist.
            const sessionBefore = await getKysely()
                .selectFrom("relay_session")
                .select("id")
                .where("id", "=", sessionId)
                .executeTakeFirst();
            expect(sessionBefore).not.toBeUndefined();

            const attachmentBefore = await getStoredAttachment(stored.attachmentId);
            expect(attachmentBefore).not.toBeNull();
            expect(existsSync(attachmentBefore!.filePath)).toBe(true);

            // Prune expired sessions.
            const pruned = await pruneExpiredRelaySessions();
            expect(pruned).toContain(sessionId);

            // Postcondition: session is gone.
            const sessionAfter = await getKysely()
                .selectFrom("relay_session")
                .select("id")
                .where("id", "=", sessionId)
                .executeTakeFirst();
            expect(sessionAfter).toBeUndefined();

            // PRIVACY: the sensitive attachment must not outlive its ephemeral session.
            const attachmentAfter = await getStoredAttachment(stored.attachmentId);
            expect(attachmentAfter).toBeNull();
            expect(existsSync(attachmentBefore!.filePath)).toBe(false);
        });
    });

    test("extracted inline images solely referenced by an expired session are deleted on prune", async () => {
        await withAuth(async () => {
            const sessionId = "s-expired-with-extracted-image";
            await insertExpiredSession(sessionId);

            const attachmentId = "extracted-img-expired-only";
            const stored = await storeExtractedImage({
                attachmentId,
                sessionId,
                ownerUserId: TEST_USER,
                mimeType: "image/png",
                base64Data: "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
            });

            const attachmentBefore = await getStoredAttachment(attachmentId);
            expect(attachmentBefore).not.toBeNull();
            expect(existsSync(attachmentBefore!.filePath)).toBe(true);

            const pruned = await pruneExpiredRelaySessions();
            expect(pruned).toContain(sessionId);

            // PRIVACY: an extracted inline image with no surviving durable
            // session reference must not outlive the expired session.
            const attachmentAfter = await getStoredAttachment(attachmentId);
            expect(attachmentAfter).toBeNull();
            expect(existsSync(attachmentBefore!.filePath)).toBe(false);
        });
    });

    test("extracted inline images referenced by a durable session survive pruning of another session", async () => {
        await withAuth(async () => {
            const expiredSessionId = "s-expired-shared-image";
            const durableSessionId = "s-durable-shared-image";
            await insertExpiredSession(expiredSessionId);

            const now = currentIso();
            // Durable (non-ephemeral, no expiry) session that also references the image.
            await getKysely()
                .insertInto("relay_session")
                .values({
                    id: durableSessionId,
                    userId: TEST_USER,
                    userName: null,
                    cwd: "/test",
                    shareUrl: `http://test/${durableSessionId}`,
                    startedAt: now,
                    lastActiveAt: now,
                    endedAt: null,
                    isEphemeral: 0,
                    expiresAt: null,
                    isPinned: 0,
                    runnerId: null,
                    runnerName: null,
                    sessionName: null,
                })
                .execute();

            const attachmentId = "extracted-img-shared-durable";
            // Store the image for the durable session first, then for the expired
            // session with the same content hash. The record's sessionId becomes the
            // latest (expired) one, but the durable session keeps a ref.
            const base64Data = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";
            await storeExtractedImage({
                attachmentId,
                sessionId: durableSessionId,
                ownerUserId: TEST_USER,
                mimeType: "image/png",
                base64Data,
            });
            await storeExtractedImage({
                attachmentId,
                sessionId: expiredSessionId,
                ownerUserId: TEST_USER,
                mimeType: "image/png",
                base64Data,
            });

            const attachmentBefore = await getStoredAttachment(attachmentId);
            expect(attachmentBefore).not.toBeNull();
            expect(existsSync(attachmentBefore!.filePath)).toBe(true);

            const pruned = await pruneExpiredRelaySessions();
            expect(pruned).toContain(expiredSessionId);
            expect(pruned).not.toContain(durableSessionId);

            // The image must survive because the durable session still references it.
            const attachmentAfter = await getStoredAttachment(attachmentId);
            expect(attachmentAfter).not.toBeNull();
            expect(existsSync(attachmentBefore!.filePath)).toBe(true);
            expect(attachmentAfter?.sessionId).toBe(durableSessionId);
        });
    });
});
