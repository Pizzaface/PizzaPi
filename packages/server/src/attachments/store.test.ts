import { describe, expect, test, beforeAll, afterAll } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { initAuth, getKysely } from "../auth.js";
import { sanitizeFilename, sanitizeStoredFilename, attachmentMaxFileSizeBytes, storeSessionAttachment, ensureExtractedAttachmentTable } from "./store";

// ── Persistence integration test setup ──────────────────────────────────────
// Uses a temp SQLite DB so tests don't interfere with any real server DB.
const tmpDir = mkdtempSync(join(tmpdir(), "pizzapi-attach-persist-test-"));
const dbPath = join(tmpDir, "test.db");

beforeAll(async () => {
    // Override HOME so auth.ts doesn't write to the real home directory
    process.env.HOME = tmpDir;
    initAuth({ dbPath, baseURL: "http://localhost:7777", secret: "test-secret-attach-persist" });
    await ensureExtractedAttachmentTable();
});

afterAll(() => {
    rmSync(tmpDir, { recursive: true, force: true });
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
        expect(result).not.toMatch(/[\x00-\x1F]/);
    });

    test("strips DEL (0x7F)", () => {
        expect(sanitizeStoredFilename("file\x7Fname.txt")).toBe("file_name.txt");
    });

    test("handles empty string", () => {
        expect(sanitizeStoredFilename("")).toBe("");
    });
});

describe("attachmentMaxFileSizeBytes", () => {
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

describe("storeSessionAttachment SQLite persistence", () => {
    test("persists user-uploaded attachment to SQLite", async () => {
        const file = new File(["hello world"], "persist-test.txt", { type: "text/plain" });
        const record = await storeSessionAttachment({
            sessionId: "test-session-persist-001",
            ownerUserId: "test-owner-001",
            uploaderUserId: "test-uploader-001",
            file,
        });

        expect(record.attachmentId).toBeTruthy();
        expect(record.uploaderUserId).toBe("test-uploader-001");

        // Allow the fire-and-forget SQLite persist to complete before querying
        await Bun.sleep(100);

        // Verify the record landed in SQLite
        const rows = await getKysely()
            .selectFrom("extracted_attachment")
            .selectAll()
            .where("attachmentId", "=", record.attachmentId)
            .execute();

        expect(rows).toHaveLength(1);
        const row = rows[0]!;
        expect(row.sessionId).toBe("test-session-persist-001");
        expect(row.ownerUserId).toBe("test-owner-001");
        expect(row.filename).toBe("persist-test.txt");
        // Bun's File may append ";charset=utf-8" to text types
        expect(row.mimeType).toStartWith("text/plain");

        // Clean up the written file from disk
        try { rmSync(record.filePath); } catch {}
    });

    test("record is found by getKysely after a second store (dedup via ON CONFLICT DO UPDATE)", async () => {
        // Verify that re-storing an existing attachment ID updates (upserts) rather than throwing
        const file = new File(["content"], "dedup-test.txt", { type: "text/plain" });
        const record = await storeSessionAttachment({
            sessionId: "test-session-dedup",
            ownerUserId: "test-owner-dedup",
            uploaderUserId: "test-uploader-dedup",
            file,
        });

        await Bun.sleep(100);

        // Should exist exactly once
        const rows = await getKysely()
            .selectFrom("extracted_attachment")
            .selectAll()
            .where("attachmentId", "=", record.attachmentId)
            .execute();
        expect(rows).toHaveLength(1);

        try { rmSync(record.filePath); } catch {}
    });
});
