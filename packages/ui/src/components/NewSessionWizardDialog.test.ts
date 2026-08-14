import { describe, test, expect } from "bun:test";
import { filterFolders, getInitialFolder } from "../lib/filterFolders.js";

/**
 * Unit tests for the recent-project filtering logic used in NewSessionWizardDialog.
 *
 * Tests the production `filterFolders` function from lib/filterFolders.ts:
 *   - Case-insensitive substring match
 *   - OR logic: match if found in full path OR basename
 */

const FOLDERS = [
    "/home/user/src/project",
    "/code/PizzaPi",
    "/code/pizza-tools",
    "/home/user/work/notes",
    "/tmp/scratch",
    "/home/src-archive/old",
];

describe("getInitialFolder", () => {
    test("preselects the top-ranked folder", () => {
        expect(getInitialFolder("runner-1", ["/code/often", "/code/once"])).toBe("/code/often");
    });

    test("keeps an explicit initial folder", () => {
        expect(getInitialFolder("runner-1", ["/code/often"], "/custom/path")).toBe("/custom/path");
    });

    test("prefers a persisted explicit selection", () => {
        const previous = Object.getOwnPropertyDescriptor(globalThis, "localStorage");
        Object.defineProperty(globalThis, "localStorage", {
            configurable: true,
            value: { getItem: () => "/code/explicit" },
        });
        try {
            expect(getInitialFolder("runner-1", ["/code/top", "/code/explicit"])).toBe("/code/explicit");
        } finally {
            if (previous) Object.defineProperty(globalThis, "localStorage", previous);
            else delete (globalThis as any).localStorage;
        }
    });
});

describe("filterFolders", () => {
    test("empty query returns all folders", () => {
        expect(filterFolders(FOLDERS, "")).toEqual(FOLDERS);
        expect(filterFolders(FOLDERS, "   ")).toEqual(FOLDERS);
    });

    test("case-insensitive match on full path", () => {
        const result = filterFolders(FOLDERS, "PIZZAPI");
        expect(result).toContain("/code/PizzaPi");
    });

    test("case-insensitive match on basename", () => {
        const result = filterFolders(FOLDERS, "pizza");
        expect(result).toContain("/code/PizzaPi");
        expect(result).toContain("/code/pizza-tools");
    });

    test("OR logic — matches if in full path even if not in basename", () => {
        // 'src' appears in the full path '/home/user/src/project' and '/home/src-archive/old'
        // but not necessarily as the basename
        const result = filterFolders(FOLDERS, "src");
        expect(result).toContain("/home/user/src/project");
        expect(result).toContain("/home/src-archive/old");
    });

    test("no match returns empty array", () => {
        const result = filterFolders(FOLDERS, "xyzzy-nonexistent");
        expect(result).toHaveLength(0);
    });

    test("filters to single exact basename match", () => {
        const result = filterFolders(FOLDERS, "scratch");
        expect(result).toEqual(["/tmp/scratch"]);
    });

    test("full path substring match", () => {
        // 'work' appears in the full path '/home/user/work/notes'
        const result = filterFolders(FOLDERS, "work");
        expect(result).toContain("/home/user/work/notes");
    });

    test("empty folders list returns empty", () => {
        expect(filterFolders([], "pizza")).toEqual([]);
    });
});
