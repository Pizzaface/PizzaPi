import { describe, test, expect } from "bun:test";
import { sanitizeQuestions, sanitizeDisplay } from "./remote-ask-user.js";

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
});
