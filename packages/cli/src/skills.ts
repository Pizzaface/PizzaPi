/**
 * Skill discovery and management utilities.
 *
 * Extracted from daemon.ts and the CLI/worker entry points so the logic
 * is independently testable.
 */
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { expandHome } from "./config.js";

const __dirname = dirname(fileURLToPath(import.meta.url));

/** Detect compiled Bun binary (assets live next to process.execPath, not import.meta.url). */
const isCompiledBinary = import.meta.url.includes("$bunfs") || import.meta.url.includes("~BUN") || import.meta.url.includes("%7EBUN");

/** Built-in skills shipped with the CLI package. */
export function builtinSkillsDir(): string {
    if (isCompiledBinary) {
        // In a compiled binary, .md assets are copied next to the executable
        // (not embedded in the virtual $bunfs filesystem).
        return join(dirname(process.execPath), "skills");
    }
    return join(__dirname, "skills");
}

// ── Types ─────────────────────────────────────────────────────────────────────

export interface SkillMeta {
    name: string;
    description: string;
    filePath: string;
}

// ── Skill directory ───────────────────────────────────────────────────────────

/** Default global skills directory for PizzaPi. */
export function globalSkillsDir(): string {
    return join(homedir(), ".pizzapi", "skills");
}

// ── Frontmatter parsing ───────────────────────────────────────────────────────

/**
 * Parse the `description` field out of a SKILL.md frontmatter block.
 * Returns empty string if not found or file is unreadable.
 */
export function parseSkillFrontmatter(filePath: string): { description: string } {
    let content: string;
    try {
        content = readFileSync(filePath, "utf-8");
    } catch {
        return { description: "" };
    }

    return parseSkillFrontmatterFromString(content);
}

/**
 * Parse the `description` field out of a frontmatter string.
 * Pure function — no filesystem access.
 */
