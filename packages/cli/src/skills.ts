/**
 * Skill discovery and management utilities.
 *
 * Extracted from daemon.ts and the CLI/worker entry points so the logic
 * is independently testable.
 */
import { existsSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { expandHome } from "./config.js";
import { parseFrontmatterDescription } from "./frontmatter.js";

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

    return parseFrontmatterDescription(content);
}

export { parseFrontmatterDescription as parseSkillFrontmatterFromString } from "./frontmatter.js";

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

/** Load direct markdown rule files from a directory in lexicographic order. */
export function loadRulesDir(dir: string): AgentFile[] {
    if (!existsSync(dir)) return [];
    let entries: string[];
    try {
        entries = readdirSync(dir).sort();
    } catch {
        return [];
    }

    const files: AgentFile[] = [];
    for (const entry of entries) {
        if (!entry.endsWith(".md")) continue;
        const path = join(dir, entry);
        try {
            if (statSync(path).isFile()) files.push({ path, content: readFileSync(path, "utf-8") });
        } catch {
            // Skip unreadable or concurrently removed files.
        }
    }
    return files;
}

/** Load global and project modular rules, in override-friendly order. */
export function loadRules(cwd: string): { global: AgentFile[]; project: AgentFile[] } {
    // TODO: also discover Claude Code's ~/.claude/rules/ for compatibility.
    return {
        global: loadRulesDir(join(homedir(), ".pizzapi", "rules")),
        project: loadRulesDir(join(cwd, ".pizzapi", "rules")),
    };
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
export interface AgentsFilesOverrideOptions {
    /** When false, do not send AGENTS.md context files automatically. */
    sendAgentsMd?: boolean;
}

function isAgentsMdPath(path: string): boolean {
    return basename(path).toLowerCase() === "agents.md";
}

export function createAgentsFilesOverride(
    cwd: string,
    options: AgentsFilesOverrideOptions = {},
): ((base: { agentsFiles: AgentFile[] }) => { agentsFiles: AgentFile[] }) | null {
    const sendAgentsMd = options.sendAgentsMd !== false;
    const rules = loadRules(cwd);
    const projectFiles = loadProjectAgentFiles(cwd);
    const additionalFiles = [
        ...(sendAgentsMd ? rules.global : []),
        ...(sendAgentsMd ? projectFiles : projectFiles.filter((file) => !isAgentsMdPath(file.path))),
        ...(sendAgentsMd ? rules.project : []),
    ];
    if (additionalFiles.length === 0 && sendAgentsMd) return null;

    return (base) => {
        const baseFiles = sendAgentsMd
            ? base.agentsFiles
            : base.agentsFiles.filter((file) => !isAgentsMdPath(file.path));
        const seenPaths = new Set<string>();
        const unique = (files: AgentFile[]) => files.filter((file) => {
            if (seenPaths.has(file.path)) return false;
            seenPaths.add(file.path);
            return true;
        });
        if (!sendAgentsMd) return { agentsFiles: unique([...baseFiles, ...additionalFiles]) };

        // Keep upstream global context first, then global rules, then project context.
        const globalRoot = join(homedir(), ".pizzapi") + "/";
        const globalFiles = baseFiles.filter((file) => file.path.startsWith(globalRoot));
        const projectFiles = baseFiles.filter((file) => !file.path.startsWith(globalRoot));
        return {
            agentsFiles: unique([
                ...globalFiles,
                ...additionalFiles.filter((file) => rules.global.some((rule) => rule.path === file.path)),
                ...projectFiles,
                ...additionalFiles.filter((file) => !rules.global.some((rule) => rule.path === file.path)),
            ]),
        };
    };
}

// ── Skill path builders ───────────────────────────────────────────────────────

// expandHome is imported from config.ts

/**
 * Resolve + dedupe convention dirs, dropping ones that don't exist.
 *
 * Both halves matter, and both fix real startup bugs:
 *
 *  - Dedupe: when the agent is launched from `$HOME`, the `~`-relative and
 *    `<cwd>`-relative entries collapse onto the same directory. pi's
 *    `mergePaths()` dedupes by canonical path, but only *after* we've handed
 *    it the same dir twice under two spellings.
 *  - existsSync: pi reports every non-existent explicit resource path as a red
 *    `error` diagnostic. These convention dirs are optional, so their absence
 *    is normal and must not look like a failure. Paths the user configured
 *    explicitly are NOT filtered here — there, absence is a real mistake and
 *    the error is the point.
 */
function conventionPaths(paths: string[]): string[] {
    const seen = new Set<string>();
    const out: string[] = [];
    for (const p of paths) {
        const resolved = resolve(p);
        if (seen.has(resolved)) continue;
        seen.add(resolved);
        if (existsSync(resolved)) out.push(resolved);
    }
    return out;
}

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
 *
 * USER-scope `skills/` dirs are omitted: pi auto-discovers
 * `~/.pizzapi/skills` and `~/.agents/skills` unconditionally, so naming them
 * again made `loadSkills()` read every `SKILL.md` twice and emit a duplicate
 * `(skipped)` line for each name collision. This also covers the case where
 * `cwd` IS the home dir, which is how the project-scoped entries below collapse
 * onto the user ones.
 *
 * PROJECT-scope `skills/` dirs are still passed even though pi auto-discovers
 * them too, because pi skips project-scoped auto-discovery for UNTRUSTED
 * projects — dropping them would newly trust-gate project skills, a behaviour
 * change tracked separately in Godmother `9py0SHJs`.
 */
export function buildSkillPaths(cwd: string, configSkills?: string[]): string[] {
    // Dirs pi auto-discovers regardless of project trust. Anything resolving to
    // one of these is pure duplication on our side.
    const piUserAutoDirs = new Set([
        resolve(join(homedir(), ".pizzapi", "skills")),
        resolve(join(homedir(), ".agents", "skills")),
    ]);
    const paths: string[] = conventionPaths([
        builtinSkillsDir(),
        join(cwd, ".pizzapi", "skills"),
        join(homedir(), ".pizzapi", "agents"),
        join(cwd, ".pizzapi", "agents"),
        join(cwd, ".agents", "skills"),
        join(cwd, ".agents", "agents"),
    ]).filter((p) => !piUserAutoDirs.has(p));
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
 *   - ~/.pizzapi/commands/       (global commands — Claude Code compatible)
 *   - <cwd>/.pizzapi/commands/   (project-local commands)
 *   - <cwd>/.agents/commands/    (Claude Code compatible project commands)
 *
 * Deliberately NOT included — pi auto-discovers it itself, via
 * `collectAutoPromptEntries()`:
 *   - <cwd>/.pizzapi/prompts/
 *
 * Naming that dir here made pi load every template twice (once as an
 * auto-enabled `*.md` file, once by scanning the parent dir), so
 * `dedupePrompts()` reported each one as colliding with itself — a wall of
 * `"build" collision: ✓ ... ✗ ... (skipped)` at startup. `commands/` dirs
 * stay: `commands` is not one of pi's resource types, so nothing else
 * discovers them.
 */
export function buildPromptTemplatePaths(cwd: string): string[] {
    return conventionPaths([
        join(homedir(), ".pizzapi", "commands"),
        join(cwd, ".pizzapi", "commands"),
        join(cwd, ".agents", "commands"),
    ]);
}
