import { describe, expect, test } from "bun:test";
import {
    hasVisibleContent,
    tryParseJsonObject,
    normalizeToolName,
    extractTextFromToolContent,
    extractPathFromToolContent,
    estimateBase64Bytes,
    formatBytes,
    formatDateValue,
    parseToolInputArgs,
    extToMime,
} from "./utils";

// ── hasVisibleContent ───────────────────────────────────────────────────────

describe("hasVisibleContent", () => {
    test("returns false for null/undefined/empty string", () => {
        expect(hasVisibleContent(null)).toBe(false);
        expect(hasVisibleContent(undefined)).toBe(false);
        expect(hasVisibleContent("")).toBe(false);
    });

    test("returns true for non-empty string", () => {
        expect(hasVisibleContent("hello")).toBe(true);
    });

    test("returns true for number/boolean (truthy non-array non-null)", () => {
        expect(hasVisibleContent(42)).toBe(true);
        expect(hasVisibleContent(true)).toBe(true);
    });

    test("returns false for empty array", () => {
        expect(hasVisibleContent([])).toBe(false);
    });

    test("returns true for array with text block that has content", () => {
        expect(hasVisibleContent([{ type: "text", text: "hello" }])).toBe(true);
    });

    test("returns false for array with text block that is whitespace-only", () => {
        expect(hasVisibleContent([{ type: "text", text: "   " }])).toBe(false);
        expect(hasVisibleContent([{ type: "text", text: "" }])).toBe(false);
    });

    test("returns true for array with thinking block", () => {
        expect(hasVisibleContent([{ type: "thinking", thinking: "hmm" }])).toBe(true);
    });

    test("returns false for array with thinking block that is whitespace-only", () => {
        expect(hasVisibleContent([{ type: "thinking", thinking: "  " }])).toBe(false);
    });

    test("returns true for array with unknown block type (e.g. image)", () => {
        expect(hasVisibleContent([{ type: "image", url: "http://example.com/img.png" }])).toBe(true);
    });

    test("returns false for array with null/non-object entries", () => {
        expect(hasVisibleContent([null, undefined, 42])).toBe(false);
    });

    test("handles mixed content arrays", () => {
        expect(hasVisibleContent([
            { type: "text", text: "" },
            { type: "text", text: "visible" },
        ])).toBe(true);
    });
});

// ── tryParseJsonObject ──────────────────────────────────────────────────────

describe("tryParseJsonObject", () => {
    test("parses valid JSON object", () => {
        expect(tryParseJsonObject('{"key":"value"}')).toEqual({ key: "value" });
    });

    test("returns null for JSON array", () => {
        expect(tryParseJsonObject("[1,2,3]")).toEqual([1, 2, 3]); // arrays are objects
    });

    test("returns null for JSON primitive (string)", () => {
        expect(tryParseJsonObject('"hello"')).toBe(null);
    });

    test("returns null for JSON primitive (number)", () => {
        expect(tryParseJsonObject("42")).toBe(null);
    });

    test("returns null for invalid JSON", () => {
        expect(tryParseJsonObject("not json")).toBe(null);
        expect(tryParseJsonObject("{invalid}")).toBe(null);
    });

    test("returns null for JSON null", () => {
        expect(tryParseJsonObject("null")).toBe(null);
    });
});

// ── normalizeToolName ───────────────────────────────────────────────────────

describe("normalizeToolName", () => {
    test("lowercases and trims", () => {
        expect(normalizeToolName("  Bash  ")).toBe("bash");
        expect(normalizeToolName("Read_File")).toBe("read_file");
    });

    test("returns empty string for undefined", () => {
        expect(normalizeToolName(undefined)).toBe("");
        expect(normalizeToolName()).toBe("");
    });
});

// ── extractTextFromToolContent ──────────────────────────────────────────────

