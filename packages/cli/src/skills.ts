/**
 * Skill discovery and management utilities.
 *
 * Extracted from daemon.ts and the CLI/worker entry points so the logic
 * is independently testable.
 */
import { existsSync, lstatSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { expandHome } from "./config.js";
import { parseFrontmatterDescription } from "./frontmatter.js";
import { escapePromptXml } from "./prompt-escape.js";

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

/**
 * Lstat every path component between `root` and `path` (directories AND the
 * final entry), rejecting if any of them is a symlink.
 *
 * A plain `lstatSync(path)` only tells you whether the *final* component is a
 * symlink — intermediate directory components are still followed by the OS when
 * resolving the rest of the path. That means a hostile repo can ship a directory
 * symlink (e.g. `.agents -> /Users/victim/Documents` or `.pizzapi -> /elsewhere`)
 * and every entry-level `lstatSync` on files inside it comes back looking like a
 * plain file, because by the time lstat runs the OS has already walked through
 * the symlinked directory to get there. Walking component-by-component from a
 * trusted `root` and lstatting each *prefix* (not the fully-resolved final path)
 * catches that: once we've verified a prefix isn't a symlink, resolving the next
 * segment against it is accurate.
 *
 * `root` bounds the walk deliberately: we only want to validate the path
 * components a hostile repo could control (under the project cwd, or under
 * `~/.pizzapi`), not every ancestor up to the filesystem root. Walking all the
 * way up would also trip over legitimate OS-level symlinks outside anyone's
 * control (e.g. macOS's `/var` -> `/private/var`, or `/tmp` -> `/private/tmp`,
 * which every tmp-dir-based test and runtime path sits under).
 *
 * If `path` isn't actually under `root` (e.g. an ancestor-directory AGENTS.md
 * above cwd, found via upstream's own ancestor walk), fall back to just
 * checking `path`'s own final component plus its immediate parent — enough to
 * catch "the file itself, or the directory holding it, is a symlink" without
 * walking arbitrarily far up the tree.
 */
function isSafePath(root: string, path: string): boolean {
    const rel = relative(root, path);
    if (rel && !rel.startsWith(`..${sep}`) && rel !== "..") {
        let current = root;
        for (const part of rel.split(sep)) {
            current = join(current, part);
            try {
                if (lstatSync(current).isSymbolicLink()) return false;
            } catch {
                return true; // missing/unreadable; let the caller's existsSync/readFileSync handle it
            }
        }
        return true;
    }
    // path === root, or path isn't under root at all — bound the check to just
    // the entry itself and its immediate parent directory.
    for (const candidate of [path, dirname(path)]) {
        try {
            if (lstatSync(candidate).isSymbolicLink()) return false;
        } catch {
            return true;
        }
    }
    return true;
}

/**
 * Load direct markdown rule files from a directory in lexicographic order.
 *
 * `root` bounds the symlink walk (defaults to `dir` itself, i.e. only check
 * whether `dir` is a symlink, not its ancestors) — pass the directory ABOVE
 * `dir` that the caller trusts (cwd or homedir) so a symlinked intermediate
 * component like `.pizzapi` is caught too. See `isSafePath` for why the walk
 * must be bounded rather than going all the way to the filesystem root.
 */
export function loadRulesDir(dir: string, root: string = dir): AgentFile[] {
    // Walks every component between `root` and `dir` (e.g. both `.pizzapi` and
    // `.pizzapi/rules`), so a symlinked directory anywhere on the way is rejected
    // before we ever readdir it.
    if (!existsSync(dir) || !isSafePath(root, dir)) return [];
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
            // lstatSync: a symlink never reports isFile() true, so this alone skips symlinks.
            const s = lstatSync(path);
            if (!s.isFile()) continue;
            files.push({ path, content: readFileSync(path, "utf-8") });
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
        global: loadRulesDir(join(homedir(), ".pizzapi", "rules"), homedir()),
        project: loadRulesDir(join(cwd, ".pizzapi", "rules"), cwd),
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
    try {
        // isSafePath rejects both a symlinked AGENTS.md and a symlinked ancestor dir.
        if (isSafePath(cwd, agentsMdPath)) {
            const s = lstatSync(agentsMdPath);
            if (s.isFile()) {
                const content = readFileSync(agentsMdPath, "utf-8");
                files.push({ path: agentsMdPath, content });
            }
        }
    } catch {
        // Skip missing or unreadable files
    }

    // Load .agents/*.md from cwd
    const dotAgentsDir = join(cwd, ".agents");
    // isSafePath walks every component, catching `.agents` itself being a symlinked dir.
    if (existsSync(dotAgentsDir) && isSafePath(cwd, dotAgentsDir)) {
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
                // lstatSync: a symlink never reports isFile() true, so this alone skips symlinks.
                const s = lstatSync(filePath);
                if (!s.isFile()) continue;
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
    const sanitizeAgentFile = (file: AgentFile): AgentFile => ({
        path: escapePromptXml(file.path),
        content: escapePromptXml(file.content),
    });

    return (base) => {
        // The upstream `DefaultResourceLoader` discovers this base list with a plain
        // `statSync` (follows symlinks), so a symlinked cwd/AGENTS.md, CLAUDE.md,
        // AGENTS.override.md, or ancestor-dir context file would otherwise reach the
        // prompt untouched by our own symlink guards, which only cover the files WE
        // load. Re-filter here so nothing symlinked survives regardless of name.
        //
        // Bound each file's symlink walk to whichever trusted root it lives under
        // (the project cwd, or `~/.pizzapi`); files from neither (e.g. an
        // ancestor-directory AGENTS.md above cwd) fall back inside `isSafePath`
        // to checking just the file and its immediate parent.
        const home = homedir();
        const rootFor = (path: string) => (path === home || path.startsWith(home + sep) ? home : cwd);
        const safeAgentsFiles = base.agentsFiles.filter((file) => isSafePath(rootFor(file.path), file.path));
        const baseFiles = sendAgentsMd
            ? safeAgentsFiles
            : safeAgentsFiles.filter((file) => !isAgentsMdPath(file.path));
        const seenPaths = new Set<string>();
        const unique = (files: AgentFile[]) => files.filter((file) => {
            if (seenPaths.has(file.path)) return false;
            seenPaths.add(file.path);
            return true;
        });
        if (!sendAgentsMd) return { agentsFiles: unique([...baseFiles, ...additionalFiles]).map(sanitizeAgentFile) };

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
            ]).map(sanitizeAgentFile),
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
 *   - <cwd>/.pizzapi/skills/    (project-local PizzaPi skills — only when projectTrusted)
 *   - ~/.pizzapi/agents/        (global agents treated as skills)
 *   - <cwd>/.pizzapi/agents/    (project-local agents treated as skills — only when projectTrusted)
 *   - <cwd>/.agents/skills/     (Claude Code compatible project skills — only when projectTrusted)
 *   - <cwd>/.agents/agents/     (Claude Code compatible project agents — only when projectTrusted)
 *   - Paths declared in config.skills
 *
 * USER-scope `skills/` dirs are omitted: pi auto-discovers
 * `~/.pizzapi/skills` and `~/.agents/skills` unconditionally, so naming them
 * again made `loadSkills()` read every `SKILL.md` twice and emit a duplicate
 * `(skipped)` line for each name collision. This also covers the case where
 * `cwd` IS the home dir, which is how the project-scoped entries below collapse
 * onto the user ones.
 *
 * PROJECT-scope `skills/`/`agents/` dirs are only added when `projectTrusted`
 * is true. pi itself skips project-scoped auto-discovery for UNTRUSTED
 * projects; PizzaPi previously passed these dirs via `additionalSkillPaths`
 * regardless of trust, which upstream merges unconditionally and so bypassed
 * pi's own gate (Godmother `9py0SHJs`). Fails closed: an undecided or
 * explicitly-untrusted repo gets none of the project-scope dirs below. Global
 * `~/.pizzapi/agents` and the built-in dir are unaffected — they're not
 * project-controlled.
 */
export function buildSkillPaths(cwd: string, configSkills?: string[], projectTrusted = false): string[] {
    // Dirs pi auto-discovers regardless of project trust. Anything resolving to
    // one of these is pure duplication on our side.
    const piUserAutoDirs = new Set([
        resolve(join(homedir(), ".pizzapi", "skills")),
        resolve(join(homedir(), ".agents", "skills")),
    ]);
    const userScopeDirs = [builtinSkillsDir(), join(homedir(), ".pizzapi", "agents")];
    const projectScopeDirs = projectTrusted
        ? [join(cwd, ".pizzapi", "skills"), join(cwd, ".pizzapi", "agents"), join(cwd, ".agents", "skills"), join(cwd, ".agents", "agents")]
        : [];
    const paths: string[] = conventionPaths([...userScopeDirs, ...projectScopeDirs]).filter((p) => !piUserAutoDirs.has(p));
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
 *   - <cwd>/.pizzapi/commands/   (project-local commands — only when projectTrusted)
 *   - <cwd>/.agents/commands/    (Claude Code compatible project commands — only when projectTrusted)
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
 *
 * PROJECT-scope `commands/` dirs are only added when `projectTrusted` is
 * true — same bypass class and same fix as `buildSkillPaths` (Godmother
 * `9py0SHJs` / `EN1UeiFK`): these are project-controlled, and upstream
 * merges `additionalPromptTemplatePaths` with no trust check of its own, so
 * an untrusted repo's `.pizzapi/commands`/`.agents/commands` would otherwise
 * still load and run as slash commands. Fails closed: an undecided or
 * explicitly-untrusted repo gets none of the project-scope dirs below. The
 * global `~/.pizzapi/commands` dir is unaffected — it's not project-controlled.
 */
export function buildPromptTemplatePaths(cwd: string, projectTrusted = false): string[] {
    return conventionPaths([
        join(homedir(), ".pizzapi", "commands"),
        ...(projectTrusted ? [join(cwd, ".pizzapi", "commands"), join(cwd, ".agents", "commands")] : []),
    ]);
}