export function parseSkillFrontmatterFromString(content: string): { description: string } {
    if (!content.startsWith("---")) return { description: "" };
    const end = content.indexOf("\n---", 3);
    if (end === -1) return { description: "" };

    const block = content.slice(3, end);
    const match = block.match(/^description:\s*(.+)$/m);
    return { description: match ? match[1].trim().replace(/^["']|["']$/g, "") : "" };
}

// ── Skill scanning ────────────────────────────────────────────────────────────

/**
 * Scan a skills directory and return basic metadata.
 * Mirrors the discovery rules from the Agent Skills standard:
 *   - Direct .md files in the root → name = basename without extension
 *   - SKILL.md files under subdirectories → name = directory name
 */
export function scanSkillsDir(dir: string): SkillMeta[] {
    if (!existsSync(dir)) return [];

    const skills: SkillMeta[] = [];

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
            // Direct .md file in root
            const name = entry.slice(0, -3);
            const { description } = parseSkillFrontmatter(fullPath);
            skills.push({ name, description, filePath: fullPath });
        } else if (st.isDirectory()) {
            // Look for SKILL.md inside
            const skillMd = join(fullPath, "SKILL.md");
            if (existsSync(skillMd)) {
                const { description } = parseSkillFrontmatter(skillMd);
                skills.push({ name: entry, description, filePath: skillMd });
            }
        }
    }

    return skills;
}

/** Scan the global PizzaPi skills directory (~/.pizzapi/skills/). */
export function scanGlobalSkills(): SkillMeta[] {
    return scanSkillsDir(globalSkillsDir());
}

// ── CRUD operations ───────────────────────────────────────────────────────────

/**
 * Read the full content of a skill file.
 * Checks subdirectory layout first (<dir>/<name>/SKILL.md), then direct file (<dir>/<name>.md).
 * Returns null if not found.
 */
export function readSkillContent(name: string, dir?: string): string | null {
    const skillsDir = dir ?? globalSkillsDir();

    // Try subdirectory first: <dir>/<name>/SKILL.md
    const subPath = join(skillsDir, name, "SKILL.md");
    if (existsSync(subPath)) {
        try { return readFileSync(subPath, "utf-8"); } catch { return null; }
    }

    // Try direct file: <dir>/<name>.md
    const filePath = join(skillsDir, `${name}.md`);
    if (existsSync(filePath)) {
        try { return readFileSync(filePath, "utf-8"); } catch { return null; }
    }

    return null;
}

/**
 * Write (create or update) a skill.
 * Uses the subdirectory layout: <dir>/<name>/SKILL.md
 */
export async function writeSkill(name: string, content: string, dir?: string): Promise<void> {
    const skillDir = join(dir ?? globalSkillsDir(), name);
    await mkdir(skillDir, { recursive: true });
    writeFileSync(join(skillDir, "SKILL.md"), content, "utf-8");
}

/**
 * Delete a skill by name.
 * Handles both subdirectory (SKILL.md) and direct (.md) layouts.
 * Returns true if a skill was deleted.
 */
export function deleteSkill(name: string, dir?: string): boolean {
    const skillsDir = dir ?? globalSkillsDir();

    const subPath = join(skillsDir, name);
    if (existsSync(join(subPath, "SKILL.md"))) {
        try {
            rmSync(subPath, { recursive: true, force: true });
            return true;
        } catch {
            return false;
        }
    }

    const filePath = join(skillsDir, `${name}.md`);
    if (existsSync(filePath)) {
        try {
            rmSync(filePath);
            return true;
        } catch {
            return false;
        }
    }

    return false;
}

// ── Project agent files loader ─────────────────────────────────────────────────

export interface AgentFile {
    path: string;
    content: string;
}

/**
 * Load project-level agent files that the upstream `DefaultResourceLoader`
 * does NOT discover on its own.
 *
 * The upstream `loadProjectContextFiles()` already handles:
 *   - AGENTS.md / CLAUDE.md from the agentDir (~/.pizzapi/)
 *   - AGENTS.md / CLAUDE.md from cwd and all ancestor directories
 *
 * This function loads the ADDITIONAL files that PizzaPi supports:
 *   - <cwd>/AGENTS.md          (explicit project-dir load — ensures parity)
 *   - <cwd>/.agents/*.md       (Claude Code style agent context files)
 *
 * Both the interactive CLI and the headless runner worker should use this
 * via `agentsFilesOverride` on `DefaultResourceLoader`.
 *
 * NOTE: The upstream already loads <cwd>/AGENTS.md via ancestor walk.
 * To avoid duplicates, callers use this with `agentsFilesOverride` which
 * receives the base list — we deduplicate by path.
 */
export function loadProjectAgentFiles(cwd: string): AgentFile[] {
    const files: AgentFile[] = [];

    // Load AGENTS.md from cwd (also loaded by upstream, but we include it
    // to guarantee it's present — deduplication happens in agentsFilesOverride)
    const agentsMdPath = join(cwd, "AGENTS.md");
    if (existsSync(agentsMdPath)) {
        try {
            const content = readFileSync(agentsMdPath, "utf-8");
            files.push({ path: agentsMdPath, content });
        } catch {
            // Skip unreadable files
        }
    }

    // Load .agents/*.md from cwd
    const dotAgentsDir = join(cwd, ".agents");
    if (existsSync(dotAgentsDir)) {
        let entries: string[];
        try {
            entries = readdirSync(dotAgentsDir);
        } catch {
            entries = [];
        }
        for (const file of entries) {
            if (!file.endsWith(".md")) continue;
            const filePath = join(dotAgentsDir, file);
            try {
                const content = readFileSync(filePath, "utf-8");
                files.push({ path: filePath, content });
            } catch {
                // Skip unreadable files
            }
        }
    }

    return files;
}

/**
 * Create an `agentsFilesOverride` function for `DefaultResourceLoader`
 * that merges the upstream-discovered agent files with PizzaPi's
 * additional project agent files, deduplicating by path.
 *
 * Returns null if there are no additional files to add.
 */
export function createAgentsFilesOverride(
    cwd: string,
): ((base: { agentsFiles: AgentFile[] }) => { agentsFiles: AgentFile[] }) | null {
    const additionalFiles = loadProjectAgentFiles(cwd);
    if (additionalFiles.length === 0) return null;

    return (base) => {
        const seenPaths = new Set(base.agentsFiles.map(f => f.path));
        const deduped = additionalFiles.filter(f => !seenPaths.has(f.path));
        return {
            agentsFiles: [...base.agentsFiles, ...deduped],
        };
    };
}

// ── Skill path builders ───────────────────────────────────────────────────────

// expandHome is imported from config.ts

/**
 * Build the unified list of additional skill paths.
 *
 * Used by BOTH the interactive CLI and the headless runner worker so that
 * skills are discoverable identically regardless of how the session was
 * started.
 *
 * Includes:
 *   - Built-in skills shipped with the CLI package
 *   - ~/.pizzapi/skills/        (global PizzaPi skills)
 *   - <cwd>/.pizzapi/skills/    (project-local PizzaPi skills)
 *   - ~/.pizzapi/agents/        (global agents treated as skills)
 *   - <cwd>/.pizzapi/agents/    (project-local agents treated as skills)
 *   - <cwd>/.agents/skills/     (Claude Code compatible project skills)
 *   - <cwd>/.agents/agents/     (Claude Code compatible project agents)
 *   - Paths declared in config.skills
 */
export function buildSkillPaths(cwd: string, configSkills?: string[]): string[] {
    const paths: string[] = [
        builtinSkillsDir(),
        join(homedir(), ".pizzapi", "skills"),
        join(cwd, ".pizzapi", "skills"),
        join(homedir(), ".pizzapi", "agents"),
        join(cwd, ".pizzapi", "agents"),
        join(cwd, ".agents", "skills"),
        join(cwd, ".agents", "agents"),
    ];
    if (Array.isArray(configSkills)) {
        for (const p of configSkills) {
            if (typeof p === "string" && p.trim()) {
                paths.push(expandHome(p.trim()));
            }
        }
    }
    return paths;
}

/**
 * @deprecated Use `buildSkillPaths` instead. Kept for backward compatibility.
 */
export function buildInteractiveSkillPaths(cwd: string, configSkills?: string[]): string[] {
    return buildSkillPaths(cwd, configSkills);
}

/**
 * @deprecated Use `buildSkillPaths` instead. Kept for backward compatibility.
 */
export function buildWorkerSkillPaths(cwd: string, configSkills?: string[]): string[] {
    return buildSkillPaths(cwd, configSkills);
}

// ── Prompt template path builders ─────────────────────────────────────────────

/**
 * Build the list of additional prompt template / command paths.
 *
 * Used by BOTH the interactive CLI and the headless runner worker.
 *
 * Includes:
 *   - <cwd>/.pizzapi/prompts/   (project-local prompt templates)
 *   - ~/.pizzapi/commands/       (global commands — Claude Code compatible)
 *   - <cwd>/.pizzapi/commands/   (project-local commands)
 *   - <cwd>/.agents/commands/    (Claude Code compatible project commands)
 */
export function buildPromptTemplatePaths(cwd: string): string[] {
    return [
        join(cwd, ".pizzapi", "prompts"),
        join(homedir(), ".pizzapi", "commands"),
        join(cwd, ".pizzapi", "commands"),
        join(cwd, ".agents", "commands"),
    ];
}
