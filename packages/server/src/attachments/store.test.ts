import { describe, expect, test } from "bun:test";
import { sanitizeFilename, attachmentMaxFileSizeBytes } from "./store";

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

describe("attachmentMaxFileSizeBytes", () => {
    test("returns default when env var is not set", () => {
        const original = process.env.PIZZAPI_ATTACHMENT_MAX_FILE_SIZE_BYTES;
        delete process.env.PIZZAPI_ATTACHMENT_MAX_FILE_SIZE_BYTES;
        expect(attachmentMaxFileSizeBytes()).toBe(20 * 1024 * 1024); // 20MB
        if (original !== undefined) {
            process.env.PIZZAPI_ATTACHMENT_MAX_FILE_SIZE_BYTES = original;
        }
    });

    test("returns default for invalid env var", () => {
        const original = process.env.PIZZAPI_ATTACHMENT_MAX_FILE_SIZE_BYTES;
        process.env.PIZZAPI_ATTACHMENT_MAX_FILE_SIZE_BYTES = "not-a-number";
        expect(attachmentMaxFileSizeBytes()).toBe(20 * 1024 * 1024);
        if (original !== undefined) {
            process.env.PIZZAPI_ATTACHMENT_MAX_FILE_SIZE_BYTES = original;
        } else {
            delete process.env.PIZZAPI_ATTACHMENT_MAX_FILE_SIZE_BYTES;
        }
    });

    test("returns the configured size for a valid env var", () => {
        const original = process.env.PIZZAPI_ATTACHMENT_MAX_FILE_SIZE_BYTES;
        process.env.PIZZAPI_ATTACHMENT_MAX_FILE_SIZE_BYTES = "10485760"; // 10MB
        expect(attachmentMaxFileSizeBytes()).toBe(10 * 1024 * 1024);
        if (original !== undefined) {
            process.env.PIZZAPI_ATTACHMENT_MAX_FILE_SIZE_BYTES = original;
        } else {
            delete process.env.PIZZAPI_ATTACHMENT_MAX_FILE_SIZE_BYTES;
        }
    });

    test("returns default for a zero size", () => {
        const original = process.env.PIZZAPI_ATTACHMENT_MAX_FILE_SIZE_BYTES;
        process.env.PIZZAPI_ATTACHMENT_MAX_FILE_SIZE_BYTES = "0";
        expect(attachmentMaxFileSizeBytes()).toBe(20 * 1024 * 1024);
        if (original !== undefined) {
            process.env.PIZZAPI_ATTACHMENT_MAX_FILE_SIZE_BYTES = original;
        } else {
            delete process.env.PIZZAPI_ATTACHMENT_MAX_FILE_SIZE_BYTES;
        }
    });

    test("returns default for a negative size", () => {
        const original = process.env.PIZZAPI_ATTACHMENT_MAX_FILE_SIZE_BYTES;
        process.env.PIZZAPI_ATTACHMENT_MAX_FILE_SIZE_BYTES = "-500000";
        expect(attachmentMaxFileSizeBytes()).toBe(20 * 1024 * 1024);
        if (original !== undefined) {
            process.env.PIZZAPI_ATTACHMENT_MAX_FILE_SIZE_BYTES = original;
        } else {
            delete process.env.PIZZAPI_ATTACHMENT_MAX_FILE_SIZE_BYTES;
        }
    });

    test("returns default for an empty string", () => {
        const original = process.env.PIZZAPI_ATTACHMENT_MAX_FILE_SIZE_BYTES;
        process.env.PIZZAPI_ATTACHMENT_MAX_FILE_SIZE_BYTES = "";
        expect(attachmentMaxFileSizeBytes()).toBe(20 * 1024 * 1024);
        if (original !== undefined) {
            process.env.PIZZAPI_ATTACHMENT_MAX_FILE_SIZE_BYTES = original;
        } else {
            delete process.env.PIZZAPI_ATTACHMENT_MAX_FILE_SIZE_BYTES;
        }
    });
});
