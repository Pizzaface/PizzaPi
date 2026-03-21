import { describe, test, expect } from "bun:test";
import { extractHookSummary } from "./hook-summary.js";
import type { HooksConfig } from "../config.js";

describe("extractHookSummary", () => {
    test("returns empty array for undefined hooks", () => {
        expect(extractHookSummary(undefined)).toEqual([]);
    });

    test("returns empty array for empty hooks config", () => {
        expect(extractHookSummary({})).toEqual([]);
    });

    test("extracts PreToolUse scripts from matcher entries", () => {
        const hooks: HooksConfig = {
            PreToolUse: [
                {
                    matcher: "Bash",
                    hooks: [{ command: "/home/user/.pizzapi/hooks/rtk-rewrite.sh" }],
                },
            ],
        };
        const result = extractHookSummary(hooks);
        expect(result).toHaveLength(1);
        expect(result[0].type).toBe("PreToolUse");
        expect(result[0].scripts).toContain("rtk-rewrite.sh");
    });

    test("extracts PostToolUse scripts from multiple matchers", () => {
        const hooks: HooksConfig = {
            PostToolUse: [
                {
                    matcher: "Bash",
                    hooks: [
                        { command: "/path/to/audit.sh" },
                        { command: "/path/to/log.sh extra-arg" },
                    ],
                },
                {
                    matcher: "Edit|Write",
                    hooks: [{ command: "notify-send.sh" }],
                },
            ],
        };
        const result = extractHookSummary(hooks);
        expect(result).toHaveLength(1);
        expect(result[0].type).toBe("PostToolUse");
        expect(result[0].scripts).toEqual(["audit.sh", "log.sh", "notify-send.sh"]);
    });

    test("extracts entry-based Input hook scripts", () => {
        const hooks: HooksConfig = {
            Input: [
                { command: "/usr/local/bin/input-filter.sh" },
            ],
        };
        const result = extractHookSummary(hooks);
        expect(result).toHaveLength(1);
        expect(result[0].type).toBe("Input");
        expect(result[0].scripts).toContain("input-filter.sh");
    });

    test("handles multiple hook types simultaneously", () => {
        const hooks: HooksConfig = {
            PreToolUse: [{ matcher: ".*", hooks: [{ command: "/hooks/pre.sh" }] }],
            PostToolUse: [{ matcher: ".*", hooks: [{ command: "/hooks/post.sh" }] }],
            Input: [{ command: "/hooks/input.sh" }],
            SessionShutdown: [{ command: "/hooks/shutdown.sh" }],
        };
        const result = extractHookSummary(hooks);
        const types = result.map((r) => r.type);
        expect(types).toContain("PreToolUse");
        expect(types).toContain("PostToolUse");
        expect(types).toContain("Input");
        expect(types).toContain("SessionShutdown");
    });

    test("skips hook types with no entries", () => {
        const hooks: HooksConfig = {
            PreToolUse: [], // empty matcher array
            Input: [{ command: "/hooks/input.sh" }],
        };
        const result = extractHookSummary(hooks);
        expect(result).toHaveLength(1);
        expect(result[0].type).toBe("Input");
    });

    test("uses basename of command path", () => {
        const hooks: HooksConfig = {
            ModelSelect: [{ command: "/very/deeply/nested/directory/track-model.sh" }],
        };
        const result = extractHookSummary(hooks);
        expect(result[0].scripts[0]).toBe("track-model.sh");
    });

    test("handles command with arguments — only basenames the first token", () => {
        const hooks: HooksConfig = {
            BeforeAgentStart: [{ command: "/path/to/inject-context.sh --verbose --output /tmp/log" }],
        };
        const result = extractHookSummary(hooks);
        expect(result[0].scripts[0]).toBe("inject-context.sh");
    });

    test("handles PreToolUse matchers with multiple hooks per matcher", () => {
        const hooks: HooksConfig = {
            PreToolUse: [
                {
                    matcher: "Bash",
                    hooks: [
                        { command: "/hooks/hook-a.sh" },
                        { command: "/hooks/hook-b.sh" },
                    ],
                },
            ],
        };
        const result = extractHookSummary(hooks);
        expect(result[0].scripts).toEqual(["hook-a.sh", "hook-b.sh"]);
    });
});
