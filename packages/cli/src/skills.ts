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

// ── Skill path builders ───────────────────────────────────────────────────────

// expandHome is imported from config.ts

/**
 * Build the list of additional skill paths for the interactive CLI.
 * Always includes:
 *   - ~/.pizzapi/skills/  (global PizzaPi skills)
 *   - <cwd>/.pizzapi/skills/  (project-local PizzaPi skills)
 * Plus any paths declared in config.skills.
 */
export function buildInteractiveSkillPaths(cwd: string, configSkills?: string[]): string[] {
    const paths: string[] = [
        builtinSkillsDir(),
        join(homedir(), ".pizzapi", "skills"),
        join(cwd, ".pizzapi", "skills"),
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
 * Build additional skill paths for the headless worker.
 *
 * ~/.pizzapi/skills/ is already discovered via agentDir, so we only need
 * the project-local .pizzapi/skills/ plus Claude-style agents/ directories
 * (both global and project-local) which map to pi skills.
 */
export function buildWorkerSkillPaths(cwd: string, configSkills?: string[]): string[] {
    const paths: string[] = [
        builtinSkillsDir(),
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
