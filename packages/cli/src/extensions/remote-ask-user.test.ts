import { describe, test, expect } from "bun:test";
import {
    sanitizeQuestions,
    sanitizeDisplay,
    BOX_W,
    visLen,
    padTo,
    wrapText,
    bRow,
    typeLabel,
    buildBox,
} from "./remote-ask-user.js";

// ── sanitizeQuestions ────────────────────────────────────────────────────────

describe("remote-ask-user", () => {
    describe("sanitizeQuestions", () => {
        test("parses new format with questions array", () => {
            const result = sanitizeQuestions({
                questions: [
                    { question: "Pick a color", options: ["red", "blue"] },
                    { question: "Pick a size", options: ["small", "large"] },
                ],
            });
            expect(result).toHaveLength(2);
            expect(result[0].question).toBe("Pick a color");
            expect(result[0].options).toEqual(["red", "blue"]);
        });

        test("parses legacy format with single question", () => {
            const result = sanitizeQuestions({
                question: "Pick a color",
                options: ["red", "blue"],
            });
            expect(result).toHaveLength(1);
            expect(result[0].question).toBe("Pick a color");
            expect(result[0].options).toEqual(["red", "blue"]);
        });

        test("returns empty for no questions", () => {
            expect(sanitizeQuestions({})).toEqual([]);
            expect(sanitizeQuestions({ question: "" })).toEqual([]);
            expect(sanitizeQuestions({ questions: [] })).toEqual([]);
        });

        test("filters invalid items from questions array", () => {
            const result = sanitizeQuestions({
                questions: [
                    null as any,
                    { question: "", options: [] },
                    { question: "Valid?", options: ["yes"] },
                ],
            });
            expect(result).toHaveLength(1);
            expect(result[0].question).toBe("Valid?");
        });

        test("trims whitespace from questions and options", () => {
            const result = sanitizeQuestions({
                questions: [
                    { question: "  spaced  ", options: ["  a  ", "  b  "] },
                ],
            });
            expect(result[0].question).toBe("spaced");
            expect(result[0].options).toEqual(["a", "b"]);
        });

        test("filters empty string options", () => {
            const result = sanitizeQuestions({
                questions: [
                    { question: "Q", options: ["a", "", "  ", "b"] },
                ],
            });
            expect(result[0].options).toEqual(["a", "b"]);
        });

        test("falls back to legacy when questions array is empty after filtering", () => {
            const result = sanitizeQuestions({
                questions: [{ question: "", options: [] }],
                question: "Fallback?",
                options: ["yes"],
            });
            expect(result).toHaveLength(1);
            expect(result[0].question).toBe("Fallback?");
        });
    });

    describe("sanitizeDisplay", () => {
        test("always returns stepper", () => {
            expect(sanitizeDisplay(undefined)).toBe("stepper");
            expect(sanitizeDisplay("stepper")).toBe("stepper");
            expect(sanitizeDisplay("anything")).toBe("stepper");
        });
    });

    // ── visLen ───────────────────────────────────────────────────────────────

    describe("visLen", () => {
        test("returns the visible character count of a plain string", () => {
            expect(visLen("hello")).toBe(5);
            expect(visLen("")).toBe(0);
            expect(visLen("abc")).toBe(3);
        });

        test("strips ANSI escape sequences before counting", () => {
            const bold = (s: string) => `\x1b[1m${s}\x1b[22m`;
            const dim  = (s: string) => `\x1b[2m${s}\x1b[22m`;
            expect(visLen(bold("hello"))).toBe(5);
            expect(visLen(dim("world"))).toBe(5);
            // colour codes
            expect(visLen("\x1b[38;2;196;167;224mtest\x1b[39m")).toBe(4);
        });

        test("counts ASCII characters as width 1", () => {
            expect(visLen("abcdefghijklmnopqrstuvwxyz")).toBe(26);
        });

        test("counts CJK characters as width 2", () => {
            expect(visLen("日本語")).toBe(6); // 3 CJK × 2
            expect(visLen("你好")).toBe(4);   // 2 CJK × 2
        });

        test("counts emoji as width 2", () => {
            expect(visLen("🎉")).toBe(2);
            expect(visLen("🔥🎯")).toBe(4);
        });

        test("handles mixed ASCII + CJK correctly", () => {
            expect(visLen("Hi 你好")).toBe(7); // 3 ASCII + 4 CJK
        });

        test("strips ANSI before wide-char measurement", () => {
            const styled = "\x1b[1m日本\x1b[22m";
            expect(visLen(styled)).toBe(4); // 2 CJK × 2
        });
    });

    // ── padTo ────────────────────────────────────────────────────────────────

    describe("padTo", () => {
        test("pads a short string to exactly BOX_W visible columns", () => {
            const result = padTo("hi");
            expect(visLen(result)).toBe(BOX_W);
        });

        test("does not truncate — adds 0 padding when content equals BOX_W", () => {
            const exact = "x".repeat(BOX_W);
            expect(padTo(exact)).toBe(exact);
            expect(visLen(padTo(exact))).toBe(BOX_W);
        });

        test("does not truncate content longer than BOX_W (caller must pre-wrap)", () => {
            const long = "x".repeat(BOX_W + 5);
            // padTo adds no extra spaces but does NOT truncate
            expect(padTo(long)).toBe(long);
            expect(visLen(padTo(long))).toBe(BOX_W + 5);
        });

        test("measures visible width correctly through ANSI escapes", () => {
            const styled = `\x1b[1mhello\x1b[22m`; // bold "hello" — visLen = 5
            const result = padTo(styled);
            expect(visLen(result)).toBe(BOX_W);
        });
    });

    // ── wrapText ─────────────────────────────────────────────────────────────

    describe("wrapText", () => {
        test("returns single-element array when text fits within maxWidth", () => {
            expect(wrapText("short", 20)).toEqual(["short"]);
        });

        test("wraps at word boundaries when text exceeds maxWidth", () => {
            const lines = wrapText("one two three four five", 10);
            for (const line of lines) {
                expect(visLen(line)).toBeLessThanOrEqual(10);
            }
            // All original words must be represented somewhere
            const joined = lines.join(" ");
            expect(joined).toContain("one");
            expect(joined).toContain("five");
        });

        test("preserves all words in wrapped output", () => {
            const text = "The quick brown fox jumps over the lazy dog";
            const lines = wrapText(text, 20);
            expect(lines.join(" ")).toBe(text);
        });

        test("hard-truncates a single token wider than maxWidth", () => {
            const longWord = "supercalifragilistic";
            const lines = wrapText(longWord, 10);
            // Must fit within maxWidth after truncation
            for (const line of lines) {
                expect(visLen(line)).toBeLessThanOrEqual(10);
            }
        });

        test("works correctly with CJK text (width-2 chars)", () => {
            // "ABCDE" in CJK fullwidth = 5 chars × 2 = 10 columns
            const cjk = "日本語テスト"; // 6 chars × 2 = 12 columns
            const lines = wrapText(cjk, 10);
            // Since it's a single token > maxWidth, should be truncated
            expect(visLen(lines[0])).toBeLessThanOrEqual(10);
        });

        test("returns original text when maxWidth is 0", () => {
            const result = wrapText("hello", 0);
            expect(result).toEqual(["hello"]);
        });

        test("handles empty string", () => {
            expect(wrapText("", 20)).toEqual([""]);
        });

        test("wraps a question that exceeds BOX_W - 2 (the real use case)", () => {
            const longQ = "This is a very long question generated by an LLM that clearly exceeds the 56 character inner limit of the box";
            const maxQWidth = BOX_W - 2; // 2 for leading spaces
            const lines = wrapText(longQ, maxQWidth);
            expect(lines.length).toBeGreaterThan(1);
            for (const line of lines) {
                expect(visLen(line)).toBeLessThanOrEqual(maxQWidth);
            }
        });
    });

    // ── bRow ─────────────────────────────────────────────────────────────────

    describe("bRow", () => {
        test("wraps inner content with │ border characters", () => {
            const result = bRow("content");
            // Contains the border characters (ANSI-stripped)
            const stripped = result.replace(/\x1b\[[0-9;]*m/g, "");
            expect(stripped.startsWith("│")).toBe(true);
            expect(stripped.endsWith("│")).toBe(true);
            expect(stripped).toContain("content");
        });

        test("produces correct total visual width when inner is padTo()", () => {
            const inner = padTo("  hello");
            const row = bRow(inner);
            // Strip ANSI and measure: should be BOX_W + 2 borders
            const stripped = row.replace(/\x1b\[[0-9;]*m/g, "");
            expect(stripped.length).toBe(BOX_W + 2);
        });
    });

    // ── typeLabel ────────────────────────────────────────────────────────────

    describe("typeLabel", () => {
        test("returns [select one] for undefined / radio", () => {
            expect(typeLabel(undefined)).toBe("[select one]");
            expect(typeLabel("radio")).toBe("[select one]");
        });

        test("returns [select multiple] for checkbox", () => {
            expect(typeLabel("checkbox")).toBe("[select multiple]");
        });

        test("returns [rank in order] for ranked", () => {
            expect(typeLabel("ranked")).toBe("[rank in order]");
        });
    });

    // ── buildBox ─────────────────────────────────────────────────────────────

    describe("buildBox", () => {
        const simpleQ = { question: "Pick a color", options: ["red", "blue", "green"] };

        test("produces output containing the question text", () => {
            const box = buildBox(simpleQ, 0, 1);
            const stripped = box.replace(/\x1b\[[0-9;]*m/g, "");
            expect(stripped).toContain("Pick a color");
        });

        test("produces output containing each option", () => {
            const box = buildBox(simpleQ, 0, 1);
            const stripped = box.replace(/\x1b\[[0-9;]*m/g, "");
            expect(stripped).toContain("red");
            expect(stripped).toContain("blue");
            expect(stripped).toContain("green");
        });

        test("includes step counter for multi-question batches", () => {
            const box = buildBox(simpleQ, 1, 3);
            const stripped = box.replace(/\x1b\[[0-9;]*m/g, "");
            expect(stripped).toContain("Q2 of 3");
        });

        test("omits step counter for single-question batches", () => {
            const box = buildBox(simpleQ, 0, 1);
            const stripped = box.replace(/\x1b\[[0-9;]*m/g, "");
            expect(stripped).not.toContain("Q1 of 1");
        });

        test("all interior rows fit within BOX_W + 2 border chars", () => {
            const box = buildBox(simpleQ, 0, 1);
            for (const line of box.split("\n")) {
                const stripped = line.replace(/\x1b\[[0-9;]*m/g, "");
                // Border rows: ╭...╮  or ╰...╯ are BOX_W + 2 wide
                // Content rows │...│ are also BOX_W + 2 wide
                expect(stripped.length).toBeLessThanOrEqual(BOX_W + 2);
            }
        });

        test("wraps a long question so no interior line exceeds BOX_W", () => {
            const longQ = {
                question: "This is an extremely long question that would definitely overflow the 58-char box without wrapping applied",
                options: ["yes", "no"],
            };
            const box = buildBox(longQ, 0, 1);
            for (const line of box.split("\n")) {
                const stripped = line.replace(/\x1b\[[0-9;]*m/g, "");
                expect(stripped.length).toBeLessThanOrEqual(BOX_W + 2);
            }
        });

        test("wraps a long option so no interior line exceeds BOX_W", () => {
            const q = {
                question: "Pick one",
                options: ["This option has an extremely long description that would overflow the box without word-wrapping being applied"],
            };
            const box = buildBox(q, 0, 1);
            for (const line of box.split("\n")) {
                const stripped = line.replace(/\x1b\[[0-9;]*m/g, "");
                expect(stripped.length).toBeLessThanOrEqual(BOX_W + 2);
            }
        });

        test("handles CJK options without overflowing box", () => {
            const q = {
                question: "選んでください",   // "Please choose" in Japanese
                options: ["日本語オプション一", "中文选项二"],
            };
            const box = buildBox(q, 0, 1);
            for (const line of box.split("\n")) {
                const stripped = line.replace(/\x1b\[[0-9;]*m/g, "");
                expect(stripped.length).toBeLessThanOrEqual(BOX_W + 2);
            }
        });
    });
});
