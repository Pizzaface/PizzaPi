/**
 * Agent discovery and configuration for PizzaPi subagents.
 *
 * Discovers agent definitions from (in precedence order):
 *
 *   User scope:
 *     - ~/.pizzapi/agents/*.md
 *     - ~/.claude/agents/*.md   (Claude Code compatibility)
 *
 *   Project scope (walk up from cwd):
 *     - .pizzapi/agents/*.md
 *     - .claude/agents/*.md     (Claude Code compatibility)
 *
 * Supports Claude Code frontmatter fields: name, description, tools,
 * disallowedTools, model, maxTurns, permissionMode, background.
 *
 * Adapted from upstream pi subagent extension (examples/extensions/subagent/agents.ts)
 * with PizzaPi + Claude Code compatible discovery paths.
 */

import * as fs from "node:fs";
import { homedir } from "node:os";
import * as path from "node:path";
import { parseFrontmatter } from "@mariozechner/pi-coding-agent";

export type AgentScope = "user" | "project" | "both";

export interface AgentConfig {
    name: string;
    description: string;
    /** Allowed tools (comma-separated in frontmatter). If omitted, inherits all tools. */
    tools?: string[];
    /** Tools to explicitly deny — removed from inherited or specified tools list. */
    disallowedTools?: string[];
    /** Model override (e.g., "claude-haiku-3", "sonnet", "opus", "haiku", "inherit"). */
    model?: string;
    /** Maximum number of agentic turns before the subagent stops. */
    maxTurns?: number;
    /** Permission mode: "default", "acceptEdits", "dontAsk", "bypassPermissions", "plan". */
    permissionMode?: string;
    /** If true, always run as a background task. */
    background?: boolean;
    /** The markdown body — becomes the agent's system prompt. */
    systemPrompt: string;
    source: "user" | "project";
    filePath: string;
}

export interface AgentDiscoveryResult {
    agents: AgentConfig[];
    projectAgentsDir: string | null;
}

// ── Built-in agents ────────────────────────────────────────────────────

/**
 * Built-in agents that are always available without any .md file.
 * User or project agents with the same name take precedence (override).
 */
