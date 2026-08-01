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
import { parseFrontmatter } from "@earendil-works/pi-coding-agent";

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
 * Parse a single agent `.md` file's frontmatter + body into an `AgentConfig`.
 * Returns `null` when the file is missing/unreadable, has malformed YAML
 * frontmatter, or is missing the required `name`/`description` fields.
 */
function loadAgentFromFile(filePath: string, source: "user" | "project"): AgentConfig | null {
    let content: string;
    try {
        content = fs.readFileSync(filePath, "utf-8");
    } catch {
        return null;
    }

    let frontmatter: Record<string, string | boolean | number>;
    let body: string;
    try {
        ({ frontmatter, body } = parseFrontmatter<Record<string, string | boolean | number>>(content));
    } catch {
        // Malformed YAML frontmatter — silently skip this file
        return null;
    }

    const name = String(frontmatter.name ?? "").trim();
    const description = String(frontmatter.description ?? "").trim();
    if (!name || !description) {
        return null;
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

    return {
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
    };
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

        const agent = loadAgentFromFile(path.join(dir, entry.name), source);
        if (agent) agents.push(agent);
    }

    return agents;
}

/**
 * Load exactly the declared `.md` files as agents — unlike
 * `loadAgentsFromDir()`, sibling files in the same directory that weren't
 * explicitly listed are never picked up. Used for overlay `agents` entries
 * that name a single file (docs/specs/pi-pizzapi-overlay.md §4.3): a
 * package declaring `agents: ["agents/a.md"]` must not also load an
 * unrelated `agents/b.md` sitting next to it.
 */
export function loadAgentsFromFile(files: string[], source: "user" | "project"): AgentConfig[] {
    const agents: AgentConfig[] = [];
    for (const filePath of files) {
        const agent = loadAgentFromFile(filePath, source);
        if (agent) agents.push(agent);
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
 * @param opts.extraProjectDirs - Additional directories to treat as
 *   project-scope (e.g. `pi.pizzapi.agents` from project-scoped packages).
 *   Loaded after the walked-up `.pizzapi`/`.claude` project dirs, so
 *   project-owned agents always take precedence. Agents sourced from here
 *   still carry `source: "project"`, so they remain excluded from the
 *   default `agentScope: "user"` and still trigger `confirmProjectAgents`
 *   (docs/specs/pi-pizzapi-overlay.md §4.3).
 * @param opts.extraUserFiles / extraProjectFiles - Additional exact `.md`
 *   files (not directories) to load as user-/project-scope agents, loaded
 *   after the corresponding `extra*Dirs`. Used for overlay `agents` entries
 *   that name a single file: loaded via `loadAgentsFromFile()` so a sibling
 *   `.md` file in the same directory that wasn't declared is never picked up.
 */
export function discoverAgents(
    cwd: string,
    scope: AgentScope,
    opts?: { extraUserDirs?: string[]; extraProjectDirs?: string[]; extraUserFiles?: string[]; extraProjectFiles?: string[] },
): AgentDiscoveryResult {
    const userDirs = getUserAgentsDirs();
    const projectAgentsDirs = findNearestProjectAgentsDirs(cwd);

    // Load user agents from all user dirs (first-name-wins: .pizzapi before .claude)
    let userAgents: AgentConfig[] = [];
    if (scope !== "project") {
        const seen = new Set<string>();
        const allUserDirs = [...userDirs, ...(opts?.extraUserDirs ?? [])];
        const userAgentSources = [
            ...allUserDirs.flatMap((dir) => loadAgentsFromDir(dir, "user")),
            ...loadAgentsFromFile(opts?.extraUserFiles ?? [], "user"),
        ];
        for (const agent of userAgentSources) {
            if (!seen.has(agent.name)) {
                seen.add(agent.name);
                userAgents.push(agent);
            }
        }
    }

    // Load project agents from all found dirs, then extraProjectDirs
    // (first-name-wins: .pizzapi before .claude before extraProjectDirs)
    let projectAgents: AgentConfig[] = [];
    if (scope !== "user") {
        const seen = new Set<string>();
        const allProjectDirs = [...projectAgentsDirs, ...(opts?.extraProjectDirs ?? [])];
        const projectAgentSources = [
            ...allProjectDirs.flatMap((dir) => loadAgentsFromDir(dir, "project")),
            ...loadAgentsFromFile(opts?.extraProjectFiles ?? [], "project"),
        ];
        for (const agent of projectAgentSources) {
            if (!seen.has(agent.name)) {
                seen.add(agent.name);
                projectAgents.push(agent);
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
