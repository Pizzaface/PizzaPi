import { describe, test, expect } from "bun:test";
import { vlen, wrap, computeBoxWidth, makeOptRow } from "./remote-plan-mode.js";

// ── vlen ──────────────────────────────────────────────────────────────────────

describe("vlen", () => {
    test("plain ASCII string", () => {
        expect(vlen("hello")).toBe(5);
    });

    test("empty string", () => {
        expect(vlen("")).toBe(0);
    });

    test("strips ANSI bold escape", () => {
        // \x1b[1m...\x1b[22m should not add to the visible width
        expect(vlen("\x1b[1mhello\x1b[22m")).toBe(5);
    });

    test("strips ANSI 24-bit colour escape", () => {
        expect(vlen("\x1b[38;2;232;180;248mworld\x1b[39m")).toBe(5);
    });

    test("strips ANSI dim escape", () => {
        expect(vlen("\x1b[2mfoo\x1b[22m")).toBe(3);
    });

    test("mixed styled and plain text", () => {
        // "ab" + ANSI-bold("cd") = 4 visible chars
        expect(vlen("ab\x1b[1mcd\x1b[22m")).toBe(4);
    });

    test("BMP emoji counts as 1", () => {
        // U+2764 ❤ is in BMP (≤ 0xFFFF), counts as 1
        expect(vlen("❤")).toBe(1);
    });

    test("astral emoji counts as 2", () => {
        // U+1F4CB 📋 is above 0xFFFF (astral), counts as 2
        expect(vlen("📋")).toBe(2);
    });

    test("mixed plain + astral emoji", () => {
        // "hi" (2) + "📋" (2) = 4
        expect(vlen("hi📋")).toBe(4);
    });

    test("multiple ANSI sequences on one string", () => {
        const styled = "\x1b[1m\x1b[38;2;232;180;248m(1)\x1b[39m\x1b[22m Clear Context & Begin";
        // "(1) Clear Context & Begin" = 25 chars
        expect(vlen(styled)).toBe(25);
    });
});

// ── wrap ──────────────────────────────────────────────────────────────────────

describe("wrap", () => {
    test("short text fits on one line", () => {
        expect(wrap("hello world", 20)).toEqual(["hello world"]);
    });

    test("exact fit", () => {
        expect(wrap("hello", 5)).toEqual(["hello"]);
    });

    test("wraps at word boundary", () => {
        expect(wrap("hello world", 8)).toEqual(["hello", "world"]);
    });

    test("multiple wraps", () => {
        const result = wrap("one two three four five", 10);
        expect(result).toEqual(["one two", "three four", "five"]);
    });

    test("maxWidth <= 0 returns text as-is", () => {
        expect(wrap("hello", 0)).toEqual(["hello"]);
        expect(wrap("hello", -1)).toEqual(["hello"]);
    });

    test("empty string", () => {
        expect(wrap("", 10)).toEqual([""]);
    });

    test("single word shorter than maxWidth", () => {
        expect(wrap("hi", 10)).toEqual(["hi"]);
    });

    // P1 fix: long-word splitting
    test("single word exactly equal to maxWidth is not split", () => {
        expect(wrap("abcde", 5)).toEqual(["abcde"]);
    });

    test("single word longer than maxWidth is split into chunks", () => {
        // "abcdefghij" (10) with maxWidth=4 → ["abcd", "efgh", "ij"]
        expect(wrap("abcdefghij", 4)).toEqual(["abcd", "efgh", "ij"]);
    });

    test("long word in the middle of text is split", () => {
        // "aaa BBBBBBBBBB ccc" with maxWidth=5
        // "aaa" fits; "BBBBBBBBBB" is split into "BBBBB","BBBBB"; "ccc" follows
        expect(wrap("aaa BBBBBBBBBB ccc", 5)).toEqual(["aaa", "BBBBB", "BBBBB", "ccc"]);
    });

    test("long word followed by short words wraps correctly", () => {
        // "ABCDEFGH" (8) at maxWidth=5 → "ABCDE", "FGH"; then "ok" can't join "FGH"
        // because "FGH ok" = 6 > 5, so each ends on its own line
        expect(wrap("ABCDEFGH ok", 5)).toEqual(["ABCDE", "FGH", "ok"]);
    });

    test("multiple consecutive long words", () => {
        // Each word is 6 chars, maxWidth=4
        expect(wrap("aaaaaa bbbbbb", 4)).toEqual(["aaaa", "aa", "bbbb", "bb"]);
    });

    test("word that is exactly twice maxWidth splits into two equal chunks", () => {
        expect(wrap("abcdabcd", 4)).toEqual(["abcd", "abcd"]);
    });

    test("preserves already-wrapped lines as-is when all words fit", () => {
        expect(wrap("hi there", 10)).toEqual(["hi there"]);
    });
});

