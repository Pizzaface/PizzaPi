import { describe, expect, test } from "bun:test";
import { parseJsonArray } from "./api";
import { normalizePath, cwdMatchesRoots } from "../security";

// ── normalizePath ───────────────────────────────────────────────────────────

describe("normalizePath", () => {
    test("trims whitespace", () => {
        expect(normalizePath("  /home/user  ")).toBe("/home/user");
    });

    test("converts backslashes to forward slashes", () => {
        expect(normalizePath("C:\\Users\\me\\code")).toBe("C:/Users/me/code");
    });

    test("strips trailing slashes (except root)", () => {
        expect(normalizePath("/home/user/")).toBe("/home/user");
        expect(normalizePath("/home/user///")).toBe("/home/user");
    });

    test("preserves single-char paths (root)", () => {
        expect(normalizePath("/")).toBe("/");
    });

    test("handles Windows drive root", () => {
        expect(normalizePath("C:\\")).toBe("C:");
    });

    test("handles empty-ish strings", () => {
        expect(normalizePath("")).toBe("");
        expect(normalizePath("   ")).toBe("");
    });
});

// ── parseJsonArray ──────────────────────────────────────────────────────────

describe("parseJsonArray", () => {
    test("parses valid JSON array", () => {
        expect(parseJsonArray('[1, 2, 3]')).toEqual([1, 2, 3]);
    });

    test("parses array of strings", () => {
        expect(parseJsonArray('["a", "b"]')).toEqual(["a", "b"]);
    });

    test("returns empty array for null/undefined/empty", () => {
        expect(parseJsonArray(null)).toEqual([]);
        expect(parseJsonArray(undefined)).toEqual([]);
        expect(parseJsonArray("")).toEqual([]);
    });

    test("returns empty array for non-array JSON", () => {
        expect(parseJsonArray('{"key": "value"}')).toEqual([]);
        expect(parseJsonArray('"string"')).toEqual([]);
        expect(parseJsonArray("42")).toEqual([]);
    });

    test("returns empty array for invalid JSON", () => {
        expect(parseJsonArray("not json")).toEqual([]);
        expect(parseJsonArray("{broken")).toEqual([]);
    });
});

// ── cwdMatchesRoots ─────────────────────────────────────────────────────────

describe("cwdMatchesRoots", () => {
    test("exact match", () => {
        expect(cwdMatchesRoots(["/home/user/projects"], "/home/user/projects")).toBe(true);
    });

    test("subdirectory match", () => {
        expect(cwdMatchesRoots(["/home/user/projects"], "/home/user/projects/app")).toBe(true);
        expect(cwdMatchesRoots(["/home/user/projects"], "/home/user/projects/app/src")).toBe(true);
    });

    test("rejects paths outside roots", () => {
        expect(cwdMatchesRoots(["/home/user/projects"], "/home/user/other")).toBe(false);
        expect(cwdMatchesRoots(["/home/user/projects"], "/etc/passwd")).toBe(false);
    });

    test("rejects prefix match that is not a directory boundary", () => {
        // /home/user/projects-evil should NOT match /home/user/projects
        expect(cwdMatchesRoots(["/home/user/projects"], "/home/user/projects-evil")).toBe(false);
    });

    test("handles multiple roots", () => {
        const roots = ["/home/user/work", "/home/user/personal"];
        expect(cwdMatchesRoots(roots, "/home/user/work/app")).toBe(true);
        expect(cwdMatchesRoots(roots, "/home/user/personal/blog")).toBe(true);
        expect(cwdMatchesRoots(roots, "/tmp")).toBe(false);
    });

    test("handles trailing slashes in roots", () => {
        expect(cwdMatchesRoots(["/home/user/projects/"], "/home/user/projects/app")).toBe(true);
    });

    test("handles Windows paths", () => {
        expect(cwdMatchesRoots(["C:\\Users\\me\\code"], "C:\\Users\\me\\code\\app")).toBe(true);
        expect(cwdMatchesRoots(["C:\\Users\\me\\code"], "C:\\Users\\other")).toBe(false);
    });

    test("empty roots always returns false", () => {
        expect(cwdMatchesRoots([], "/any/path")).toBe(false);
    });
});
