/**
 * Agent discovery and management utilities.
 *
 * Agents are markdown files (with optional YAML frontmatter) stored in
 * ~/.pizzapi/agents/ or ~/.claude/agents/. They define specialized agent
 * personas that can be invoked via the subagent tool.
 *
 * This module mirrors the skills.ts patterns for consistency.
 */
import { existsSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

// ── Types ─────────────────────────────────────────────────────────────────────

export interface AgentMeta {
    name: string;
    description: string;
    filePath: string;
}

// ── Agent directory ───────────────────────────────────────────────────────────

/** Default global agents directory for PizzaPi. */
export function globalAgentsDir(): string {
    return join(homedir(), ".pizzapi", "agents");
}

// ── Frontmatter parsing ───────────────────────────────────────────────────────

/**
 * Parse the `description` field out of an agent markdown file's frontmatter.
 * Returns empty string if not found or file is unreadable.
 */
export function parseAgentFrontmatter(filePath: string): { description: string } {
    let content: string;
    try {
        content = readFileSync(filePath, "utf-8");
    } catch {
        return { description: "" };
    }

    return parseAgentFrontmatterFromString(content);
}

/**
 * Parse the `description` field out of a frontmatter string.
 * Pure function — no filesystem access.
 */
export function parseAgentFrontmatterFromString(content: string): { description: string } {
    if (!content.startsWith("---")) return { description: "" };
    const end = content.indexOf("\n---", 3);
    if (end === -1) return { description: "" };

    const block = content.slice(3, end);
    const match = block.match(/^description:\s*(.+)$/m);
    return { description: match ? match[1].trim().replace(/^["']|["']$/g, "") : "" };
}

// ── Agent scanning ────────────────────────────────────────────────────────────

/**
 * Scan an agents directory and return basic metadata.
 * Discovery rules:
 *   - .md files in the directory → name = basename without extension
 */
export function scanAgentsDir(dir: string): AgentMeta[] {
    if (!existsSync(dir)) return [];

    const agents: AgentMeta[] = [];

    let entries: string[];
    try {
        entries = readdirSync(dir);
    } catch {
        return [];
    }

    for (const entry of entries) {
        if (entry.startsWith(".")) continue;

        const fullPath = join(dir, entry);
        let st: ReturnType<typeof statSync>;
        try {
            st = statSync(fullPath);
        } catch {
            continue;
        }

        if (st.isFile() && entry.toLowerCase().endsWith(".md")) {
            const name = entry.slice(0, -3);
            const { description } = parseAgentFrontmatter(fullPath);
            agents.push({ name, description, filePath: fullPath });
        }
    }

    return agents;
}

/**
 * Scan all global agent directories and return deduplicated metadata.
 * Scans ~/.pizzapi/agents/ first (higher precedence), then ~/.claude/agents/
 * for Claude Code compatibility. Agents with the same name in .pizzapi
 * take priority over those in .claude.
 */
export function scanGlobalAgents(): AgentMeta[] {
    const dirs = [
        globalAgentsDir(),                              // ~/.pizzapi/agents/
        join(homedir(), ".claude", "agents"),            // ~/.claude/agents/
    ];
    const seen = new Set<string>();
    const agents: AgentMeta[] = [];
    for (const dir of dirs) {
        for (const agent of scanAgentsDir(dir)) {
            if (!seen.has(agent.name)) {
                seen.add(agent.name);
                agents.push(agent);
            }
        }
    }
    return agents;
}

// ── CRUD operations ───────────────────────────────────────────────────────────

/**
 * Read the full content of an agent file.
 * Checks <dir>/<name>.md. When no dir is specified, searches both
 * ~/.pizzapi/agents/ and ~/.claude/agents/ (first match wins).
 * Returns null if not found.
 */
export function readAgentContent(name: string, dir?: string): string | null {
    const dirs = dir ? [dir] : [globalAgentsDir(), join(homedir(), ".claude", "agents")];
    for (const d of dirs) {
        const filePath = join(d, `${name}.md`);
        if (existsSync(filePath)) {
            try { return readFileSync(filePath, "utf-8"); } catch { /* continue */ }
        }
    }
    return null;
}

/** Default search directories for agent discovery (in priority order). */
export function defaultAgentDirs(): string[] {
    return [globalAgentsDir(), join(homedir(), ".claude", "agents")];
}

/**
 * Find the directory where an agent currently lives.
 * Searches the given directories (defaults to ~/.pizzapi/agents/ then ~/.claude/agents/).
 * Returns null if the agent doesn't exist in any known directory.
 */
export function findAgentDir(name: string, searchDirs?: string[]): string | null {
    const dirs = searchDirs ?? defaultAgentDirs();
    for (const d of dirs) {
        const filePath = join(d, `${name}.md`);
        if (existsSync(filePath)) return d;
    }
    return null;
}

/**
 * Write (create or update) an agent.
 * Stores as <dir>/<name>.md
 *
 * When no dir is specified, writes to the agent's existing location if it
 * already exists (preserving ~/.claude/agents/ sources), otherwise defaults
 * to ~/.pizzapi/agents/ for new agents.
 */
export async function writeAgent(name: string, content: string, dir?: string): Promise<void> {
    const agentsDir = dir ?? findAgentDir(name) ?? globalAgentsDir();
    await mkdir(agentsDir, { recursive: true });
    writeFileSync(join(agentsDir, `${name}.md`), content, "utf-8");
}

/**
 * Delete an agent by name.
 * When no dir is specified, searches both ~/.pizzapi/agents/ and
 * ~/.claude/agents/ (deletes first match).
 * Returns true if an agent was deleted.
 */
export function deleteAgent(name: string, dir?: string): boolean {
    const dirs = dir ? [dir] : [globalAgentsDir(), join(homedir(), ".claude", "agents")];
    for (const d of dirs) {
        const filePath = join(d, `${name}.md`);
        if (existsSync(filePath)) {
            try {
                rmSync(filePath);
                return true;
            } catch {
                return false;
            }
        }
    }
    return false;
}
