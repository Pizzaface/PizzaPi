import { describe, expect, test } from "bun:test";
import { breadcrumbSegments, parentPath } from "./FolderBrowser";

describe("FolderBrowser Windows paths", () => {
    test("keeps backslashes in breadcrumb paths", () => {
        expect(breadcrumbSegments("C:\\Users\\me\\projects")).toEqual([
            { label: "C:", path: "C:\\" },
            { label: "Users", path: "C:\\Users" },
            { label: "me", path: "C:\\Users\\me" },
            { label: "projects", path: "C:\\Users\\me\\projects" },
        ]);
    });

    test("navigates up through backslash-separated paths", () => {
        expect(parentPath("C:\\Users\\me")).toBe("C:\\Users");
        expect(parentPath("C:\\Users")).toBe("C:\\");
        expect(parentPath("C:\\")).toBe("C:\\");
    });
});
