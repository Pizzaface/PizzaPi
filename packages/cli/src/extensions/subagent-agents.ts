/**
 * Agent discovery and configuration for PizzaPi subagents.
 *
 * Discovers agent definitions from:
 *   - User scope:    ~/.pizzapi/agents/*.md
 *   - Project scope: .pizzapi/agents/*.md (walk up from cwd)
 *
 * Adapted from upstream pi subagent extension (examples/extensions/subagent/agents.ts)
 * with PizzaPi-specific discovery paths.
 */

import * as fs from "node:fs";
import { homedir } from "node:os";
import * as path from "node:path";
import { parseFrontmatter } from "@mariozechner/pi-coding-agent";

export type AgentScope = "user" | "project" | "both";

export interface AgentConfig {
    name: string;
    description: string;
    tools?: string[];
    model?: string;
    systemPrompt: string;
    source: "user" | "project";
    filePath: string;
}

export interface AgentDiscoveryResult {
    agents: AgentConfig[];
    projectAgentsDir: string | null;
}

/**
 * Load agent definitions from a directory of .md files.
 *
 * Each .md file must have YAML frontmatter with at least `name` and `description`.
 * Optional frontmatter: `tools` (comma-separated), `model`.
 * The markdown body becomes the agent's system prompt.
 */
function loadAgentsFromDir(dir: string, source: "user" | "project"): AgentConfig[] {
    const agents: AgentConfig[] = [];

    if (!fs.existsSync(dir)) {
        return agents;
    }

    let entries: fs.Dirent[];
    try {
        entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
        return agents;
    }

    for (const entry of entries) {
        if (!entry.name.endsWith(".md")) continue;
        if (!entry.isFile() && !entry.isSymbolicLink()) continue;

        const filePath = path.join(dir, entry.name);
        let content: string;
        try {
            content = fs.readFileSync(filePath, "utf-8");
        } catch {
            continue;
        }

        const { frontmatter, body } = parseFrontmatter<Record<string, string>>(content);

        if (!frontmatter.name || !frontmatter.description) {
            continue;
        }

        const tools = frontmatter.tools
            ?.split(",")
            .map((t: string) => t.trim())
            .filter(Boolean);

        agents.push({
            name: frontmatter.name,
            description: frontmatter.description,
            tools: tools && tools.length > 0 ? tools : undefined,
            model: frontmatter.model,
            systemPrompt: body,
            source,
            filePath,
        });
    }

    return agents;
}

function isDirectory(p: string): boolean {
    try {
        return fs.statSync(p).isDirectory();
    } catch {
        return false;
    }
}

/**
 * Walk up from cwd looking for `.pizzapi/agents/` directory.
 */
function findNearestProjectAgentsDir(cwd: string): string | null {
    let currentDir = cwd;
    while (true) {
        const candidate = path.join(currentDir, ".pizzapi", "agents");
        if (isDirectory(candidate)) return candidate;

        const parentDir = path.dirname(currentDir);
        if (parentDir === currentDir) return null;
        currentDir = parentDir;
    }
}

/**
 * Get the PizzaPi user agents directory: ~/.pizzapi/agents/
 */
export function getUserAgentsDir(): string {
    return path.join(homedir(), ".pizzapi", "agents");
}

/**
 * Discover agents from user and/or project directories.
 *
 * When scope is "both" and a project agent has the same name as a user agent,
 * the project agent takes precedence (override pattern).
 */
export function discoverAgents(cwd: string, scope: AgentScope): AgentDiscoveryResult {
    const userDir = getUserAgentsDir();
    const projectAgentsDir = findNearestProjectAgentsDir(cwd);

    const userAgents = scope === "project" ? [] : loadAgentsFromDir(userDir, "user");
    const projectAgents = scope === "user" || !projectAgentsDir ? [] : loadAgentsFromDir(projectAgentsDir, "project");

    const agentMap = new Map<string, AgentConfig>();

    if (scope === "both") {
        // User agents first, project agents override
        for (const agent of userAgents) agentMap.set(agent.name, agent);
        for (const agent of projectAgents) agentMap.set(agent.name, agent);
    } else if (scope === "user") {
        for (const agent of userAgents) agentMap.set(agent.name, agent);
    } else {
        for (const agent of projectAgents) agentMap.set(agent.name, agent);
    }

    return { agents: Array.from(agentMap.values()), projectAgentsDir };
}

/**
 * Format a list of agents for display (e.g., in error messages).
 */
export function formatAgentList(agents: AgentConfig[], maxItems: number): { text: string; remaining: number } {
    if (agents.length === 0) return { text: "none", remaining: 0 };
    const listed = agents.slice(0, maxItems);
    const remaining = agents.length - listed.length;
    return {
        text: listed.map((a) => `${a.name} (${a.source}): ${a.description}`).join("; "),
        remaining,
    };
}
