import { describe, test, expect } from "bun:test";
import { searchTool } from "./search";
import { execFile } from "child_process";
import { promisify } from "util";
import { mkdtempSync, writeFileSync, mkdirSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { spawnSync } from "child_process";

const execFileAsync = promisify(execFile);

function makeTempDir(): string {
    const dir = mkdtempSync(join(tmpdir(), "search-test-"));
    writeFileSync(join(dir, "hello.txt"), "hello world\nfoo bar\n");
    writeFileSync(join(dir, "data.json"), '{"key": "value"}\n');
    mkdirSync(join(dir, "sub"));
    writeFileSync(join(dir, "sub", "nested.txt"), "nested content\nhello again\n");
    return dir;
}

describe("searchTool", () => {
    test("has correct metadata", () => {
        expect(searchTool.name).toBe("search");
        expect(searchTool.description).toBeTruthy();
    });

    test("files search finds matching files", async () => {
        const dir = makeTempDir();
        const result = await searchTool.execute("test-1", {
            pattern: "*.txt",
            path: dir,
            type: "files",
        });
        const text = result.content[0].text;
        expect(text).toContain("hello.txt");
        expect(text).toContain("nested.txt");
        expect(text).not.toContain("data.json");
    });

    test("files search returns 'No matches found' for no results", async () => {
        const dir = makeTempDir();
        const result = await searchTool.execute("test-2", {
            pattern: "*.xyz",
            path: dir,
            type: "files",
        });
        expect(result.content[0].text).toBe("No matches found");
    });

    test("content search finds matching lines", async () => {
        const dir = makeTempDir();
        // Check if rg is available
        try {
            await execFileAsync("rg", ["--version"]);
        } catch {
            console.log("rg not available, skipping content search test");
            return;
        }
        const result = await searchTool.execute("test-3", {
            pattern: "hello",
            path: dir,
            type: "content",
        });
        const text = result.content[0].text;
        expect(text).toContain("hello");
    });

    test("defaults to content search when type is omitted", async () => {
        const dir = makeTempDir();
        const result = await searchTool.execute("test-4", {
            pattern: "nonexistent_string_xyz",
            path: dir,
        });
        // Should not throw — type defaults to "content"
        expect(result.details.type).toBe("content");
    });

    test("does not allow shell injection via pattern", async () => {
        const dir = makeTempDir();
        // A malicious pattern that would execute a command if passed to a shell
        // With execFile this is safely treated as a literal find -name argument
        const result = await searchTool.execute("test-inject-1", {
            pattern: '"; echo INJECTED; "',
            path: dir,
            type: "files",
        });
        const text = result.content[0].text;
        // The injection payload must NOT appear in output
        expect(text).not.toContain("INJECTED");
    });

    test("does not allow shell injection via path", async () => {
        const dir = makeTempDir();
        // A malicious path that would execute a command if passed to a shell.
        // With spawn (no shell), `; echo INJECTED` is part of the literal path,
        // so find treats it as a (nonexistent) directory — no command execution.
        const result = await searchTool.execute("test-inject-2", {
            pattern: "*.txt",
            path: `${dir}; echo INJECTED`,
            type: "files",
        });
        const text = result.content[0].text;
        // The output should be an error (nonexistent path) or no matches —
        // NOT actual output from `echo INJECTED` as a separate command.
        // The error message may echo the path name, so we check it's a
        // Search failed message (find error) rather than bare "INJECTED" output.
        expect(text.startsWith("Search failed:") || text === "No matches found").toBe(true);
        // Crucially, no files should be returned (injection didn't work)
        expect(text).not.toContain("hello.txt");
    });

    test("truncates output to max lines", async () => {
        // Create a directory with many files
        const dir = mkdtempSync(join(tmpdir(), "search-trunc-"));
        for (let i = 0; i < 60; i++) {
            writeFileSync(join(dir, `file-${String(i).padStart(3, "0")}.txt`), `content ${i}\n`);
        }
        const result = await searchTool.execute("test-trunc", {
            pattern: "*.txt",
            path: dir,
            type: "files",
        });
        const lines = result.content[0].text.split("\n").filter(Boolean);
        expect(lines.length).toBeLessThanOrEqual(50);
    });

    test("files search caps at exactly 50 lines on large result sets", async () => {
        // Create 5000 files — well beyond the 50-line cap — to stress the
        // streaming kill logic and verify no off-by-one from post-kill data events.
        const dir = mkdtempSync(join(tmpdir(), "search-stream-"));
        for (let i = 0; i < 5000; i++) {
            writeFileSync(join(dir, `item-${String(i).padStart(5, "0")}.txt`), `data ${i}\n`);
        }

        const result = await searchTool.execute("test-stream", {
            pattern: "*.txt",
            path: dir,
            type: "files",
        });

        const text = result.content[0].text;
        const lines = text.split("\n").filter(Boolean);

        // Must return exactly 50 lines (the cap), never 51+
        expect(lines.length).toBe(50);
        for (const line of lines) {
            expect(line).toContain("item-");
        }
    });

    test("content search caps at exactly 100 lines on large result sets", async () => {
        try {
            const r = spawnSync("rg", ["--version"]);
            if (r.status !== 0) throw new Error();
        } catch {
            console.log("rg not available, skipping content cap test");
            return;
        }
        // Create a file with 5000 matching lines
        const dir = mkdtempSync(join(tmpdir(), "search-rg-cap-"));
        const fileLines: string[] = [];
        for (let i = 0; i < 5000; i++) {
            fileLines.push(`match-line-${i}`);
        }
        writeFileSync(join(dir, "big.txt"), fileLines.join("\n") + "\n");

        const result = await searchTool.execute("test-rg-cap", {
            pattern: "match-line",
            path: dir,
            type: "content",
        });

        const resultLines = result.content[0].text.split("\n").filter(Boolean);
        expect(resultLines.length).toBe(100);
    });

    test("does not allow option injection via pattern starting with -", async () => {
        const dir = makeTempDir();
        // A pattern starting with -- that would be parsed as an rg flag
        // if not protected by -e / --
        const result = await searchTool.execute("test-opt-inject-1", {
            pattern: "--help",
            path: dir,
            type: "content",
        });
        const text = result.content[0].text;
        // rg --help output contains "USAGE" — that should NOT appear
        expect(text).not.toContain("USAGE");
    });

    test("does not allow option injection via path starting with -", async () => {
        // A path like "--help" would trigger GNU find's help output if passed raw.
        // The safePath normalization should turn it into "./--help", which is
        // treated as a literal (non-existent) directory on both BSD and GNU find.
        const result = await searchTool.execute("test-opt-inject-2", {
            pattern: "*.txt",
            path: "--help",
            type: "files",
        });
        const text = result.content[0].text;
        // Must NOT contain help/usage output from find
        expect(text.toLowerCase()).not.toContain("usage");
        // Should be either "No matches found" or "Search failed: ..." (path doesn't exist)
        expect(text === "No matches found" || text.startsWith("Search failed:")).toBe(true);
    });

    test("surfaces find errors for nonexistent paths instead of 'No matches'", async () => {
        const result = await searchTool.execute("test-find-err", {
            pattern: "*.txt",
            path: "/nonexistent/path/that/does/not/exist",
            type: "files",
        });
        const text = result.content[0].text;
        // find exits non-zero for bad paths — must surface as error, not "No matches found"
        expect(text).toStartWith("Search failed:");
        expect(text).not.toBe("No matches found");
    });

    test("surfaces rg errors for invalid regex", async () => {
        try {
            const r = spawnSync("rg", ["--version"]);
            if (r.status !== 0) throw new Error();
        } catch {
            console.log("rg not available, skipping rg error test");
            return;
        }
        const dir = makeTempDir();
        // Invalid regex — rg exits with code 2
        const result = await searchTool.execute("test-rg-err", {
            pattern: "[invalid",
            path: dir,
            type: "content",
        });
        const text = result.content[0].text;
        expect(text).toStartWith("Search failed:");
    });

    test("rg exit 1 (no matches) returns 'No matches found', not an error", async () => {
        try {
            const r = spawnSync("rg", ["--version"]);
            if (r.status !== 0) throw new Error();
        } catch {
            console.log("rg not available, skipping rg no-match test");
            return;
        }
        const dir = makeTempDir();
        const result = await searchTool.execute("test-rg-nomatch", {
            pattern: "zzz_definitely_not_present_zzz",
            path: dir,
            type: "content",
        });
        expect(result.content[0].text).toBe("No matches found");
    });

    test("surfaces partial errors when find has results but also errors", async () => {
        // Create a directory with an unreadable subdirectory
        const dir = mkdtempSync(join(tmpdir(), "search-partial-"));
        writeFileSync(join(dir, "visible.txt"), "data\n");
        const badDir = join(dir, "noperm");
        mkdirSync(badDir, { mode: 0o000 });

        try {
            const result = await searchTool.execute("test-partial-err", {
                pattern: "*.txt",
                path: dir,
                type: "files",
            });
            const text = result.content[0].text;

            // Should still return the visible file
            expect(text).toContain("visible.txt");

            // On systems where permission is actually denied (not running as root),
            // should include a warning about missing results
            if (process.getuid?.() !== 0) {
                expect(text).toContain("[warning:");
            }
        } finally {
            // Restore permissions so temp cleanup works
            const { chmodSync } = require("fs");
            chmodSync(badDir, 0o755);
        }
    });

    test("handles content search on file with no trailing newline", async () => {
        try {
            const r = spawnSync("rg", ["--version"]);
            if (r.status !== 0) throw new Error();
        } catch {
            console.log("rg not available, skipping no-trailing-newline test");
            return;
        }
        const dir = mkdtempSync(join(tmpdir(), "search-nonl-"));
        // File with no trailing newline
        writeFileSync(join(dir, "noterminal.txt"), "last-line-no-newline");

        const result = await searchTool.execute("test-nonl", {
            pattern: "last-line",
            path: dir,
            type: "content",
        });
        expect(result.content[0].text).toContain("last-line-no-newline");
    });

    test("handles null bytes in pattern and path without throwing", async () => {
        const dir = makeTempDir();
        // Null bytes in args would cause spawn() to throw — must be handled gracefully
        const result1 = await searchTool.execute("test-null-pattern", {
            pattern: "*.txt\0injected",
            path: dir,
            type: "files",
        });
        expect(typeof result1.content[0].text).toBe("string");

        const result2 = await searchTool.execute("test-null-path", {
            pattern: "hello",
            path: `${dir}\0/etc/passwd`,
            type: "content",
        });
        expect(typeof result2.content[0].text).toBe("string");
    });

    test("preserves Unicode filenames in file search results", async () => {
        const dir = mkdtempSync(join(tmpdir(), "search-unicode-"));
        // Create files with multi-byte UTF-8 names: accented, CJK, emoji
        const names = ["café.txt", "日本語.txt", "🎉party.txt"];
        for (const name of names) {
            writeFileSync(join(dir, name), "data\n");
        }

        const result = await searchTool.execute("test-unicode-files", {
            pattern: "*.txt",
            path: dir,
            type: "files",
        });
        const text = result.content[0].text;
        for (const name of names) {
            expect(text).toContain(name);
        }
        // Must not contain replacement character (U+FFFD) from broken decoding
        expect(text).not.toContain("\uFFFD");
    });

    test("preserves Unicode content in content search results", async () => {
        try {
            const r = spawnSync("rg", ["--version"]);
            if (r.status !== 0) throw new Error();
        } catch {
            console.log("rg not available, skipping unicode content test");
            return;
        }
        const dir = mkdtempSync(join(tmpdir(), "search-unicode-content-"));
        const content = "résultat: données CJK 漢字 emoji 🚀✨\n";
        writeFileSync(join(dir, "unicode.txt"), content);

        const result = await searchTool.execute("test-unicode-content", {
            pattern: "résultat",
            path: dir,
            type: "content",
        });
        const text = result.content[0].text;
        expect(text).toContain("résultat");
        expect(text).toContain("漢字");
        expect(text).toContain("🚀");
        expect(text).not.toContain("\uFFFD");
    });
});
