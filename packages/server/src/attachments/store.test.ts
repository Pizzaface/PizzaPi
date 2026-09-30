import { afterAll, afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

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

// attachmentMaxFileSizeBytes() reads process.env at call time (no module-level
// constant), so each test sets exactly the env it needs and restores it after —
// safe even when bun runs every test file in one shared process.
describe("attachmentMaxFileSizeBytes", () => {
    const KEY = "PIZZAPI_ATTACHMENT_MAX_FILE_SIZE_BYTES";
    let original: string | undefined;
    beforeEach(() => {
        original = process.env[KEY];
    });
    afterEach(() => {
        if (original === undefined) delete process.env[KEY];
        else process.env[KEY] = original;
    });

    test("returns default when env var is not set", () => {
        delete process.env[KEY];
        expect(attachmentMaxFileSizeBytes()).toBe(30 * 1024 * 1024); // 30MB
    });

    test("returns default for invalid env var", () => {
        process.env[KEY] = "not-a-number";
        expect(attachmentMaxFileSizeBytes()).toBe(30 * 1024 * 1024);
    });

    test("returns default for non-positive values", () => {
        process.env[KEY] = "0";
        expect(attachmentMaxFileSizeBytes()).toBe(30 * 1024 * 1024);
        process.env[KEY] = "-5";
        expect(attachmentMaxFileSizeBytes()).toBe(30 * 1024 * 1024);
    });

    test("honours a valid override and re-reads env on every call", () => {
        process.env[KEY] = "1024";
        expect(attachmentMaxFileSizeBytes()).toBe(1024);
        process.env[KEY] = "2048";
        expect(attachmentMaxFileSizeBytes()).toBe(2048);
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
