import { describe, test, expect } from "bun:test";

/**
 * Unit tests for the recent-project filtering logic used in NewSessionWizardDialog.
 *
 * Mirrors the `filterFolders` function defined in the component:
 *   - Case-insensitive substring match
 *   - OR logic: match if found in full path OR basename
 */

function filterFolders(folders: string[], query: string): string[] {
    if (!query.trim()) return folders;
    const q = query.toLowerCase();
    return folders.filter((f) => {
        const basename = f.split("/").filter(Boolean).pop() ?? f;
        return f.toLowerCase().includes(q) || basename.toLowerCase().includes(q);
    });
}

const FOLDERS = [
    "/home/user/src/project",
    "/code/PizzaPi",
    "/code/pizza-tools",
    "/home/user/work/notes",
    "/tmp/scratch",
    "/home/src-archive/old",
];

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
