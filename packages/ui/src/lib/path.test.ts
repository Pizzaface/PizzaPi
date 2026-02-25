import { describe, expect, test } from "bun:test";
import { formatPathTail } from "./path";

describe("formatPathTail", () => {
    test("returns empty string for empty input", () => {
        expect(formatPathTail("")).toBe("");
    });

    test("returns full path for single segment", () => {
        expect(formatPathTail("/home")).toBe("/home");
    });

    test("shows last 2 segments by default", () => {
        expect(formatPathTail("/home/user/projects/app")).toBe("/…/projects/app");
    });

    test("respects maxSegments parameter", () => {
        expect(formatPathTail("/a/b/c/d", 3)).toBe("/…/b/c/d");
        expect(formatPathTail("/a/b/c/d", 1)).toBe("/…/d");
    });

    test("handles Windows drive letters", () => {
        expect(formatPathTail("C:/Users/me/code/project")).toBe("C:/…/code/project");
    });

    test("handles backslashes (Windows paths)", () => {
        expect(formatPathTail("C:\\Users\\me\\code\\project")).toBe("C:/…/code/project");
    });

    test("handles two-segment paths", () => {
        // segmentsToShow = min(maxSegments, max(1, parts.length - 1))
        // With 2 parts, always shows 1 tail segment regardless of maxSegments
        expect(formatPathTail("/home/user")).toBe("/…/user");
        expect(formatPathTail("/home/user", 3)).toBe("/…/user");
    });

    test("handles root path", () => {
        expect(formatPathTail("/")).toBe("/");
    });

    test("handles relative paths", () => {
        expect(formatPathTail("a/b/c/d")).toBe("…/c/d");
    });
});
