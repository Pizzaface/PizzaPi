import { describe, expect, test } from "bun:test";
import { parseJsonArray } from "./utils";

describe("parseJsonArray", () => {
    test("parses valid JSON array", () => {
        expect(parseJsonArray('[1, 2, 3]')).toEqual([1, 2, 3]);
    });

    test("parses array of strings", () => {
        expect(parseJsonArray('["a", "b"]')).toEqual(["a", "b"]);
    });

    test("parses nested arrays", () => {
        expect(parseJsonArray('[[1], [2, 3]]')).toEqual([[1], [2, 3]]);
    });

    test("parses array of objects", () => {
        expect(parseJsonArray('[{"a": 1}]')).toEqual([{ a: 1 }]);
    });

    test("returns empty array for null", () => {
        expect(parseJsonArray(null)).toEqual([]);
    });

    test("returns empty array for undefined", () => {
        expect(parseJsonArray(undefined)).toEqual([]);
    });

    test("returns empty array for empty string", () => {
        expect(parseJsonArray("")).toEqual([]);
    });

    test("returns empty array for non-array JSON (object)", () => {
        expect(parseJsonArray('{"key": "value"}')).toEqual([]);
    });

    test("returns empty array for non-array JSON (string)", () => {
        expect(parseJsonArray('"hello"')).toEqual([]);
    });

    test("returns empty array for non-array JSON (number)", () => {
        expect(parseJsonArray("42")).toEqual([]);
    });

    test("returns empty array for non-array JSON (boolean)", () => {
        expect(parseJsonArray("true")).toEqual([]);
    });

    test("returns empty array for invalid JSON", () => {
        expect(parseJsonArray("not json")).toEqual([]);
        expect(parseJsonArray("{broken")).toEqual([]);
        expect(parseJsonArray("[1, 2,")).toEqual([]);
    });

    test("handles empty array", () => {
        expect(parseJsonArray("[]")).toEqual([]);
    });
});
