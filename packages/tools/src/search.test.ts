/**
 * search.test.ts — Unit + smoke tests for the search tool.
 *
 * Structure:
 *   1. Pure unit tests (no subprocess): escapeRgGlob, escapeFindPath, isFailure
 *   2. searchTool metadata (pure)
 *   3. Smoke tests — 3 real subprocess calls covering the happy path
 *   4. Input-sanitization tests — lightweight subprocess calls that verify
 *      path normalization / null-byte stripping (find exits fast on bad paths)
 */
import { describe, test, expect } from "bun:test";
import { searchTool, escapeRgGlob, escapeFindPath, isFailure } from "./search";
import type { SpawnResult } from "./search";
import { mkdtempSync, writeFileSync, mkdirSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { spawnSync } from "child_process";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Whether rg (ripgrep) is available on this machine. */
const hasRg = spawnSync("rg", ["--version"]).status === 0;

function makeTempDir(): string {
    const dir = mkdtempSync(join(tmpdir(), "search-test-"));
    writeFileSync(join(dir, "hello.txt"), "hello world\nfoo bar\n");
    writeFileSync(join(dir, "data.json"), '{"key": "value"}\n');
    mkdirSync(join(dir, "sub"));
    writeFileSync(join(dir, "sub", "nested.txt"), "nested content\nhello again\n");
    return dir;
}

function makeSpawnResult(overrides: Partial<SpawnResult> = {}): SpawnResult {
    return {
        lines: [],
        exitCode: 0,
        signal: null,
        truncated: false,
        ...overrides,
    };
}

// ---------------------------------------------------------------------------
// 1. Pure unit tests — escapeRgGlob
// ---------------------------------------------------------------------------

describe("escapeRgGlob", () => {
    test("passes through plain paths unchanged", () => {
        expect(escapeRgGlob("foo/bar/baz")).toBe("foo/bar/baz");
    });

    test("escapes square brackets", () => {
        expect(escapeRgGlob("secret[prod]")).toBe("secret\\[prod\\]");
    });

    test("escapes asterisks and question marks", () => {
        expect(escapeRgGlob("dir*name?")).toBe("dir\\*name\\?");
    });

    test("escapes curly braces", () => {
        expect(escapeRgGlob("data{old}")).toBe("data\\{old\\}");
    });

    test("escapes backslashes", () => {
        expect(escapeRgGlob("path\\to\\file")).toBe("path\\\\to\\\\file");
    });

    test("escapes multiple metacharacters in one path", () => {
        expect(escapeRgGlob("a[b]*c{d}?e\\f")).toBe("a\\[b\\]\\*c\\{d\\}\\?e\\\\f");
    });
});

// ---------------------------------------------------------------------------
// 2. Pure unit tests — escapeFindPath
// ---------------------------------------------------------------------------

describe("escapeFindPath", () => {
    test("passes through plain paths unchanged", () => {
        expect(escapeFindPath("/tmp/foo/bar")).toBe("/tmp/foo/bar");
    });

    test("escapes square brackets", () => {
        expect(escapeFindPath("/tmp/data[old]")).toBe("/tmp/data\\[old\\]");
    });

    test("escapes asterisks and question marks", () => {
        expect(escapeFindPath("/tmp/dir*name?")).toBe("/tmp/dir\\*name\\?");
    });

    test("escapes backslashes", () => {
        expect(escapeFindPath("/tmp/path\\to")).toBe("/tmp/path\\\\to");
    });

    test("does not escape curly braces (find doesn't glob them)", () => {
        expect(escapeFindPath("/tmp/data{old}")).toBe("/tmp/data{old}");
    });
});

// ---------------------------------------------------------------------------
// 3. Pure unit tests — isFailure
//    Covers rg vs find exit-code semantics and truncation handling.
// ---------------------------------------------------------------------------

describe("isFailure", () => {
    // --- content (rg) ---
    test("rg exit 0 is not a failure (matches found)", () => {
        expect(isFailure(makeSpawnResult({ exitCode: 0 }), "content")).toBe(false);
    });

    test("rg exit 1 is not a failure (no matches — normal rg behavior)", () => {
        expect(isFailure(makeSpawnResult({ exitCode: 1 }), "content")).toBe(false);
    });

    test("rg exit 2 is a failure (parse/IO error)", () => {
        expect(isFailure(makeSpawnResult({ exitCode: 2 }), "content")).toBe(true);
    });

    test("rg exit 3+ is a failure", () => {
        expect(isFailure(makeSpawnResult({ exitCode: 3 }), "content")).toBe(true);
        expect(isFailure(makeSpawnResult({ exitCode: 127 }), "content")).toBe(true);
    });

    // --- files (find) ---
    test("find exit 0 is not a failure", () => {
        expect(isFailure(makeSpawnResult({ exitCode: 0 }), "files")).toBe(false);
    });

    test("find exit 1 is a failure", () => {
        expect(isFailure(makeSpawnResult({ exitCode: 1 }), "files")).toBe(true);
    });

    test("find exit 2+ is a failure", () => {
        expect(isFailure(makeSpawnResult({ exitCode: 2 }), "files")).toBe(true);
    });

    // --- truncation ---
    test("truncated result is never a failure (intentional subprocess kill)", () => {
        expect(isFailure(makeSpawnResult({ exitCode: null, truncated: true }), "content")).toBe(false);
        expect(isFailure(makeSpawnResult({ exitCode: null, truncated: true }), "files")).toBe(false);
        // Even if exit code would normally signal failure, truncation wins
        expect(isFailure(makeSpawnResult({ exitCode: 2, truncated: true }), "content")).toBe(false);
    });

    // --- null exitCode ---
    test("null exitCode without truncation is a failure (timeout / ENOENT)", () => {
        expect(isFailure(makeSpawnResult({ exitCode: null, truncated: false }), "content")).toBe(true);
        expect(isFailure(makeSpawnResult({ exitCode: null, truncated: false }), "files")).toBe(true);
    });
});

// ---------------------------------------------------------------------------
// 4. Metadata — pure, no subprocess
// ---------------------------------------------------------------------------

describe("searchTool metadata", () => {
    test("has correct name and description", () => {
        expect(searchTool.name).toBe("search");
        expect(searchTool.description).toBeTruthy();
        expect(typeof searchTool.execute).toBe("function");
    });
});

// ---------------------------------------------------------------------------
// 5. Smoke tests — 3 real subprocess calls covering the happy path
// ---------------------------------------------------------------------------

describe("searchTool smoke tests", () => {
    test("files search finds matching files", async () => {
        const dir = makeTempDir();
        const result = await searchTool.execute("smoke-1", {
            pattern: "*.txt",
            path: dir,
            type: "files",
        });
        const text = result.content[0].text;
        expect(text).toContain("hello.txt");
        expect(text).toContain("nested.txt");
        expect(text).not.toContain("data.json");
        expect(result.details.type).toBe("files");
    });

    test("files search returns 'No matches found' for no results", async () => {
        const dir = makeTempDir();
        const result = await searchTool.execute("smoke-2", {
            pattern: "*.xyz",
            path: dir,
            type: "files",
        });
        expect(result.content[0].text).toBe("No matches found");
    });

    test("content search finds matching lines (skipped if rg not installed)", async () => {
        if (!hasRg) {
            console.log("rg not available — skipping content smoke test");
            return;
        }
        const dir = makeTempDir();
        const result = await searchTool.execute("smoke-3", {
            pattern: "hello",
            path: dir,
            type: "content",
        });
        expect(result.content[0].text).toContain("hello");
        expect(result.details.type).toBe("content");
    });
});

// ---------------------------------------------------------------------------
// 6. Input-sanitization tests — verify tool-level logic, not subprocess behavior.
//    These use real subprocess calls but they resolve fast (bad paths / no rg).
// ---------------------------------------------------------------------------

describe("searchTool input sanitization", () => {
    test("defaults type to 'content' when omitted", async () => {
        const dir = makeTempDir();
        const result = await searchTool.execute("san-default-type", {
            pattern: "nonexistent_xyz",
            path: dir,
            // no type — should default to content
        });
        expect(result.details.type).toBe("content");
    });

    test("handles null bytes in pattern and path without throwing", async () => {
        const dir = makeTempDir();
        // spawn() throws synchronously on \0 — tool must strip them
        const r1 = await searchTool.execute("san-null-pattern", {
            pattern: "*.txt\0injected",
            path: dir,
            type: "files",
        });
        expect(typeof r1.content[0].text).toBe("string");

        const r2 = await searchTool.execute("san-null-path", {
            pattern: "hello",
            path: `${dir}\0/etc/passwd`,
            type: "content",
        });
        expect(typeof r2.content[0].text).toBe("string");
    });

    test("expands ~ to home directory in path", async () => {
        const origHome = process.env.HOME;
        const fakeHome = mkdtempSync(join(tmpdir(), "search-tilde-"));
        mkdirSync(join(fakeHome, "proj"));
        writeFileSync(join(fakeHome, "proj", "tilde-marker.txt"), "tilde-test\n");
        process.env.HOME = fakeHome;
        try {
            const result = await searchTool.execute("san-tilde", {
                pattern: "*.txt",
                path: "~/proj",
                type: "files",
            });
            expect(result.content[0].text).toContain("tilde-marker.txt");
        } finally {
            process.env.HOME = origHome;
        }
    });

    test("path starting with '-' is made safe with ./ prefix", async () => {
        // Without safePath normalization, --help would be parsed as a flag
        const result = await searchTool.execute("san-dash-path", {
            pattern: "*.txt",
            path: "--help",
            type: "files",
        });
        const text = result.content[0].text;
        // Should error out cleanly (path doesn't exist), not show find/rg help text
        expect(text === "No matches found" || text.startsWith("Search failed:")).toBe(true);
    });

    test("nonexistent path surfaces error instead of 'No matches found'", async () => {
        const result = await searchTool.execute("san-no-path", {
            pattern: "*.txt",
            path: "/nonexistent/path/xyz-does-not-exist",
            type: "files",
        });
        const text = result.content[0].text;
        expect(text).toStartWith("Search failed:");
        expect(text).not.toBe("No matches found");
    });

    test("rg exit 1 (no matches) returns 'No matches found', not error (skipped if rg missing)", async () => {
        if (!hasRg) {
            console.log("rg not available — skipping rg exit-1 test");
            return;
        }
        const dir = makeTempDir();
        const result = await searchTool.execute("san-rg-nomatch", {
            pattern: "zzz_definitely_not_present_zzz",
            path: dir,
            type: "content",
        });
        expect(result.content[0].text).toBe("No matches found");
    });
});
