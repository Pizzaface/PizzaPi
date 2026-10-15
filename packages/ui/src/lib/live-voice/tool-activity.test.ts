import { describe, expect, test } from "bun:test";
import { describeActiveTools } from "./tool-activity";

describe("describeActiveTools", () => {
    test("turns active tools into brief status without arguments", () => {
        expect(describeActiveTools(["bash", "mcp__fs__read", "bash"])).toBe("Running a command · Reading a file");
    });

    test("limits long parallel tool lists", () => {
        expect(describeActiveTools(["web_search", "write", "grep"])).toBe("Searching the web · Writing a file · +1 more");
    });

    test("returns null when no tools are active", () => {
        expect(describeActiveTools([])).toBeNull();
    });
});
