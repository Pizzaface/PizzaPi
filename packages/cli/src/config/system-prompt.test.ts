import { describe, test, expect } from "bun:test";
import { buildSystemPrompt, BUILTIN_SYSTEM_PROMPT } from "./system-prompt.js";

describe("buildSystemPrompt", () => {
    test("returns a non-empty string", () => {
        const result = buildSystemPrompt();
        expect(typeof result).toBe("string");
        expect(result.length).toBeGreaterThan(0);
    });

    test("interpolates todaysDate into the output", () => {
        const result = buildSystemPrompt({ todaysDate: "January 1, 2030" });
        expect(result).toContain("January 1, 2030");
    });

    test("uses current date when todaysDate is not provided", () => {
        const result = buildSystemPrompt();
        const now = new Date();
        const year = now.getFullYear().toString();
        expect(result).toContain(year);
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
        // Should contain the partial content, not a {{> partial}} reference
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
        // The compat export evaluates once at import time, so it should
        // contain the same sections as a fresh call
        expect(BUILTIN_SYSTEM_PROMPT).toContain('section name="spawning-sessions"');
        expect(BUILTIN_SYSTEM_PROMPT).toContain('section name="sandbox"');
    });
});
