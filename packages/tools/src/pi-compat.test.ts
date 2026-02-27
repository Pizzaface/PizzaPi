/**
 * Compatibility tests for pi-ai and pi-agent-core as used by @pizzapi/tools.
 *
 * Verifies that the Type schema builder and AgentTool interface remain
 * compatible after pi package version bumps.
 */
import { describe, test, expect } from "bun:test";
import { createToolkit } from "./toolkit.js";

// ---------------------------------------------------------------------------
// 1. Type schema builder (pi-ai)
// ---------------------------------------------------------------------------

describe("pi-ai Type schema compatibility", () => {
    test("Type.Object creates a valid schema", async () => {
        const { Type } = await import("@mariozechner/pi-ai");

        const schema = Type.Object({
            path: Type.String({ description: "File path" }),
            content: Type.String({ description: "File content" }),
        });

        expect(schema).toBeDefined();
        expect(schema.type).toBe("object");
        expect(schema.properties).toBeDefined();
        expect(schema.properties.path).toBeDefined();
        expect(schema.properties.content).toBeDefined();
    });

    test("Type.Optional wraps a type correctly", async () => {
        const { Type } = await import("@mariozechner/pi-ai");

        const schema = Type.Object({
            required: Type.String(),
            optional: Type.Optional(Type.String()),
        });

        expect(schema.required).toBeDefined();
        // Optional fields should not be in required array
        if (Array.isArray(schema.required)) {
            expect(schema.required).toContain("required");
            expect(schema.required).not.toContain("optional");
        }
    });

    test("Type.Boolean and Type.Number are available", async () => {
        const { Type } = await import("@mariozechner/pi-ai");

        expect(typeof Type.Boolean).toBe("function");
        expect(typeof Type.Number).toBe("function");

        const boolSchema = Type.Boolean();
        expect(boolSchema.type).toBe("boolean");

        const numSchema = Type.Number();
        expect(numSchema.type).toBe("number");
    });
});

// ---------------------------------------------------------------------------
// 2. AgentTool interface (pi-agent-core)
// ---------------------------------------------------------------------------

describe("pi-agent-core AgentTool compatibility", () => {
    test("tools created by createToolkit conform to AgentTool shape", () => {
        const tools = createToolkit();

        expect(tools.length).toBeGreaterThan(0);

        for (const tool of tools) {
            // Required AgentTool fields
            expect(typeof tool.name).toBe("string");
            expect(tool.name.length).toBeGreaterThan(0);

            expect(typeof tool.description).toBe("string");
            expect(tool.description.length).toBeGreaterThan(0);

            // parameters should be a JSON schema object
            expect(tool.parameters).toBeDefined();
            expect(tool.parameters.type).toBe("object");

            // execute must be a function
            expect(typeof tool.execute).toBe("function");
        }
    });

    test("toolkit includes expected core tools", () => {
        const tools = createToolkit();
        const names = tools.map((t) => t.name);

        expect(names).toContain("bash");
        expect(names).toContain("read_file");
        expect(names).toContain("write_file");
    });

    test("tool execute returns expected shape (text content)", async () => {
        const tools = createToolkit();
        const readFile = tools.find((t) => t.name === "read_file");

        expect(readFile).toBeDefined();

        // Execute with a known file
        const result = await readFile!.execute("test-call-id", {
            path: import.meta.dirname + "/pi-compat.test.ts",
        });

        // Result should be string or array of content blocks
        if (typeof result === "string") {
            expect(result.length).toBeGreaterThan(0);
        } else if (Array.isArray(result)) {
            expect(result.length).toBeGreaterThan(0);
            // Content blocks should have type and text
            for (const block of result) {
                if (typeof block === "object" && block !== null) {
                    expect(block.type).toBeDefined();
                }
            }
        }
    });
});
