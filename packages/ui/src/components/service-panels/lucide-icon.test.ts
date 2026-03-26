import { describe, expect, test } from "bun:test";
import { getLucideIcon } from "./lucide-icon";
import { BookOpen, Activity, Square } from "lucide-react";

describe("getLucideIcon", () => {
    test("resolves kebab-case icon names to lucide components", () => {
        expect(getLucideIcon("book-open")).toBe(BookOpen);
        expect(getLucideIcon("activity")).toBe(Activity);
    });

    test("falls back to Square for unknown icon names", () => {
        expect(getLucideIcon("nonexistent-icon-xyz")).toBe(Square);
    });

    test("handles forwardRef components (typeof object)", () => {
        // lucide-react ≥0.300 exports icons as React.forwardRef objects
        expect(typeof BookOpen).toBe("object");
        // getLucideIcon must still resolve them correctly
        expect(getLucideIcon("book-open")).toBe(BookOpen);
    });
});
