import { describe, test, expect } from "bun:test";
import { formatTokens, truncateEnd, truncateMiddle, layoutLeftRight, sanitizeStatusText } from "./remote-footer.js";

describe("remote-footer utilities", () => {
    describe("formatTokens", () => {
        test("returns raw number for < 1000", () => {
            expect(formatTokens(0)).toBe("0");
            expect(formatTokens(999)).toBe("999");
        });
        test("returns Xk with decimal for < 10000", () => {
            expect(formatTokens(1000)).toBe("1.0k");
            expect(formatTokens(5432)).toBe("5.4k");
        });
        test("returns Xk rounded for < 1M", () => {
            expect(formatTokens(10000)).toBe("10k");
            expect(formatTokens(999999)).toBe("1000k");
        });
        test("returns XM for millions", () => {
            expect(formatTokens(1000000)).toBe("1.0M");
            expect(formatTokens(9999999)).toBe("10.0M");
            expect(formatTokens(10000000)).toBe("10M");
        });
    });

    describe("truncateEnd", () => {
        test("returns empty for width 0", () => {
            expect(truncateEnd("hello", 0)).toBe("");
        });
        test("returns full string when it fits", () => {
            expect(truncateEnd("hello", 10)).toBe("hello");
        });
        test("truncates with ellipsis", () => {
            expect(truncateEnd("hello world", 8)).toBe("hello...");
        });
        test("handles width <= 3", () => {
            expect(truncateEnd("hello", 3)).toBe("hel");
            expect(truncateEnd("hello", 1)).toBe("h");
        });
    });

    describe("truncateMiddle", () => {
        test("returns full string when it fits", () => {
            expect(truncateMiddle("hello", 10)).toBe("hello");
        });
        test("truncates in the middle", () => {
            expect(truncateMiddle("hello world!", 10)).toBe("hel...rld!");
        });
        test("falls back to truncateEnd for small widths", () => {
            expect(truncateMiddle("hello", 5)).toBe("hello");
            expect(truncateMiddle("hello world", 5)).toBe("he...");
        });
    });

    describe("layoutLeftRight", () => {
        test("returns empty for width 0", () => {
            const result = layoutLeftRight("left", "right", 0, truncateEnd);
            expect(result.left).toBe("");
            expect(result.right).toBe("");
        });
        test("lays out left and right with padding", () => {
            const result = layoutLeftRight("left", "right", 20, truncateEnd);
            expect(result.left).toBe("left");
            expect(result.right).toBe("right");
            expect(result.left.length + result.pad.length + result.right.length).toBe(20);
        });
        test("truncates left when space is tight", () => {
            const result = layoutLeftRight("a very long left string", "right", 15, truncateEnd);
            expect(result.right).toBe("right");
            expect(result.left.length + result.pad.length + result.right.length).toBe(15);
        });
    });

    describe("sanitizeStatusText", () => {
        test("strips ANSI codes", () => {
            expect(sanitizeStatusText("\x1B[31mred\x1B[0m")).toBe("red");
        });
        test("normalizes whitespace", () => {
            expect(sanitizeStatusText("  hello   world  ")).toBe("hello world");
        });
        test("replaces newlines and tabs", () => {
            expect(sanitizeStatusText("line1\nline2\ttab")).toBe("line1 line2 tab");
        });
    });
});