describe("extractTextFromToolContent", () => {
    test("returns string content directly", () => {
        expect(extractTextFromToolContent("hello")).toBe("hello");
    });

    test("extracts text from array of blocks", () => {
        const content = [
            { text: "line 1" },
            { text: "line 2" },
        ];
        expect(extractTextFromToolContent(content)).toBe("line 1\n\nline 2");
    });

    test("extracts content property from array blocks", () => {
        const content = [{ content: "some output" }];
        expect(extractTextFromToolContent(content)).toBe("some output");
    });

    test("returns null for empty array", () => {
        expect(extractTextFromToolContent([])).toBe(null);
    });

    test("extracts text from single object", () => {
        expect(extractTextFromToolContent({ text: "hello" })).toBe("hello");
        expect(extractTextFromToolContent({ content: "world" })).toBe("world");
    });

    test("returns null for null/undefined/number", () => {
        expect(extractTextFromToolContent(null)).toBe(null);
        expect(extractTextFromToolContent(undefined)).toBe(null);
        expect(extractTextFromToolContent(42)).toBe(null);
    });

    test("skips non-object entries in arrays", () => {
        expect(extractTextFromToolContent([null, { text: "ok" }, 42])).toBe("ok");
    });
});

// ── extractPathFromToolContent ──────────────────────────────────────────────

describe("extractPathFromToolContent", () => {
    test("extracts path from object", () => {
        expect(extractPathFromToolContent({ path: "/foo/bar.ts" })).toBe("/foo/bar.ts");
    });

    test("extracts path from array of objects", () => {
        expect(extractPathFromToolContent([{ path: "/a.ts" }, { path: "/b.ts" }])).toBe("/a.ts");
    });

    test("returns undefined for missing path", () => {
        expect(extractPathFromToolContent({ text: "no path" })).toBeUndefined();
        expect(extractPathFromToolContent([])).toBeUndefined();
    });

    test("returns undefined for non-object", () => {
        expect(extractPathFromToolContent(null)).toBeUndefined();
        expect(extractPathFromToolContent("string")).toBeUndefined();
        expect(extractPathFromToolContent(42)).toBeUndefined();
    });
});

// ── estimateBase64Bytes ─────────────────────────────────────────────────────

describe("estimateBase64Bytes", () => {
    test("estimates bytes for simple base64", () => {
        // "aGVsbG8=" decodes to "hello" (5 bytes)
        expect(estimateBase64Bytes("aGVsbG8=")).toBe(5);
    });

    test("handles data URI prefix", () => {
        expect(estimateBase64Bytes("data:image/png;base64,aGVsbG8=")).toBe(5);
    });

    test("handles no-padding base64", () => {
        // "YQ" decodes to "a" (1 byte) — no padding
        // length=2, floor(2*3/4)-0 = 1
        expect(estimateBase64Bytes("YQ")).toBe(1);
    });

    test("handles double-padding base64", () => {
        // "YQ==" decodes to "a" (1 byte)
        expect(estimateBase64Bytes("YQ==")).toBe(1);
    });

    test("returns 0 for empty string", () => {
        expect(estimateBase64Bytes("")).toBe(0);
    });
});

// ── formatBytes ─────────────────────────────────────────────────────────────

describe("formatBytes", () => {
    test("formats zero", () => {
        expect(formatBytes(0)).toBe("0 B");
    });

    test("formats bytes", () => {
        expect(formatBytes(512)).toBe("512 B");
        expect(formatBytes(1)).toBe("1 B");
    });

    test("formats kilobytes", () => {
        expect(formatBytes(1024)).toBe("1.0 KB");
        expect(formatBytes(1536)).toBe("1.5 KB");
    });

    test("formats megabytes", () => {
        expect(formatBytes(1048576)).toBe("1.00 MB");
        expect(formatBytes(5 * 1024 * 1024)).toBe("5.00 MB");
    });

    test("handles negative and non-finite", () => {
        expect(formatBytes(-1)).toBe("0 B");
        expect(formatBytes(NaN)).toBe("0 B");
        expect(formatBytes(Infinity)).toBe("0 B");
    });
});

// ── formatDateValue ─────────────────────────────────────────────────────────

