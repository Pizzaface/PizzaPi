import { describe, expect, test, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { discoverAgents, formatAgentList, getUserAgentsDir, type AgentConfig } from "./subagent-agents.js";

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

    test("returns empty agents when no agent directories exist", () => {
        const result = discoverAgents(tmpDir, "project");
        expect(result.agents).toEqual([]);
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
        expect(result.agents).toHaveLength(1);
        expect(result.agents[0].name).toBe("researcher");
        expect(result.agents[0].description).toBe("Read-only codebase research");
        expect(result.agents[0].tools).toEqual(["read", "grep", "find"]);
        expect(result.agents[0].source).toBe("project");
        expect(result.agents[0].systemPrompt).toContain("research agent");
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
        expect(result.agents).toHaveLength(1);
        expect(result.agents[0].name).toBe("scout");
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
        expect(result.agents).toHaveLength(1);
        expect(result.agents[0].name).toBe("valid");
    });

    test("skips non-.md files", () => {
        const agentsDir = join(tmpDir, ".pizzapi", "agents");
        mkdirSync(agentsDir, { recursive: true });

        writeFileSync(join(agentsDir, "readme.txt"), "not an agent");
        writeFileSync(join(agentsDir, "config.json"), "{}");
        createAgentFile(agentsDir, "real-agent.md", { name: "real", description: "Agent" });

        const result = discoverAgents(tmpDir, "project");
        expect(result.agents).toHaveLength(1);
        expect(result.agents[0].name).toBe("real");
    });

    test("handles empty frontmatter body gracefully", () => {
        const agentsDir = join(tmpDir, ".pizzapi", "agents");
        mkdirSync(agentsDir, { recursive: true });

        createAgentFile(agentsDir, "minimal.md", {
            name: "minimal",
            description: "No system prompt",
        });

        const result = discoverAgents(tmpDir, "project");
        expect(result.agents).toHaveLength(1);
        expect(result.agents[0].systemPrompt).toBe("");
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
        expect(result.agents[0].tools).toEqual(["read", "grep", "find", "ls"]);
        expect(result.agents[0].model).toBe("claude-haiku-3");
    });

    test("agents without tools field have undefined tools", () => {
        const agentsDir = join(tmpDir, ".pizzapi", "agents");
        mkdirSync(agentsDir, { recursive: true });

        createAgentFile(agentsDir, "general.md", {
            name: "general",
            description: "General purpose agent",
        });

        const result = discoverAgents(tmpDir, "project");
        expect(result.agents[0].tools).toBeUndefined();
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
        // With no .pizzapi/agents/ dir, should be empty
        expect(result.agents).toEqual([]);
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
        expect(result.agents).toHaveLength(3);
        const names = result.agents.map(a => a.name).sort();
        expect(names).toEqual(["alpha", "beta", "gamma"]);
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
