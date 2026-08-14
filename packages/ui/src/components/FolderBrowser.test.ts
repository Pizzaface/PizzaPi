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

    test("keeps UNC share roots in breadcrumbs", () => {
        expect(breadcrumbSegments("\\\\server\\share\\project")).toEqual([
            { label: "\\\\server\\share", path: "\\\\server\\share" },
            { label: "project", path: "\\\\server\\share\\project" },
        ]);
    });

    test("does not navigate above a UNC share root", () => {
        expect(parentPath("\\\\server\\share\\project")).toBe("\\\\server\\share");
        expect(parentPath("\\\\server\\share")).toBe("\\\\server\\share");
    });
});

describe("FolderBrowser POSIX paths", () => {
    test("navigates up through slash-separated paths", () => {
        expect(parentPath("/usr/local")).toBe("/usr");
        expect(parentPath("/usr")).toBe("/");
    });

    test("keeps the POSIX root stable", () => {
        expect(parentPath("/")).toBe("/");
    });
});