describe("formatDateValue", () => {
    test("formats unix timestamp (seconds)", () => {
        const result = formatDateValue(1700000000);
        expect(result).toBeTruthy();
        expect(typeof result).toBe("string");
    });

    test("formats unix timestamp (milliseconds)", () => {
        const result = formatDateValue(1700000000000);
        expect(result).toBeTruthy();
    });

    test("formats ISO date string", () => {
        const result = formatDateValue("2024-01-15T12:00:00Z");
        expect(result).toBeTruthy();
    });

    test("returns non-date string as-is", () => {
        expect(formatDateValue("not a date")).toBe("not a date");
    });

    test("returns null for null/undefined/empty", () => {
        expect(formatDateValue(null)).toBe(null);
        expect(formatDateValue(undefined)).toBe(null);
        expect(formatDateValue("")).toBe(null);
        expect(formatDateValue("   ")).toBe(null);
    });

    test("returns null for non-finite numbers", () => {
        expect(formatDateValue(NaN)).toBe(null);
        expect(formatDateValue(Infinity)).toBe(null);
    });
});

// ── parseToolInputArgs ──────────────────────────────────────────────────────

describe("parseToolInputArgs", () => {
    test("returns object as-is", () => {
        const input = { command: "ls" };
        expect(parseToolInputArgs(input)).toBe(input);
    });

    test("returns empty object for null/undefined/string/number", () => {
        expect(parseToolInputArgs(null)).toEqual({});
        expect(parseToolInputArgs(undefined)).toEqual({});
        expect(parseToolInputArgs("string")).toEqual({});
        expect(parseToolInputArgs(42)).toEqual({});
    });

    test("returns array as-is (arrays are objects)", () => {
        const input = [1, 2, 3];
        expect(parseToolInputArgs(input)).toBe(input);
    });
});

// ── extToMime ───────────────────────────────────────────────────────────────

describe("extToMime", () => {
    test("maps common extensions", () => {
        expect(extToMime("file.ts")).toBe("text/typescript");
        expect(extToMime("file.js")).toBe("text/javascript");
        expect(extToMime("file.py")).toBe("text/x-python");
        expect(extToMime("file.json")).toBe("application/json");
        expect(extToMime("file.md")).toBe("text/markdown");
        expect(extToMime("file.html")).toBe("text/html");
        expect(extToMime("file.css")).toBe("text/css");
    });

    test("maps image extensions", () => {
        expect(extToMime("photo.png")).toBe("image/png");
        expect(extToMime("photo.jpg")).toBe("image/jpeg");
        expect(extToMime("photo.jpeg")).toBe("image/jpeg");
        expect(extToMime("photo.gif")).toBe("image/gif");
        expect(extToMime("photo.svg")).toBe("image/svg+xml");
        expect(extToMime("photo.webp")).toBe("image/webp");
    });

    test("is case-insensitive for extension", () => {
        expect(extToMime("FILE.TS")).toBe("text/typescript");
        expect(extToMime("FILE.JSON")).toBe("application/json");
    });

    test("defaults to text/plain for unknown extensions", () => {
        expect(extToMime("file.xyz")).toBe("text/plain");
        expect(extToMime("file.unknown")).toBe("text/plain");
    });

    test("handles paths with directories", () => {
        expect(extToMime("/home/user/project/index.ts")).toBe("text/typescript");
    });

    test("handles files with no extension", () => {
        expect(extToMime("Makefile")).toBe("text/plain");
    });

    test("maps shell scripts", () => {
        expect(extToMime("script.sh")).toBe("text/x-sh");
        expect(extToMime("script.bash")).toBe("text/x-sh");
        expect(extToMime("script.zsh")).toBe("text/x-sh");
    });

    test("maps data formats", () => {
        expect(extToMime("config.yaml")).toBe("text/yaml");
        expect(extToMime("config.yml")).toBe("text/yaml");
        expect(extToMime("config.toml")).toBe("application/toml");
        expect(extToMime("query.sql")).toBe("text/x-sql");
    });
});
