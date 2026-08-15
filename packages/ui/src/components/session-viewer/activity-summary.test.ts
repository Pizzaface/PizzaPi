import { describe, expect, test } from "bun:test";
import { baseName, summarizeToolActivity } from "./activity-summary";

describe("summarizeToolActivity", () => {
    test("file tools name the file, not the path", () => {
        expect(summarizeToolActivity("write", { file_path: "/w/reports/q3.md" }).label).toBe("Created q3.md");
        expect(summarizeToolActivity("edit", { file_path: "/w/reports/q3.md" }).label).toBe("Edited q3.md");
        expect(summarizeToolActivity("read", { path: "/w/data.csv" }).label).toBe("Read data.csv");
    });

    test("file tools stay legible when the path is missing", () => {
        expect(summarizeToolActivity("write", {}).label).toBe("Created a file");
        expect(summarizeToolActivity("read", undefined).label).toBe("Read a file");
    });

    test("bash prefers its title and keeps the command as detail", () => {
        const withTitle = summarizeToolActivity("bash", { command: "ls -la", title: "List the workspace" });
        expect(withTitle.label).toBe("List the workspace");
        expect(withTitle.detail).toBe("ls -la");

        const withoutTitle = summarizeToolActivity("bash", { command: "ls -la" });
        expect(withoutTitle.label).toBe("Ran a command");
    });

    test("search tools quote the query", () => {
        expect(summarizeToolActivity("web_search", { query: "bond yields" }).label).toBe('Searched the web for "bond yields"');
        expect(summarizeToolActivity("grep", { pattern: "TODO" }).label).toBe('Searched for "TODO"');
        expect(summarizeToolActivity("session_search", { query: "acme" }).label).toBe('Searched history for "acme"');
    });

    test("web_fetch reduces a url to its host", () => {
        expect(summarizeToolActivity("web_fetch", { url: "https://example.com/a/b?c=1" }).label).toBe("Read example.com");
        // A malformed url must still produce a line rather than throwing.
        expect(summarizeToolActivity("web_fetch", { url: "not a url" }).label).toBe("Read not a url");
    });

    test("input arriving as a JSON string is parsed", () => {
        expect(summarizeToolActivity("write", JSON.stringify({ file_path: "/w/a.md" })).label).toBe("Created a.md");
        // Non-JSON strings must not throw.
        expect(summarizeToolActivity("write", "oops").label).toBe("Created a file");
    });

    test("namespaced mcp and plugin tools summarize like their base tool", () => {
        expect(summarizeToolActivity("mcp__files__write", { file_path: "/w/a.md" }).label).toBe("Created a.md");
        expect(summarizeToolActivity("plugin.read", { path: "/w/a.md" }).label).toBe("Read a.md");
    });

    test("unknown tools fall back to a humanized name", () => {
        expect(summarizeToolActivity("capture_idea", {}).label).toBe("Capture idea");
        expect(summarizeToolActivity("mcp__godmother__list_epics", {}).label).toBe("List epics");
    });

    test("long queries and commands are clamped rather than unbounded", () => {
        const long = "x".repeat(200);
        // Exact widths are a CSS concern; what matters is the raw value never
        // reaches the line intact.
        expect(summarizeToolActivity("bash", { command: long }).detail!.length).toBeLessThanOrEqual(80);
        const searchLabel = summarizeToolActivity("web_search", { query: long }).label;
        expect(searchLabel.length).toBeLessThan(100);
        expect(searchLabel).toContain("…");
    });

    test("every summary carries an icon", () => {
        for (const name of ["write", "edit", "read", "bash", "web_search", "update_todo", "mystery_tool"]) {
            expect(summarizeToolActivity(name, {}).icon.length).toBeGreaterThan(0);
        }
    });
});

describe("baseName", () => {
    test("handles posix and windows separators", () => {
        expect(baseName("/a/b/c.md")).toBe("c.md");
        expect(baseName("a\\b\\c.md")).toBe("c.md");
        expect(baseName("c.md")).toBe("c.md");
    });
});
