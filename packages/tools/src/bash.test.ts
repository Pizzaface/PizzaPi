import { describe, test, expect } from "bun:test";
import { bashTool } from "./bash.ts";

describe("bashTool", () => {
    test("has correct metadata", () => {
        expect(bashTool.name).toBe("bash");
        expect(bashTool.description).toBeTruthy();
    });

    test("executes a successful command", async () => {
        const result = await bashTool.execute("test-1", { command: "echo hello" });
        expect(result.content[0].text).toContain("hello");
    });

    test("executes a failing command and catches error", async () => {
        const result = await bashTool.execute("test-2", { command: "ls /nonexistent" });
        expect(result.content[0].text).toContain("No such file or directory");
    });
});
