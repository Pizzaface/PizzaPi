import { describe, expect, test } from "bun:test";
import { sanitizeFilename, sanitizeStoredFilename, attachmentMaxFileSizeBytes } from "./store";

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
