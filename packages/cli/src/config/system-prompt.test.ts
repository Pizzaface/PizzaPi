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

    test("contains all major sections as pseudo-XML when isRunner is true", () => {
        const result = buildSystemPrompt({ isRunner: true });
        const sections = [
            'section name="spawning-sessions"',
            'section name="subagent-tool"',
            'section name="plan-mode"',
            'section name="toggle-plan-mode"',
            'section name="asking-questions"',
            'section name="tunnels"',
            'section name="service-triggers"',
            'section name="sigil-discovery"',
            'section name="sandbox"',
            'section name="pizzapi-configuration"',
        ];
        for (const section of sections) {
            expect(result).toContain(section);
        }
    });

    test("omits runner-only sections when isRunner is false/omitted", () => {
        const result = buildSystemPrompt();
        const runnerOnlySections = [
            'section name="spawning-sessions"',
            'section name="tunnels"',
            'section name="service-triggers"',
            'section name="sigil-discovery"',
        ];
        for (const section of runnerOnlySections) {
            expect(result).not.toContain(section);
        }
        // Non-runner sections should still be present
        expect(result).toContain('section name="subagent-tool"');
        expect(result).toContain('section name="plan-mode"');
        expect(result).toContain('section name="sandbox"');
    });

    test("contains AskUserQuestion type descriptions", () => {
        const result = buildSystemPrompt();
        expect(result).toContain('"radio"');
        expect(result).toContain('"checkbox"');
        expect(result).toContain('"ranked"');
    });

    test("contains key tool names when isRunner is true", () => {
        const result = buildSystemPrompt({ isRunner: true });
        expect(result).toContain("spawn_session");
        expect(result).toContain("subagent");
        expect(result).toContain("plan_mode");
        expect(result).toContain("toggle_plan_mode");
        expect(result).toContain("AskUserQuestion");
        expect(result).toContain("create_tunnel");
        expect(result).toContain("subscribe_trigger");
        expect(result).toContain("list_available_sigils");
    });

    test("contains sigil-discovery instruction to call after set_session_name", () => {
        const result = buildSystemPrompt({ isRunner: true });
        expect(result).toContain("set_session_name");
        expect(result).toContain("list_available_sigils");
        expect(result).toContain('section name="sigil-discovery"');
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

    test("matches buildSystemPrompt() output structure (non-runner default)", () => {
        // Default export is non-runner, so runner-only sections are absent
        expect(BUILTIN_SYSTEM_PROMPT).not.toContain('section name="spawning-sessions"');
        expect(BUILTIN_SYSTEM_PROMPT).toContain('section name="sandbox"');
    });
});
