import { describe, expect, test } from "bun:test";
import { createToolkit } from "./toolkit";

describe("createToolkit", () => {
    test("returns all tools by default", () => {
        const tools = createToolkit();
        const names = tools.map((t) => t.name);
        expect(names).toEqual(["bash", "read_file", "write_file", "search"]);
    });

    test("filters with include option", () => {
        const tools = createToolkit({ include: ["bash", "search"] });
        const names = tools.map((t) => t.name);
        expect(names).toEqual(["bash", "search"]);
    });

    test("filters with exclude option", () => {
        const tools = createToolkit({ exclude: ["bash"] });
        const names = tools.map((t) => t.name);
        expect(names).toEqual(["read_file", "write_file", "search"]);
    });

    test("include takes precedence over exclude", () => {
        // When both are provided, include is checked first
        const tools = createToolkit({ include: ["bash"], exclude: ["bash"] });
        const names = tools.map((t) => t.name);
        expect(names).toEqual(["bash"]);
    });

    test("returns empty array when include matches nothing", () => {
        const tools = createToolkit({ include: ["nonexistent"] });
        expect(tools).toEqual([]);
    });

    test("returns all tools when exclude matches nothing", () => {
        const tools = createToolkit({ exclude: ["nonexistent"] });
        expect(tools).toHaveLength(4);
    });

    test("each tool has required properties", () => {
        const tools = createToolkit();
        for (const tool of tools) {
            expect(tool.name).toBeTruthy();
            expect(tool.label).toBeTruthy();
            expect(tool.description).toBeTruthy();
            expect(typeof tool.execute).toBe("function");
            expect(tool.parameters).toBeDefined();
        }
    });
});
