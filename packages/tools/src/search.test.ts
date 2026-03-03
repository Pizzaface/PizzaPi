import { describe, test, expect } from "bun:test";
import { searchTool } from "./search";
import { execFile } from "child_process";
import { promisify } from "util";
import { mkdtempSync, writeFileSync, mkdirSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";

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
});
