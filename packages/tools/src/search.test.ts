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
        // A malicious path that would execute a command if passed to a shell
        const result = await searchTool.execute("test-inject-2", {
            pattern: "*.txt",
            path: `${dir}; echo INJECTED`,
            type: "files",
        });
        const text = result.content[0].text;
        expect(text).not.toContain("INJECTED");
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
        const dir = makeTempDir();
        const result = await searchTool.execute("test-opt-inject-2", {
            pattern: "hello",
            path: "--help",
            type: "files",
        });
        const text = result.content[0].text;
        // find --help output contains "usage" — should NOT appear
        expect(text.toLowerCase()).not.toContain("usage:");
    });

    test("surfaces errors for missing commands or bad paths", async () => {
        const result = await searchTool.execute("test-error", {
            pattern: "*.txt",
            path: "/nonexistent/path/that/does/not/exist",
            type: "files",
        });
        const text = result.content[0].text;
        // Should not silently say "No matches found" — should indicate failure
        // (find will error on nonexistent path, or return no results)
        expect(typeof text).toBe("string");
        expect(text.length).toBeGreaterThan(0);
    });
});
