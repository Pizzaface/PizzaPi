import { afterAll, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { sql } from "kysely";

const tempDir = mkdtempSync(join(tmpdir(), "pizzapi-attachments-"));
process.env.AUTH_DB_PATH = join(tempDir, "auth.db");
process.env.PIZZAPI_ATTACHMENT_DIR = join(tempDir, "uploads");

const store = await import("./store.js");
const { normalizeExtractedImageMimeType, sanitizeFilename, sanitizeStoredFilename, attachmentMaxFileSizeBytes } = store;
const { createTestAuthContext, runWithAuthContext } = await import("../auth.js");
const authContext = createTestAuthContext({ dbPath: process.env.AUTH_DB_PATH });
await runWithAuthContext(authContext, () => store.ensureExtractedAttachmentTable());

// A separate module instance provides the fresh in-memory Map used after restart.
const restartedStore = await (async (specifier: string) => import(specifier))("./store.js?restart");

afterAll(async () => {
    await authContext.db.destroy();
    rmSync(tempDir, { recursive: true, force: true });
});

describe("normalizeExtractedImageMimeType", () => {
    test("passes through plain image types", () => {
        expect(normalizeExtractedImageMimeType("image/png")).toBe("image/png");
        expect(normalizeExtractedImageMimeType("image/svg+xml")).toBe("image/svg+xml");
        expect(normalizeExtractedImageMimeType("image/jpeg; charset=binary")).toBe("image/jpeg; charset=binary");
    });

    test("rejects non-image and malformed types", () => {
        expect(normalizeExtractedImageMimeType("text/html")).toBe("application/octet-stream");
        expect(normalizeExtractedImageMimeType("text/html; charset=utf-8")).toBe("application/octet-stream");
        expect(normalizeExtractedImageMimeType("application/javascript")).toBe("application/octet-stream");
        expect(normalizeExtractedImageMimeType("image/")).toBe("application/octet-stream");
        expect(normalizeExtractedImageMimeType("")).toBe("application/octet-stream");
    });
});

describe("sanitizeFilename", () => {
    test("preserves safe characters", () => {
        expect(sanitizeFilename("file.txt")).toBe("file.txt");
        expect(sanitizeFilename("my-file_v2.tar.gz")).toBe("my-file_v2.tar.gz");
        expect(sanitizeFilename("CamelCase123.ts")).toBe("CamelCase123.ts");
    });

    test("replaces spaces with underscores", () => {
        expect(sanitizeFilename("my file.txt")).toBe("my_file.txt");
        expect(sanitizeFilename("my  file.txt")).toBe("my__file.txt");
    });

    test("replaces special characters", () => {
        expect(sanitizeFilename("file@2024!.txt")).toBe("file_2024_.txt");
        expect(sanitizeFilename("résumé.pdf")).toBe("r_sum_.pdf");
    });

    test("replaces path separators (prevents traversal)", () => {
        // dots are allowed, only slashes and backslashes get replaced
        expect(sanitizeFilename("../../etc/passwd")).toBe(".._.._etc_passwd");
        expect(sanitizeFilename("foo/bar\\baz")).toBe("foo_bar_baz");
    });

    test("handles empty string", () => {
        expect(sanitizeFilename("")).toBe("");
    });

    test("handles all-special characters", () => {
        const result = sanitizeFilename("@#$%^&");
        expect(result).toBe("______");
    });
});

describe("sanitizeStoredFilename", () => {
    test("preserves safe ASCII filenames unchanged", () => {
        expect(sanitizeStoredFilename("photo.png")).toBe("photo.png");
        expect(sanitizeStoredFilename("my-file_v2.tar.gz")).toBe("my-file_v2.tar.gz");
    });

    test("preserves Unicode filenames (non-control non-ASCII characters kept)", () => {
        expect(sanitizeStoredFilename("résumé.pdf")).toBe("résumé.pdf");
        expect(sanitizeStoredFilename("截图_2026.png")).toBe("截图_2026.png");
        expect(sanitizeStoredFilename("Screenshot\u202FPM.png")).toBe("Screenshot\u202FPM.png");
    });

    test("strips newline (\\n)", () => {
        expect(sanitizeStoredFilename("evil\nfile.txt")).toBe("evil_file.txt");
    });

    test("strips carriage return (\\r)", () => {
        expect(sanitizeStoredFilename("evil\rfile.txt")).toBe("evil_file.txt");
    });

    test("strips null byte (\\x00)", () => {
        expect(sanitizeStoredFilename("file\x00name.txt")).toBe("file_name.txt");
    });

    test("strips all C0 control chars", () => {
        // Generate a string with chars 0x00 through 0x1F
        const controlChars = Array.from({ length: 32 }, (_, i) => String.fromCharCode(i)).join("");
        const result = sanitizeStoredFilename("a" + controlChars + "b");
        // oxlint-disable-next-line no-control-regex -- intentional: asserts extracted content contains no control characters
        expect(result).not.toMatch(/[\x00-\x1F]/);
    });

    test("strips DEL (0x7F)", () => {
        expect(sanitizeStoredFilename("file\x7Fname.txt")).toBe("file_name.txt");
    });

    test("handles empty string", () => {
        expect(sanitizeStoredFilename("")).toBe("");
    });
});

// Skipped: Bun runs all test files in a single process, so env-var mutations
// from other test files (e.g. handler.test.ts setting MAX_ATTACHMENT_BODY_SIZE)
// pollute the module-level constant. Unskip once Bun supports per-file isolation.
describe.skip("attachmentMaxFileSizeBytes", () => {
    test("returns default when env var is not set", () => {
        const original = process.env.PIZZAPI_ATTACHMENT_MAX_FILE_SIZE_BYTES;
        delete process.env.PIZZAPI_ATTACHMENT_MAX_FILE_SIZE_BYTES;
        expect(attachmentMaxFileSizeBytes()).toBe(30 * 1024 * 1024); // 30MB
        if (original !== undefined) {
            process.env.PIZZAPI_ATTACHMENT_MAX_FILE_SIZE_BYTES = original;
        }
    });

    test("returns default for invalid env var", () => {
        const original = process.env.PIZZAPI_ATTACHMENT_MAX_FILE_SIZE_BYTES;
        process.env.PIZZAPI_ATTACHMENT_MAX_FILE_SIZE_BYTES = "not-a-number";
        expect(attachmentMaxFileSizeBytes()).toBe(30 * 1024 * 1024);
        if (original !== undefined) {
            process.env.PIZZAPI_ATTACHMENT_MAX_FILE_SIZE_BYTES = original;
        } else {
            delete process.env.PIZZAPI_ATTACHMENT_MAX_FILE_SIZE_BYTES;
        }
    });
});

describe("attachment metadata persistence", () => {
    test("rehydrates uploaded metadata into a fresh store after a simulated restart", async () => {
        const uploaded = await runWithAuthContext(authContext, () => store.storeSessionAttachment({
            sessionId: "session-restart-test",
            ownerUserId: "user-restart-test",
            uploaderUserId: "user-restart-test",
            file: new File(["attachment contents"], "report.txt", { type: "text/plain" }),
        }));

        const loaded = await runWithAuthContext(authContext, async () => {
            expect(await restartedStore.rehydrateAttachments()).toBe(1);
            return restartedStore.getStoredAttachment(uploaded.attachmentId);
        });

        expect(loaded).toMatchObject({
            attachmentId: uploaded.attachmentId,
            sessionId: "session-restart-test",
            ownerUserId: "user-restart-test",
            uploaderUserId: "user-restart-test",
            filename: "report.txt",
            mimeType: uploaded.mimeType,
            size: uploaded.size,
            filePath: uploaded.filePath,
        });
    });
});

describe("extracted image limits (F11)", () => {
    function b64(decodedBytes: number, seed: string): string {
        return seed + "A".repeat(Math.ceil((decodedBytes * 4) / 3) - 1);
    }

    function withEnv<T>(vars: Record<string, string>, fn: () => Promise<T>): Promise<T> {
        const saved = Object.fromEntries(Object.keys(vars).map((k) => [k, process.env[k]]));
        Object.assign(process.env, vars);
        return fn().finally(() => {
            for (const [k, v] of Object.entries(saved)) {
                if (v === undefined) delete process.env[k];
                else process.env[k] = v;
            }
        });
    }

    test("rejects an over-limit image before decoding or writing", async () => {
        await withEnv({ PIZZAPI_ATTACHMENT_MAX_FILE_SIZE_BYTES: "50000" }, async () => {
            const err = await runWithAuthContext(authContext, () => store.storeExtractedImage({
                attachmentId: "f11-too-large",
                sessionId: "s-f11",
                ownerUserId: "user-f11-size",
                mimeType: "image/png",
                base64Data: b64(60_000, "B"),
            })).catch((e: unknown) => e);
            expect(err).toBeInstanceOf(store.ExtractedImageRejectedError);
            expect((err as InstanceType<typeof store.ExtractedImageRejectedError>).reason).toBe("too_large");
            expect(store._testGetAttachments().has("f11-too-large")).toBe(false);
            expect(store.extractedImageBytesForUser("user-f11-size")).toBe(0);
        });
    });

    test("rejects non-base64 payloads", async () => {
        const err = await runWithAuthContext(authContext, () => store.storeExtractedImage({
            attachmentId: "f11-invalid",
            sessionId: "s-f11",
            ownerUserId: "user-f11-invalid",
            mimeType: "image/png",
            base64Data: "<html>" + "A".repeat(20_000),
        })).catch((e: unknown) => e);
        expect((err as InstanceType<typeof store.ExtractedImageRejectedError>).reason).toBe("invalid");
    });

    test("enforces the per-user quota, including durable-retained images, and frees it on delete", async () => {
        await withEnv({ PIZZAPI_EXTRACTED_IMAGE_USER_QUOTA_BYTES: "100000" }, async () => {
            const user = "user-f11-quota";
            const first = await runWithAuthContext(authContext, () => store.storeExtractedImage({
                attachmentId: "f11-quota-1",
                sessionId: "s-f11",
                ownerUserId: user,
                mimeType: "image/png",
                base64Data: b64(60_000, "B"),
            }));
            expect(store.extractedImageBytesForUser(user)).toBe(first.size);

            // Re-storing identical content dedupes and does not consume quota.
            await runWithAuthContext(authContext, () => store.storeExtractedImage({
                attachmentId: "f11-quota-1",
                sessionId: "s-f11-other",
                ownerUserId: user,
                mimeType: "image/png",
                base64Data: b64(60_000, "B"),
            }));
            expect(store.extractedImageBytesForUser(user)).toBe(first.size);

            const err = await runWithAuthContext(authContext, () => store.storeExtractedImage({
                attachmentId: "f11-quota-2",
                sessionId: "s-f11",
                ownerUserId: user,
                mimeType: "image/png",
                base64Data: b64(60_000, "C"),
            })).catch((e: unknown) => e);
            expect((err as InstanceType<typeof store.ExtractedImageRejectedError>).reason).toBe("quota_exceeded");
            expect(store._testGetAttachments().has("f11-quota-2")).toBe(false);

            // Another user is unaffected.
            await runWithAuthContext(authContext, () => store.storeExtractedImage({
                attachmentId: "f11-quota-other-user",
                sessionId: "s-f11",
                ownerUserId: "user-f11-quota-b",
                mimeType: "image/png",
                base64Data: b64(60_000, "C"),
            }));

            await runWithAuthContext(authContext, () => store.deleteStoredAttachment("f11-quota-1"));
            expect(store.extractedImageBytesForUser(user)).toBe(0);
            await runWithAuthContext(authContext, () => store.storeExtractedImage({
                attachmentId: "f11-quota-2",
                sessionId: "s-f11",
                ownerUserId: user,
                mimeType: "image/png",
                base64Data: b64(60_000, "C"),
            }));
            expect(store._testGetAttachments().has("f11-quota-2")).toBe(true);
        });
    });

    test("concurrent stores cannot overshoot the quota", async () => {
        await withEnv({ PIZZAPI_EXTRACTED_IMAGE_USER_QUOTA_BYTES: "100000" }, async () => {
            const user = "user-f11-race";
            const results = await runWithAuthContext(authContext, () => Promise.allSettled(
                ["D", "E", "F", "G"].map((seed) => store.storeExtractedImage({
                    attachmentId: `f11-race-${seed}`,
                    sessionId: "s-f11",
                    ownerUserId: user,
                    mimeType: "image/png",
                    base64Data: b64(40_000, seed),
                })),
            ));
            expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(2);
            expect(store.extractedImageBytesForUser(user)).toBeLessThanOrEqual(100_000);
        });
    });

    test("the quota is shared by relay instances using the same database (review R9)", async () => {
        // A second module instance stands in for another relay node: separate
        // in-memory state, same SQLite database.
        const nodeB = await (async (specifier: string) => import(specifier))("./store.js?node-b");
        await withEnv({ PIZZAPI_EXTRACTED_IMAGE_USER_QUOTA_BYTES: "100000" }, async () => {
            const user = "user-r9-cross-node";
            const onA = await runWithAuthContext(authContext, () => store.storeExtractedImage({
                attachmentId: "r9-node-a",
                sessionId: "s-r9",
                ownerUserId: user,
                mimeType: "image/png",
                base64Data: b64(60_000, "M"),
            }));
            const err = await runWithAuthContext(authContext, () => nodeB.storeExtractedImage({
                attachmentId: "r9-node-b",
                sessionId: "s-r9",
                ownerUserId: user,
                mimeType: "image/png",
                base64Data: b64(60_000, "N"),
            })).catch((e: unknown) => e);
            expect((err as { reason?: string }).reason).toBe("quota_exceeded");
            expect(nodeB._testGetAttachments().has("r9-node-b")).toBe(false);

            // Concurrent writes split across both nodes cannot overshoot either.
            await runWithAuthContext(authContext, () => store.deleteStoredAttachment(onA.attachmentId));
            const results = await runWithAuthContext(authContext, () => Promise.allSettled(
                ["O", "P", "Q", "R"].map((seed, i) => (i % 2 === 0 ? store : nodeB).storeExtractedImage({
                    attachmentId: `r9-race-${seed}`,
                    sessionId: "s-r9",
                    ownerUserId: user,
                    mimeType: "image/png",
                    base64Data: b64(40_000, seed),
                })),
            ));
            expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(2);

            // Deleting on one node frees quota for the other.
            const winners = ["O", "P", "Q", "R"].filter((_, i) => results[i]!.status === "fulfilled");
            for (const seed of winners) {
                const i = ["O", "P", "Q", "R"].indexOf(seed);
                await runWithAuthContext(authContext, () =>
                    (i % 2 === 0 ? store : nodeB).deleteStoredAttachment(`r9-race-${seed}`));
            }
            await runWithAuthContext(authContext, () => nodeB.storeExtractedImage({
                attachmentId: "r9-node-b",
                sessionId: "s-r9",
                ownerUserId: user,
                mimeType: "image/png",
                base64Data: b64(60_000, "N"),
            }));
            expect(nodeB._testGetAttachments().has("r9-node-b")).toBe(true);
        });
    });

    test("relay pipeline stripping replaces quota-rejected images with omitted markers", async () => {
        const { stripImagesFromPipelineEvent } = await import("../ws/strip-images.js");
        await withEnv({ PIZZAPI_EXTRACTED_IMAGE_USER_QUOTA_BYTES: "50000" }, async () => {
            const event = {
                type: "agent_end",
                messages: [{
                    role: "user",
                    content: [
                        { type: "image", source: { type: "base64", media_type: "image/png", data: b64(40_000, "H") } },
                        { type: "image", source: { type: "base64", media_type: "image/png", data: b64(40_000, "I") } },
                    ],
                }],
            };
            const out = await runWithAuthContext(authContext, () =>
                stripImagesFromPipelineEvent(event, "s-f11-pipe", "user-f11-pipe")) as any;
            const blocks = out.messages[0].content;
            const stored = blocks.filter((b: any) => b.source.extracted === true);
            const omitted = blocks.filter((b: any) => b.source.omitted === true);
            expect(stored).toHaveLength(1);
            expect(omitted).toHaveLength(1);
            expect(omitted[0].source.omittedReason).toBe("quota_exceeded");
            expect(omitted[0].source.data).toBeUndefined();
            expect(omitted[0].source.url).toBeUndefined();
            expect(out._imagesStripped).toBe(true);
            expect(store.extractedImageBytesForUser("user-f11-pipe")).toBeLessThanOrEqual(50_000);
        });
    });
});

describe("unexpected image-store failures preserve content (review R4)", () => {
    function b64(decodedBytes: number, seed: string): string {
        return seed + "A".repeat(Math.ceil((decodedBytes * 4) / 3) - 1);
    }

    test("an I/O failure keeps the inline image instead of erasing it, and a later stage can retry", async () => {
        const { createHash } = await import("node:crypto");
        const { mkdirSync } = await import("node:fs");
        const { stripImagesFromPipelineEvent, storeAndReplaceImagesInEvent } = await import("../ws/strip-images.js");
        const user = "user-r4";
        const failing = b64(40_000, "J");
        const healthy = b64(40_000, "K");
        // Block the failing image's target path with a directory so the write
        // fails with an unexpected I/O error (not a policy rejection).
        const failingId = createHash("sha256").update(user).update(":").update(failing).digest("hex").slice(0, 24);
        // Resolve the store's real upload root (module-level, fixed at first import).
        const probe = await runWithAuthContext(authContext, () => store.storeExtractedImage({
            attachmentId: "r4-probe", sessionId: "s-r4", ownerUserId: user, mimeType: "image/png", base64Data: b64(20_000, "L"),
        }));
        const blocker = join(dirname(probe.filePath), `extracted-${failingId}.png`);
        mkdirSync(blocker, { recursive: true });
        const event = {
            type: "agent_end",
            messages: [{
                role: "user",
                content: [
                    { type: "image", source: { type: "base64", media_type: "image/png", data: failing } },
                    { type: "image", source: { type: "base64", media_type: "image/png", data: healthy } },
                ],
            }],
        };
        try {
            const out = await runWithAuthContext(authContext, () =>
                stripImagesFromPipelineEvent(event, "s-r4", user)) as any;
            const [kept, stored] = out.messages[0].content;
            // The failed image is NOT replaced with an omitted marker.
            expect(kept.source.omitted).toBeUndefined();
            expect(kept.source.data).toBe(failing);
            expect(stored.source.extracted).toBe(true);
            expect(stored.source.data).toBeUndefined();
            // Downstream fallback stays enabled for the failed image.
            expect(out._imagesStripped).toBeUndefined();

            // The cache/broadcast stage retries; once storage recovers the
            // image is extracted instead of lost.
            rmSync(blocker, { recursive: true, force: true });
            const final = await runWithAuthContext(authContext, () =>
                storeAndReplaceImagesInEvent(out, "s-r4", user)) as any;
            const [retried, unchanged] = final.messages[0].content;
            expect(retried.source.extracted).toBe(true);
            expect(store._testGetAttachments().has(failingId)).toBe(true);
            expect(unchanged).toEqual(stored);
        } finally {
            rmSync(blocker, { recursive: true, force: true });
        }
    });
});

describe("extracted image quota under failures and races (review R2-8)", () => {
    function b64(decodedBytes: number, seed: string): string {
        return seed + "A".repeat(Math.ceil((decodedBytes * 4) / 3) - 1);
    }

    async function withQuota<T>(bytes: number, fn: () => Promise<T>): Promise<T> {
        const saved = process.env.PIZZAPI_EXTRACTED_IMAGE_USER_QUOTA_BYTES;
        process.env.PIZZAPI_EXTRACTED_IMAGE_USER_QUOTA_BYTES = String(bytes);
        try {
            return await fn();
        } finally {
            if (saved === undefined) delete process.env.PIZZAPI_EXTRACTED_IMAGE_USER_QUOTA_BYTES;
            else process.env.PIZZAPI_EXTRACTED_IMAGE_USER_QUOTA_BYTES = saved;
        }
    }

    test("a reservation table from before the attachmentId key is upgraded in place", async () => {
        await sql`DROP TABLE extracted_attachment_reservation`.execute(authContext.db);
        await sql`CREATE TABLE extracted_attachment_reservation (reservationId text primary key,
            ownerUserId text not null, bytes integer not null, expiresAt text not null)`.execute(authContext.db);
        await runWithAuthContext(authContext, () => store.ensureExtractedAttachmentTable());
        await runWithAuthContext(authContext, () => store.ensureExtractedAttachmentTable());
        const cols = await sql<{ name: string }>`SELECT name FROM pragma_table_info('extracted_attachment_reservation')`
            .execute(authContext.db);
        expect(cols.rows.map((c) => c.name)).toContain("attachmentId");
    });

    test("a partially failing delete rolls back, so the still-served image keeps counting against quota", async () => {
        await withQuota(100_000, async () => {
            const user = "user-r2-8-tx";
            const img = await runWithAuthContext(authContext, () => store.storeExtractedImage({
                attachmentId: "r2-8-tx", sessionId: "s-r2-8", ownerUserId: user, mimeType: "image/png", base64Data: b64(60_000, "S"),
            }));
            // The session-ref delete fails; the metadata delete must not stick.
            await sql`CREATE TRIGGER r2_8_fail_ref_delete BEFORE DELETE ON extracted_attachment_session
                WHEN OLD.attachmentId = 'r2-8-tx' BEGIN SELECT RAISE(ABORT, 'injected'); END`.execute(authContext.db);
            try {
                const err = await runWithAuthContext(authContext, () => store.deleteStoredAttachment(img.attachmentId))
                    .catch((e: unknown) => e);
                expect(err).toBeInstanceOf(Error);
            } finally {
                await sql`DROP TRIGGER r2_8_fail_ref_delete`.execute(authContext.db);
            }
            // Still served from memory AND still counted by the shared quota.
            expect(store._testGetAttachments().has("r2-8-tx")).toBe(true);
            expect(existsSync(img.filePath)).toBe(true);
            const row = await authContext.db.selectFrom("extracted_attachment").select("attachmentId")
                .where("attachmentId", "=", "r2-8-tx").executeTakeFirst();
            expect(row?.attachmentId).toBe("r2-8-tx");
            const over = await runWithAuthContext(authContext, () => store.storeExtractedImage({
                attachmentId: "r2-8-tx-2", sessionId: "s-r2-8", ownerUserId: user, mimeType: "image/png", base64Data: b64(60_000, "T"),
            })).catch((e: unknown) => e);
            expect((over as { reason?: string }).reason).toBe("quota_exceeded");
            // Retry after recovery completes the delete.
            await runWithAuthContext(authContext, () => store.deleteStoredAttachment(img.attachmentId));
            expect(store._testGetAttachments().has("r2-8-tx")).toBe(false);
        });
    });

    test("a writer whose metadata persist fails never removes another writer's file for the same ID", async () => {
        // A second module instance stands in for another relay node sharing
        // the database and upload directory.
        const nodeB = await (async (specifier: string) => import(specifier))("./store.js?r2-8-loser");
        const user = "user-r2-8-loser";
        const data = b64(20_000, "U");
        const winner = await runWithAuthContext(authContext, () => store.storeExtractedImage({
            attachmentId: "r2-8-shared", sessionId: "s-r2-8-win", ownerUserId: user, mimeType: "image/png", base64Data: data,
        }));
        expect(existsSync(winner.filePath)).toBe(true);
        // Node B has no in-memory record, so it writes the same content-addressed
        // ID again; its metadata upsert fails.
        await sql`CREATE TRIGGER r2_8_fail_upsert BEFORE UPDATE ON extracted_attachment
            WHEN NEW.sessionId = 's-r2-8-lose' BEGIN SELECT RAISE(ABORT, 'injected'); END`.execute(authContext.db);
        try {
            const err = await runWithAuthContext(authContext, () => nodeB.storeExtractedImage({
                attachmentId: "r2-8-shared", sessionId: "s-r2-8-lose", ownerUserId: user, mimeType: "image/png", base64Data: data,
            })).catch((e: unknown) => e);
            expect(err).toBeInstanceOf(Error);
        } finally {
            await sql`DROP TRIGGER r2_8_fail_upsert`.execute(authContext.db);
        }
        expect(existsSync(winner.filePath)).toBe(true);
        const served = await runWithAuthContext(authContext, () => store.getStoredAttachment("r2-8-shared"));
        expect(served).not.toBeNull();
        expect(existsSync(served!.filePath)).toBe(true);
    });

    test("concurrent same-process writers of one ID store it once", async () => {
        await withQuota(100_000, async () => {
            const user = "user-r2-8-same-node";
            const data = b64(60_000, "V");
            const results = await runWithAuthContext(authContext, () => Promise.allSettled(
                ["s1", "s2", "s3"].map((sessionId) => store.storeExtractedImage({
                    attachmentId: "r2-8-same-node", sessionId, ownerUserId: user, mimeType: "image/png", base64Data: data,
                })),
            ));
            expect(results.map((r) => r.status)).toEqual(["fulfilled", "fulfilled", "fulfilled"]);
            expect(store.extractedImageBytesForUser(user)).toBe(60_000);
        });
    });

    test("relay nodes storing identical content concurrently are not rejected as quota_exceeded", async () => {
        const nodeB = await (async (specifier: string) => import(specifier))("./store.js?r2-8-identical");
        await withQuota(100_000, async () => {
            const user = "user-r2-8-identical";
            const data = b64(60_000, "W");
            const results = await runWithAuthContext(authContext, () => Promise.allSettled(
                [store, nodeB, store, nodeB].map((node, i) => node.storeExtractedImage({
                    attachmentId: "r2-8-identical", sessionId: `s-ident-${i}`, ownerUserId: user, mimeType: "image/png", base64Data: data,
                })),
            ));
            expect(results.map((r) => (r.status === "rejected" ? String((r.reason as { reason?: string }).reason ?? r.reason) : "ok")))
                .toEqual(["ok", "ok", "ok", "ok"]);
            // One copy is committed; a different image still cannot exceed the quota.
            const over = await runWithAuthContext(authContext, () => store.storeExtractedImage({
                attachmentId: "r2-8-identical-2", sessionId: "s-ident", ownerUserId: user, mimeType: "image/png", base64Data: b64(60_000, "X"),
            })).catch((e: unknown) => e);
            expect((over as { reason?: string }).reason).toBe("quota_exceeded");
        });
    });
});
