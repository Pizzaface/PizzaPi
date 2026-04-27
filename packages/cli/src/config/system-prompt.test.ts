import { describe, test, expect } from "bun:test";
import { buildSystemPrompt, rewriteForClaudeCodeProvider, buildClaudeCodeProviderPrompt, BUILTIN_SYSTEM_PROMPT } from "./system-prompt.js";

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
        expect(result).toContain("unsubscribe_trigger({ subscriptionId })");
        expect(result).toContain("update_trigger_subscription({ subscriptionId, ... })");
        expect(result).toContain("list_available_sigils");
    });

    test("describes spawn_session as linked-only and does not teach message-bus opt-out", () => {
        const result = buildSystemPrompt({ isRunner: true });
        expect(result).toContain("Spawned sessions are automatically linked to you as children");
        expect(result).not.toContain("linked: false");
        expect(result).not.toContain("wait_for_message");
        expect(result).not.toContain("send_message");
    });

    test("describes id-based trigger CRUD for multi-subscription support", () => {
        const result = buildSystemPrompt({ isRunner: true });
        expect(result).toContain("subscriptionId");
        expect(result).toContain("Multiple subscriptions of the same trigger type can exist at once");
        expect(result).toContain("legacy bulk operations");
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

describe("rewriteForClaudeCodeProvider", () => {
    test("rewrites the upstream identity line", () => {
        const input = "You are an expert coding assistant operating inside pi, a coding agent harness.";
        const result = rewriteForClaudeCodeProvider(input);
        expect(result).toContain("You are Claude Code, Anthropic's official CLI for Claude.");
        expect(result).not.toContain("operating inside pi");
    });

    test("replaces PizzaPi with Claude Code", () => {
        const input = "Use PizzaPi relay to proxy. PizzaPi is great.";
        const result = rewriteForClaudeCodeProvider(input);
        expect(result).toBe("Use Claude Code relay to proxy. Claude Code is great.");
    });

    test("replaces ~/.pizzapi/ paths with ~/.claude/", () => {
        const input = "Config lives at ~/.pizzapi/config.json and ~/.pizzapi/settings.json";
        const result = rewriteForClaudeCodeProvider(input);
        expect(result).toContain("~/.claude/config.json");
        expect(result).toContain("~/.claude/settings.json");
        expect(result).not.toContain("~/.pizzapi/");
    });

    test("replaces .pizzapi/ project-local paths with .claude/", () => {
        const input = "Project hooks in .pizzapi/config.json and .pizzapi/agents/";
        const result = rewriteForClaudeCodeProvider(input);
        expect(result).toContain(".claude/config.json");
        expect(result).toContain(".claude/agents/");
        expect(result).not.toContain(".pizzapi/");
    });

    test("replaces standalone Pi followed by documentation keywords", () => {
        const input = "Pi documentation is at Pi TUI settings";
        const result = rewriteForClaudeCodeProvider(input);
        expect(result).toContain("Claude Code documentation");
        expect(result).toContain("Claude Code TUI");
    });

    test("replaces 'inside pi' references", () => {
        const input = "operating inside pi is fun";
        const result = rewriteForClaudeCodeProvider(input);
        expect(result).toContain("inside Claude Code");
    });

    test("replaces pizzapi-configuration section name", () => {
        const input = 'section name="pizzapi-configuration"';
        const result = rewriteForClaudeCodeProvider(input);
        expect(result).toContain('section name="claude-code-configuration"');
    });

    test("does not break normal words containing 'pi'", () => {
        const input = "scripts pipeline recipes compile spinner";
        const result = rewriteForClaudeCodeProvider(input);
        expect(result).toBe("scripts pipeline recipes compile spinner");
    });

    test("works on a full system prompt without throwing", () => {
        const fullPrompt = buildSystemPrompt({ isRunner: true, dateTime: "test" });
        const result = rewriteForClaudeCodeProvider(fullPrompt);
        expect(result).not.toContain("PizzaPi");
        expect(result).toContain("Claude Code");
        expect(result.length).toBeGreaterThan(0);
    });
});

describe("buildClaudeCodeProviderPrompt", () => {
    test("returns a non-empty string", () => {
        const result = buildClaudeCodeProviderPrompt();
        expect(typeof result).toBe("string");
        expect(result.length).toBeGreaterThan(0);
    });

    test("contains the Claude Code identity line", () => {
        const result = buildClaudeCodeProviderPrompt();
        expect(result).toContain("You are Claude Code, Anthropic's official CLI for Claude");
    });

    test("does NOT contain PizzaPi branding", () => {
        const result = buildClaudeCodeProviderPrompt();
        expect(result).not.toContain("PizzaPi");
        expect(result).not.toContain("pizzapi");
        expect(result).not.toContain("operating inside pi, a coding agent harness");
    });

    test("contains the env block with platform info", () => {
        const result = buildClaudeCodeProviderPrompt({ platform: "darwin", shell: "zsh", osVersion: "Darwin 23.1.0" });
        expect(result).toContain("<env>");
        expect(result).toContain("Platform: darwin");
        expect(result).toContain("Shell: zsh");
        expect(result).toContain("OS Version: Darwin 23.1.0");
        expect(result).toContain("</env>");
    });

    test("includes cwd in env block when provided", () => {
        const result = buildClaudeCodeProviderPrompt({ cwd: "/Users/dev/project", platform: "linux", shell: "bash", osVersion: "Linux 6.x" });
        expect(result).toContain("Working directory: /Users/dev/project");
    });

    test("shows git repo as Yes when gitBranch is provided", () => {
        const result = buildClaudeCodeProviderPrompt({ gitBranch: "main", platform: "linux", shell: "bash", osVersion: "Linux 6.x" });
        expect(result).toContain("Is directory a git repo: Yes");
    });

    test("shows git repo as No when not in a git directory", () => {
        // Use /tmp as cwd — not a git repo, so auto-detection returns no branch
        const result = buildClaudeCodeProviderPrompt({ cwd: "/tmp", platform: "linux", shell: "bash", osVersion: "Linux 6.x" });
        expect(result).toContain("Is directory a git repo: No");
    });

    test("contains Claude Code-specific sections", () => {
        const result = buildClaudeCodeProviderPrompt();
        expect(result).toContain("## Tone and style");
        expect(result).toContain("## Professional objectivity");
        expect(result).toContain("## No time estimates");
        expect(result).toContain("## Task Management");
        expect(result).toContain("## Doing tasks");
        expect(result).toContain("## Tool usage policy");
        expect(result).toContain("## Code References");
    });

    test("contains git commit and PR instructions", () => {
        const result = buildClaudeCodeProviderPrompt();
        expect(result).toContain("### Committing changes with git");
        expect(result).toContain("### Creating pull requests");
        expect(result).toContain("Co-Authored-By: Claude");
    });

    test("contains Claude background info", () => {
        const result = buildClaudeCodeProviderPrompt();
        expect(result).toContain("<claude_background_info>");
        expect(result).toContain("Claude Opus 4.6");
    });

    test("contains security policy", () => {
        const result = buildClaudeCodeProviderPrompt();
        expect(result).toContain("authorized security testing");
        expect(result).toContain("defensive security");
    });

    test("does NOT contain tool schema definitions", () => {
        // Tool schemas are injected separately by the agent SDK
        const result = buildClaudeCodeProviderPrompt();
        expect(result).not.toContain('"$schema": "https://json-schema.org');
        expect(result).not.toContain('"additionalProperties": false');
    });

    test("auto-detects platform and shell from environment", () => {
        // When no ctx is provided, it should auto-detect
        const result = buildClaudeCodeProviderPrompt();
        expect(result).toContain("Platform:");
        expect(result).toContain("Shell:");
        expect(result).toContain("OS Version:");
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