// ── computeBoxWidth ───────────────────────────────────────────────────────────

describe("computeBoxWidth", () => {
    test("short title returns minimum 62", () => {
        expect(computeBoxWidth(10, 100)).toBe(62);
    });

    test("title length that produces value between 62 and upper cap", () => {
        // titleLen=60 → desired=76; upper=min(200-4,120)=120 → result=76
        expect(computeBoxWidth(60, 200)).toBe(76);
    });

    test("very long title is capped at 120 (wide terminal)", () => {
        // titleLen=200 → desired=216; upper=min(200-4,120)=120 → result=120
        expect(computeBoxWidth(200, 200)).toBe(120);
    });

    test("never exceeds 120 regardless of title or terminal width", () => {
        expect(computeBoxWidth(9999, 9999)).toBe(120);
    });

    test("caps at termCols - 4 when terminal is narrower than 124 cols", () => {
        // termCols=80 → upper=min(76,120)=76; desired=62+16=78 → result=min(78,76)=76
        expect(computeBoxWidth(62, 80)).toBe(76);
    });

    test("uses 80 as fallback when termCols is not provided", () => {
        // Can't know process.stdout.columns in test, but the function should not throw
        const result = computeBoxWidth(10);
        expect(typeof result).toBe("number");
        expect(result).toBeGreaterThanOrEqual(62);
        expect(result).toBeLessThanOrEqual(120);
    });

    test("minimum 62 even if terminal is very narrow", () => {
        // termCols=20 → upper=min(16,120)=16; desired=10+16=26 → Math.max(62,…)=62
        expect(computeBoxWidth(10, 20)).toBe(62);
    });
});

// ── makeOptRow ────────────────────────────────────────────────────────────────

describe("makeOptRow", () => {
    test("two short options are separated by default gap", () => {
        // vlen("(1) Go") = 6; col1Width=30; gap=" ".repeat(max(2,30-6))=24
        const result = makeOptRow("(1) Go", "(2) Stop");
        expect(result).toBe("  (1) Go" + " ".repeat(24) + "(2) Stop");
    });

    test("first option at exactly col1Width uses minimum gap of 2", () => {
        const o1 = "a".repeat(30); // exactly col1Width
        const result = makeOptRow(o1, "B");
        // gap = max(2, 30-30) = 2
        expect(result).toBe("  " + o1 + "  B");
    });

    test("first option wider than col1Width still uses minimum gap of 2", () => {
        const o1 = "a".repeat(40); // wider than default col1Width=30
        const result = makeOptRow(o1, "B");
        expect(result).toBe("  " + o1 + "  B");
    });

    test("custom col1Width adjusts gap", () => {
        // col1Width=10, o1="abc" (3), gap=max(2,10-3)=7
        const result = makeOptRow("abc", "xyz", 10);
        expect(result).toBe("  abc" + " ".repeat(7) + "xyz");
    });

    test("ANSI-styled option: vlen is used for width, not .length", () => {
        // \x1b[38;2;…m(1)\x1b[39m = 3 visible chars but more raw chars
        const o1 = "\x1b[38;2;232;180;248m(1)\x1b[39m Go";
        // vlen(o1) = 3 + 3 = 6 (" Go" = 3, "(1)" = 3)
        const o2 = "(2) Stop";
        const result = makeOptRow(o1, o2, 30);
        // gap = max(2, 30 - vlen(o1)) = max(2, 30 - 6) = 24
        expect(result).toBe("  " + o1 + " ".repeat(24) + o2);
    });

    test("result always starts with two spaces", () => {
        expect(makeOptRow("x", "y").startsWith("  ")).toBe(true);
    });
});