export const BUILTIN_AGENTS: AgentConfig[] = [
    {
        name: "task",
        description: "General-purpose agent — can be tasked with anything",
        systemPrompt: [
            "You are a general-purpose task agent. You can read, write, edit, and run commands to accomplish any task delegated to you.",
            "",
            "## Guidelines",
            "",
            "- Read and understand context before making changes",
            "- Use the right tool for the job — `bash` for commands, `edit` for surgical changes, `write` for new files",
            "- Be thorough but concise — do the work, report what you did",
            "- If something fails, diagnose and fix it rather than giving up",
            "- When the task is complete, provide a clear summary of what was done",
        ].join("\n"),
        source: "user",
        filePath: "(built-in)",
    },
];

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

        const { frontmatter, body } = parseFrontmatter<Record<string, string | boolean | number>>(content);

        const name = String(frontmatter.name ?? "").trim();
        const description = String(frontmatter.description ?? "").trim();
        if (!name || !description) {
            continue;
        }

        const toolsStr = typeof frontmatter.tools === "string" ? frontmatter.tools : "";
        const tools = toolsStr
            .split(",")
            .map((t: string) => t.trim())
            .filter(Boolean);

        const disallowedStr = typeof frontmatter.disallowedTools === "string" ? frontmatter.disallowedTools : "";
        const disallowedTools = disallowedStr
            .split(",")
            .map((t: string) => t.trim())
            .filter(Boolean);

        const rawMaxTurns = frontmatter.maxTurns;
        const maxTurns = rawMaxTurns ? parseInt(String(rawMaxTurns), 10) : undefined;
        // YAML parses `true` as boolean, but it might also be the string "true" / "yes"
        const rawBg = frontmatter.background;
        const background = rawBg === true || rawBg === "true" || rawBg === "yes";

        const model = typeof frontmatter.model === "string" ? frontmatter.model : undefined;
        const permissionMode = typeof frontmatter.permissionMode === "string" ? frontmatter.permissionMode : undefined;

        agents.push({
            name,
            description,
            tools: tools.length > 0 ? tools : undefined,
            disallowedTools: disallowedTools.length > 0 ? disallowedTools : undefined,
            model,
            maxTurns: maxTurns && !isNaN(maxTurns) ? maxTurns : undefined,
            permissionMode,
            background: background || undefined,
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
 * Walk up from cwd looking for agent directories.
 * At each level, checks both `.pizzapi/agents/` and `.claude/agents/`.
 * Stops walking once we find at least one agents dir at a level.
 * Returns all found dirs at the nearest level (may be 1 or 2).
 */
function findNearestProjectAgentsDirs(cwd: string): string[] {
    let currentDir = cwd;
    while (true) {
        const found: string[] = [];
        for (const prefix of [".pizzapi", ".claude"]) {
            const candidate = path.join(currentDir, prefix, "agents");
            if (isDirectory(candidate)) found.push(candidate);
        }
        if (found.length > 0) return found;

        const parentDir = path.dirname(currentDir);
        if (parentDir === currentDir) return [];
        currentDir = parentDir;
    }
}

/**
 * Get all user-scope agent directories (in precedence order).
 * Returns: ~/.pizzapi/agents/ and ~/.claude/agents/
 */
export function getUserAgentsDirs(): string[] {
    const home = homedir();
    return [
        path.join(home, ".pizzapi", "agents"),
        path.join(home, ".claude", "agents"),
    ];
}

/**
 * Get the primary PizzaPi user agents directory: ~/.pizzapi/agents/
 */
export function getUserAgentsDir(): string {
    return path.join(homedir(), ".pizzapi", "agents");
}

/**
 * Discover agents from user and/or project directories.
 *
 * User directories searched (in order, first-name-wins):
 *   - ~/.pizzapi/agents/
 *   - ~/.claude/agents/
 *
 * Project directories searched (walk-up from cwd, first dir found wins):
 *   - .pizzapi/agents/
 *   - .claude/agents/
 *
 * When scope is "both" and a project agent has the same name as a user agent,
 * the project agent takes precedence (override pattern).
 *
 * @param opts.extraUserDirs - Additional directories to treat as user-scope
 *   (e.g. plugin agents/ dirs). Loaded after ~/.pizzapi and ~/.claude, so
 *   user-owned agents always take precedence.
 */
export function discoverAgents(cwd: string, scope: AgentScope, opts?: { extraUserDirs?: string[] }): AgentDiscoveryResult {
    const userDirs = getUserAgentsDirs();
    const projectAgentsDirs = findNearestProjectAgentsDirs(cwd);

    // Load user agents from all user dirs (first-name-wins: .pizzapi before .claude)
    let userAgents: AgentConfig[] = [];
    if (scope !== "project") {
        const seen = new Set<string>();
        const allUserDirs = [...userDirs, ...(opts?.extraUserDirs ?? [])];
        for (const dir of allUserDirs) {
            for (const agent of loadAgentsFromDir(dir, "user")) {
                if (!seen.has(agent.name)) {
                    seen.add(agent.name);
                    userAgents.push(agent);
                }
            }
        }
    }

    // Load project agents from all found dirs (first-name-wins: .pizzapi before .claude)
    let projectAgents: AgentConfig[] = [];
    if (scope !== "user" && projectAgentsDirs.length > 0) {
        const seen = new Set<string>();
        for (const dir of projectAgentsDirs) {
            for (const agent of loadAgentsFromDir(dir, "project")) {
                if (!seen.has(agent.name)) {
                    seen.add(agent.name);
                    projectAgents.push(agent);
                }
            }
        }
    }

    const agentMap = new Map<string, AgentConfig>();

    // Built-in agents go first (lowest priority — overridden by user/project)
    for (const agent of BUILTIN_AGENTS) agentMap.set(agent.name, agent);

    if (scope === "both") {
        // User agents override built-ins, project agents override user
        for (const agent of userAgents) agentMap.set(agent.name, agent);
        for (const agent of projectAgents) agentMap.set(agent.name, agent);
    } else if (scope === "user") {
        for (const agent of userAgents) agentMap.set(agent.name, agent);
    } else {
        for (const agent of projectAgents) agentMap.set(agent.name, agent);
    }

    return { agents: Array.from(agentMap.values()), projectAgentsDir: projectAgentsDirs[0] ?? null };
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
