import { describe, expect, test } from "bun:test";
import { resolveIconName } from "./lucide-icon";

describe("resolveIconName", () => {
    test("passes through valid canonical kebab-case names", () => {
        expect(resolveIconName("book-open")).toBe("book-open");
        expect(resolveIconName("activity")).toBe("activity");
    });

    test("returns undefined for unknown icon names", () => {
        expect(resolveIconName("nonexistent-icon-xyz")).toBeUndefined();
    });

    test("resolves any lucide icon, not just the old whitelist", () => {
        // arbitrary icons that were never in the old curated map
        for (const name of ["axe", "binoculars", "cassette-tape", "drum", "orbit"]) {
            expect(resolveIconName(name)).toBe(name);
        }
    });

    test("resolves legacy renamed lucide names via aliases", () => {
        const legacy = [
            "alert-circle", "alert-triangle", "bar-chart", "check-circle",
            "circle-help", "file-json", "filter", "fingerprint", "help-circle",
            "home", "kanban-square", "line-chart", "pie-chart", "stop-circle",
            "terminal-square", "train", "unlock", "x-circle",
        ];
        for (const name of legacy) {
            expect(resolveIconName(name)).toBeDefined();
        }
    });

    test("handles numeric suffixes in kebab names", () => {
        for (const name of ["gamepad-2", "building-2", "trash-2", "volume-2", "folder-git-2"]) {
            expect(resolveIconName(name)).toBe(name);
        }
    });
});
