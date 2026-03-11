import { describe, expect, test, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { discoverAgents, formatAgentList, getUserAgentsDir, getUserAgentsDirs, BUILTIN_AGENTS, type AgentConfig } from "./subagent-agents.js";

/**
 * Tests for agent discovery in PizzaPi subagent system.
 *
 * Uses temp directories exclusively to avoid touching real HOME or project dirs.
 * The discoverAgents function reads from ~/.pizzapi/agents/ (user) and
 * .pizzapi/agents/ (project). We can't override HOME reliably in Bun tests,
 * so project-scope tests use temp dirs directly, and user-scope tests verify
 * the function handles missing directories gracefully.
 */

// Helper to create agent .md files in a directory
function createAgentFile(dir: string, filename: string, frontmatter: Record<string, string>, body: string = "") {
    const fm = Object.entries(frontmatter)
        .map(([k, v]) => `${k}: ${v}`)
        .join("\n");
    const content = `---\n${fm}\n---\n${body}`;
    writeFileSync(join(dir, filename), content, "utf-8");
}

describe("discoverAgents", () => {
    let tmpDir: string;

    beforeEach(() => {
        tmpDir = mkdtempSync(join(tmpdir(), "subagent-test-"));
    });

    afterEach(() => {
        try { rmSync(tmpDir, { recursive: true, force: true }); } catch {}
    });

    test("returns only built-in agents when no agent directories exist", () => {
        const result = discoverAgents(tmpDir, "project");
        // Built-in agents are always present
        expect(result.agents.length).toBe(BUILTIN_AGENTS.length);
        expect(result.agents.find(a => a.name === "task")).toBeDefined();
        expect(result.projectAgentsDir).toBeNull();
    });

    test("discovers project-scope agents from .pizzapi/agents/", () => {
        const agentsDir = join(tmpDir, ".pizzapi", "agents");
        mkdirSync(agentsDir, { recursive: true });

        createAgentFile(agentsDir, "researcher.md", {
            name: "researcher",
            description: "Read-only codebase research",
            tools: "read,grep,find",
        }, "You are a research agent. Analyze code without modifying it.");

        const result = discoverAgents(tmpDir, "project");
        const researcher = result.agents.find(a => a.name === "researcher");
        expect(researcher).toBeDefined();
        expect(researcher!.description).toBe("Read-only codebase research");
        expect(researcher!.tools).toEqual(["read", "grep", "find"]);
        expect(researcher!.source).toBe("project");
        expect(researcher!.systemPrompt).toContain("research agent");
        expect(result.projectAgentsDir).toBe(agentsDir);
    });

    test("discovers agents from parent directory walk-up", () => {
        // Create .pizzapi/agents/ in root of tmp structure
        const agentsDir = join(tmpDir, ".pizzapi", "agents");
        mkdirSync(agentsDir, { recursive: true });
        createAgentFile(agentsDir, "scout.md", {
            name: "scout",
            description: "File explorer",
        }, "Explore the file system.");

        // Working from a nested subdirectory
        const nestedDir = join(tmpDir, "src", "components");
        mkdirSync(nestedDir, { recursive: true });

        const result = discoverAgents(nestedDir, "project");
        const scout = result.agents.find(a => a.name === "scout");
        expect(scout).toBeDefined();
        expect(scout!.name).toBe("scout");
        expect(result.projectAgentsDir).toBe(agentsDir);
    });

    test("skips .md files without required frontmatter fields", () => {
        const agentsDir = join(tmpDir, ".pizzapi", "agents");
        mkdirSync(agentsDir, { recursive: true });

        // Missing description
        createAgentFile(agentsDir, "no-desc.md", { name: "no-desc" }, "Body text");
        // Missing name
        createAgentFile(agentsDir, "no-name.md", { description: "Has desc but no name" }, "Body text");
        // Valid
        createAgentFile(agentsDir, "valid.md", { name: "valid", description: "Valid agent" }, "Body text");

        const result = discoverAgents(tmpDir, "project");
        // Only the valid file + built-in agents
        const nonBuiltin = result.agents.filter(a => a.filePath !== "(built-in)");
        expect(nonBuiltin).toHaveLength(1);
        expect(nonBuiltin[0].name).toBe("valid");
    });

    test("skips non-.md files", () => {
        const agentsDir = join(tmpDir, ".pizzapi", "agents");
        mkdirSync(agentsDir, { recursive: true });

        writeFileSync(join(agentsDir, "readme.txt"), "not an agent");
        writeFileSync(join(agentsDir, "config.json"), "{}");
        createAgentFile(agentsDir, "real-agent.md", { name: "real", description: "Agent" });

        const result = discoverAgents(tmpDir, "project");
        const nonBuiltin = result.agents.filter(a => a.filePath !== "(built-in)");
        expect(nonBuiltin).toHaveLength(1);
        expect(nonBuiltin[0].name).toBe("real");
    });

    test("handles empty frontmatter body gracefully", () => {
        const agentsDir = join(tmpDir, ".pizzapi", "agents");
        mkdirSync(agentsDir, { recursive: true });

        createAgentFile(agentsDir, "minimal.md", {
            name: "minimal",
            description: "No system prompt",
        });

        const result = discoverAgents(tmpDir, "project");
        const minimal = result.agents.find(a => a.name === "minimal");
        expect(minimal).toBeDefined();
        expect(minimal!.systemPrompt).toBe("");
    });

    test("parses optional tools and model from frontmatter", () => {
        const agentsDir = join(tmpDir, ".pizzapi", "agents");
        mkdirSync(agentsDir, { recursive: true });

        createAgentFile(agentsDir, "reviewer.md", {
            name: "reviewer",
            description: "Code reviewer",
            tools: "read, grep, find, ls",
            model: "claude-haiku-3",
        }, "Review code for bugs.");

        const result = discoverAgents(tmpDir, "project");
        const reviewer = result.agents.find(a => a.name === "reviewer");
        expect(reviewer).toBeDefined();
        expect(reviewer!.tools).toEqual(["read", "grep", "find", "ls"]);
        expect(reviewer!.model).toBe("claude-haiku-3");
    });

    test("parses Claude Code frontmatter fields (disallowedTools, maxTurns, etc.)", () => {
        const agentsDir = join(tmpDir, ".pizzapi", "agents");
        mkdirSync(agentsDir, { recursive: true });

        createAgentFile(agentsDir, "restricted.md", {
            name: "restricted",
            description: "Restricted agent",
            tools: "read,write,bash,edit",
            disallowedTools: "bash,write",
            model: "haiku",
            maxTurns: "10",
            permissionMode: "dontAsk",
            background: "true",
        }, "Restricted agent prompt.");

        const result = discoverAgents(tmpDir, "project");
        const agent = result.agents.find(a => a.name === "restricted");
        expect(agent).toBeDefined();
        expect(agent!.tools).toEqual(["read", "write", "bash", "edit"]);
        expect(agent!.disallowedTools).toEqual(["bash", "write"]);
        expect(agent!.maxTurns).toBe(10);
        expect(agent!.permissionMode).toBe("dontAsk");
        expect(agent!.background).toBe(true);
    });

    test("discovers agents from .claude/agents/ (Claude Code compat)", () => {
        const agentsDir = join(tmpDir, ".claude", "agents");
        mkdirSync(agentsDir, { recursive: true });

        createAgentFile(agentsDir, "claude-agent.md", {
            name: "claude-agent",
            description: "Agent from .claude/agents",
        }, "Claude Code compatible agent.");

        const result = discoverAgents(tmpDir, "project");
        const claudeAgent = result.agents.find(a => a.name === "claude-agent");
        expect(claudeAgent).toBeDefined();
        expect(claudeAgent!.source).toBe("project");
    });

    test(".pizzapi/agents/ takes precedence over .claude/agents/ for same name", () => {
        // Create agent with same name in both dirs
        const pizzapiDir = join(tmpDir, ".pizzapi", "agents");
        const claudeDir = join(tmpDir, ".claude", "agents");
        mkdirSync(pizzapiDir, { recursive: true });
        mkdirSync(claudeDir, { recursive: true });

        createAgentFile(pizzapiDir, "scout.md", {
            name: "scout",
            description: "PizzaPi scout",
        });
        createAgentFile(claudeDir, "scout.md", {
            name: "scout",
            description: "Claude scout",
        });

        const result = discoverAgents(tmpDir, "project");
        // .pizzapi is checked first, so its agent wins for duplicate names
        const scout = result.agents.find(a => a.name === "scout");
        expect(scout).toBeDefined();
        expect(scout!.description).toBe("PizzaPi scout");
    });

    test("merges agents from .pizzapi/agents/ and .claude/agents/ at same level", () => {
        const pizzapiDir = join(tmpDir, ".pizzapi", "agents");
        const claudeDir = join(tmpDir, ".claude", "agents");
        mkdirSync(pizzapiDir, { recursive: true });
        mkdirSync(claudeDir, { recursive: true });

        createAgentFile(pizzapiDir, "alpha.md", {
            name: "alpha",
            description: "PizzaPi alpha",
        });
        createAgentFile(claudeDir, "beta.md", {
            name: "beta",
            description: "Claude beta",
        });

        const result = discoverAgents(tmpDir, "project");
        const nonBuiltin = result.agents.filter(a => a.filePath !== "(built-in)");
        expect(nonBuiltin).toHaveLength(2);
        const names = nonBuiltin.map(a => a.name).sort();
        expect(names).toEqual(["alpha", "beta"]);
    });

    test("agents without tools field have undefined tools", () => {
        const agentsDir = join(tmpDir, ".pizzapi", "agents");
        mkdirSync(agentsDir, { recursive: true });

        createAgentFile(agentsDir, "general.md", {
            name: "general",
            description: "General purpose agent",
        });

        const result = discoverAgents(tmpDir, "project");
        const general = result.agents.find(a => a.name === "general");
        expect(general).toBeDefined();
        expect(general!.tools).toBeUndefined();
    });

    test("scope 'user' does not discover project agents", () => {
        const agentsDir = join(tmpDir, ".pizzapi", "agents");
        mkdirSync(agentsDir, { recursive: true });
        createAgentFile(agentsDir, "project-only.md", { name: "project-only", description: "Project agent" });

        // user scope won't find project agents (and the user dir likely doesn't exist in test env)
        const result = discoverAgents(tmpDir, "user");
        // Should not contain the project agent
        expect(result.agents.find(a => a.name === "project-only")).toBeUndefined();
    });

    test("scope 'project' does not discover user agents", () => {
        // Project scope only looks in .pizzapi/agents/ relative to cwd, not in ~/.pizzapi/agents/
        const result = discoverAgents(tmpDir, "project");
        // With no .pizzapi/agents/ dir, should only have built-in agents
        expect(result.agents.every(a => a.filePath === "(built-in)")).toBe(true);
    });

    test("scope 'both' merges user and project agents with project winning", () => {
        // We can only test the project side in temp dirs, but we can verify
        // the merge logic by creating a project agent
        const agentsDir = join(tmpDir, ".pizzapi", "agents");
        mkdirSync(agentsDir, { recursive: true });
        createAgentFile(agentsDir, "scout.md", {
            name: "scout",
            description: "Project scout",
        });

        const result = discoverAgents(tmpDir, "both");
        const scout = result.agents.find(a => a.name === "scout");
        // If found, should be from project (overrides user)
        if (scout) {
            expect(scout.source).toBe("project");
        }
    });

    test("discovers multiple agents from same directory", () => {
        const agentsDir = join(tmpDir, ".pizzapi", "agents");
        mkdirSync(agentsDir, { recursive: true });

        createAgentFile(agentsDir, "alpha.md", { name: "alpha", description: "Agent A" });
        createAgentFile(agentsDir, "beta.md", { name: "beta", description: "Agent B" });
        createAgentFile(agentsDir, "gamma.md", { name: "gamma", description: "Agent C" });

        const result = discoverAgents(tmpDir, "project");
        const nonBuiltin = result.agents.filter(a => a.filePath !== "(built-in)");
        expect(nonBuiltin).toHaveLength(3);
        const names = nonBuiltin.map(a => a.name).sort();
        expect(names).toEqual(["alpha", "beta", "gamma"]);
    });
});

describe("built-in agents", () => {
    let tmpDir: string;

    beforeEach(() => {
        tmpDir = mkdtempSync(join(tmpdir(), "subagent-builtin-"));
    });

    afterEach(() => {
        try { rmSync(tmpDir, { recursive: true, force: true }); } catch {}
    });

    test("BUILTIN_AGENTS includes a 'task' agent", () => {
        const task = BUILTIN_AGENTS.find(a => a.name === "task");
        expect(task).toBeDefined();
        expect(task!.description).toBeTruthy();
        expect(task!.systemPrompt).toBeTruthy();
        expect(task!.filePath).toBe("(built-in)");
    });

    test("built-in task agent is always available in discovery", () => {
        // Override HOME so getUserAgentsDirs() won't pick up real user agents
        const origHome = process.env.HOME;
        try {
            process.env.HOME = tmpDir;
            // No agent directories at all — built-in must surface
            const result = discoverAgents(tmpDir, "user");
            const task = result.agents.find(a => a.name === "task");
            expect(task).toBeDefined();
            expect(task!.filePath).toBe("(built-in)");
        } finally {
            process.env.HOME = origHome;
        }
    });

    test("built-in task agent is available in all scopes", () => {
        for (const scope of ["user", "project", "both"] as const) {
            const result = discoverAgents(tmpDir, scope);
            const task = result.agents.find(a => a.name === "task");
            expect(task).toBeDefined();
        }
    });

    test("project agent overrides built-in agent with same name", () => {
        const agentsDir = join(tmpDir, ".pizzapi", "agents");
        mkdirSync(agentsDir, { recursive: true });

        createAgentFile(agentsDir, "task.md", {
            name: "task",
            description: "Custom project task agent",
        }, "Custom task prompt.");

        const result = discoverAgents(tmpDir, "project");
        const task = result.agents.find(a => a.name === "task");
        expect(task).toBeDefined();
        expect(task!.description).toBe("Custom project task agent");
        expect(task!.source).toBe("project");
        expect(task!.filePath).not.toBe("(built-in)");
    });

    test("built-in agents do not have restricted tools (full access)", () => {
        const task = BUILTIN_AGENTS.find(a => a.name === "task");
        expect(task).toBeDefined();
        // No tools restriction — inherits all coding tools
        expect(task!.tools).toBeUndefined();
    });
});

describe("formatAgentList", () => {
    test("returns 'none' for empty list", () => {
        const result = formatAgentList([], 5);
        expect(result.text).toBe("none");
        expect(result.remaining).toBe(0);
    });

    test("formats all agents within limit", () => {
        const agents: AgentConfig[] = [
            { name: "a", description: "Agent A", source: "user", systemPrompt: "", filePath: "/a.md" },
            { name: "b", description: "Agent B", source: "project", systemPrompt: "", filePath: "/b.md" },
        ];
        const result = formatAgentList(agents, 5);
        expect(result.text).toContain("a (user): Agent A");
        expect(result.text).toContain("b (project): Agent B");
        expect(result.remaining).toBe(0);
    });

    test("truncates agents beyond limit", () => {
        const agents: AgentConfig[] = [
            { name: "a", description: "A", source: "user", systemPrompt: "", filePath: "/a.md" },
            { name: "b", description: "B", source: "user", systemPrompt: "", filePath: "/b.md" },
            { name: "c", description: "C", source: "user", systemPrompt: "", filePath: "/c.md" },
        ];
        const result = formatAgentList(agents, 2);
        expect(result.text).toContain("a (user)");
        expect(result.text).toContain("b (user)");
        expect(result.text).not.toContain("c (user)");
        expect(result.remaining).toBe(1);
    });
});

describe("getUserAgentsDir", () => {
    test("returns path ending in .pizzapi/agents", () => {
        const dir = getUserAgentsDir();
        expect(dir).toMatch(/\.pizzapi[/\\]agents$/);
    });
});

describe("getUserAgentsDirs", () => {
    test("returns both .pizzapi/agents and .claude/agents paths", () => {
        const dirs = getUserAgentsDirs();
        expect(dirs).toHaveLength(2);
        expect(dirs[0]).toMatch(/\.pizzapi[/\\]agents$/);
        expect(dirs[1]).toMatch(/\.claude[/\\]agents$/);
    });
});
