import { describe, expect, test } from "bun:test";
import { parseCsv } from "./csv";

describe("parseCsv", () => {
    test("parses a header and body rows", () => {
        const { header, rows, truncated } = parseCsv("supplier,q2,q3\nNorthwind,102400,94100\nAcme,5,6\n");
        expect(header).toEqual(["supplier", "q2", "q3"]);
        expect(rows).toEqual([["Northwind", "102400", "94100"], ["Acme", "5", "6"]]);
        expect(truncated).toBe(false);
    });

    test("keeps delimiters that live inside quoted fields", () => {
        const { rows } = parseCsv('name,note\n"Smith, John",ok\n');
        expect(rows[0]).toEqual(["Smith, John", "ok"]);
    });

    test("unescapes doubled quotes", () => {
        const { rows } = parseCsv('name,note\n"She said ""hi""",fine\n');
        expect(rows[0]).toEqual(['She said "hi"', "fine"]);
    });

    test("handles CRLF line endings", () => {
        const { header, rows } = parseCsv("a,b\r\n1,2\r\n");
        expect(header).toEqual(["a", "b"]);
        expect(rows).toEqual([["1", "2"]]);
    });

    test("handles a final row without a trailing newline", () => {
        const { rows } = parseCsv("a,b\n1,2");
        expect(rows).toEqual([["1", "2"]]);
    });

    test("detects tab-separated input", () => {
        const { header, rows } = parseCsv("a\tb\n1\t2\n");
        expect(header).toEqual(["a", "b"]);
        expect(rows).toEqual([["1", "2"]]);
    });

    test("a comma-bearing first line stays comma-delimited", () => {
        const { header } = parseCsv("a,b\tc\n1,2\n");
        expect(header).toEqual(["a", "b\tc"]);
    });

    test("caps rows and reports truncation", () => {
        const body = Array.from({ length: 10 }, (_, i) => `${i},x`).join("\n");
        const { rows, truncated } = parseCsv(`a,b\n${body}\n`, 4);
        expect(rows.length).toBe(4);
        expect(truncated).toBe(true);
    });

    test("empty input yields no header", () => {
        expect(parseCsv("")).toEqual({ header: null, rows: [], truncated: false });
    });

    test("header-only input yields no body rows", () => {
        const { header, rows } = parseCsv("a,b\n");
        expect(header).toEqual(["a", "b"]);
        expect(rows).toEqual([]);
    });

    test("preserves empty trailing fields", () => {
        const { rows } = parseCsv("a,b,c\n1,,3\n");
        expect(rows[0]).toEqual(["1", "", "3"]);
    });
});
