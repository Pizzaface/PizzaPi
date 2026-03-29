import { describe, test, expect } from "bun:test";
import { buildSystemPrompt, BUILTIN_SYSTEM_PROMPT } from "./system-prompt.js";

describe("buildSystemPrompt", () => {
    test("returns a non-empty string", () => {
        const result = buildSystemPrompt();
        expect(typeof result).toBe("string");
        expect(result.length).toBeGreaterThan(0);
    });

    test("interpolates dateTime into the output", () => {
        const result = buildSystemPrompt({ dateTime: "January 1, 2030, 12:00 PM" });
        expect(result).toContain("January 1, 2030, 12:00 PM");
    });

    test("uses current date/time when dateTime is not provided", () => {
        const result = buildSystemPrompt();
        const year = new Date().getFullYear().toString();
        expect(result).toContain(year);
    });

    test("includes gitBranch when provided", () => {
        const result = buildSystemPrompt({ dateTime: "test", gitBranch: "feat/my-feature" });
        expect(result).toContain("Git branch: feat/my-feature");
    });

    test("includes gitWorktree when provided", () => {
        const result = buildSystemPrompt({ dateTime: "test", gitWorktree: "/path/to/worktree" });
        expect(result).toContain("Git worktree: /path/to/worktree");
    });

    test("includes cwd when provided", () => {
        const result = buildSystemPrompt({ dateTime: "test", cwd: "/Users/dev/project" });
        expect(result).toContain("Working directory: /Users/dev/project");
    });

    test("omits gitBranch line when not provided or unavailable", () => {
        const result = buildSystemPrompt({ dateTime: "test" });
        // Should not have "Git branch:" with empty value
        expect(result).not.toContain("Git branch: \n");
    });

    test("auto-detects git branch from current repo", () => {
        // We're in a git repo, so branch should be detected
        const result = buildSystemPrompt();
        expect(result).toContain("Git branch:");
    });

    test("contains all major sections as pseudo-XML", () => {
        const result = buildSystemPrompt();
        const sections = [
            'section name="spawning-sessions"',
            'section name="subagent-tool"',
            'section name="plan-mode"',
            'section name="toggle-plan-mode"',
            'section name="asking-questions"',
            'section name="tunnels"',
            'section name="service-triggers"',
            'section name="sandbox"',
            'section name="pizzapi-configuration"',
        ];
        for (const section of sections) {
            expect(result).toContain(section);
        }
    });

    test("contains AskUserQuestion type descriptions", () => {
        const result = buildSystemPrompt();
        expect(result).toContain('"radio"');
        expect(result).toContain('"checkbox"');
        expect(result).toContain('"ranked"');
    });

    test("contains key tool names", () => {
        const result = buildSystemPrompt();
        expect(result).toContain("spawn_session");
        expect(result).toContain("subagent");
        expect(result).toContain("plan_mode");
        expect(result).toContain("toggle_plan_mode");
        expect(result).toContain("AskUserQuestion");
        expect(result).toContain("create_tunnel");
        expect(result).toContain("subscribe_trigger");
    });

    test("contains PizzaPi config paths", () => {
        const result = buildSystemPrompt();
        expect(result).toContain("~/.pizzapi/config.json");
        expect(result).toContain("~/.pizzapi/settings.json");
        expect(result).toContain(".pizzapi/config.json");
    });

    test("ask-user-question partial is inlined (not a separate invocation)", () => {
        const result = buildSystemPrompt();
        expect(result).toContain("AskUserQuestion");
        expect(result).not.toContain("{{>");
    });
});

describe("BUILTIN_SYSTEM_PROMPT (compat export)", () => {
    test("is a non-empty string", () => {
        expect(typeof BUILTIN_SYSTEM_PROMPT).toBe("string");
        expect(BUILTIN_SYSTEM_PROMPT.length).toBeGreaterThan(0);
    });

    test("matches buildSystemPrompt() output structure", () => {
        expect(BUILTIN_SYSTEM_PROMPT).toContain('section name="spawning-sessions"');
        expect(BUILTIN_SYSTEM_PROMPT).toContain('section name="sandbox"');
    });
});
