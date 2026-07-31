/**
 * Session-side `pi.pizzapi` overlay mounting — resolves configured pi
 * packages (both user and project scope; see docs/specs/pi-pizzapi-overlay.md
 * §9.1) and exposes their validated `agents`/`rules`/`mcp` declarations to
 * the extensions that mount them (subagent-agents.ts, the rules
 * before_agent_start extension, and the MCP registry).
 *
 * Unlike `runner/package-service-loader.ts` (daemon services, user-scope
 * only), session-side capabilities are session-process code that already
 * runs with the session's execution rights, so BOTH user- and project-scope
 * packages contribute here once pi's own project-trust gate has let the
 * package's native resources load (§4.3: "A package extension already has
 * arbitrary session-process execution rights.").
 *
 * A malformed overlay is skipped as a unit with a provenance-rich warning —
 * it never throws, so a broken package overlay can never take down session
 * startup or block that package's pi-native resources (§5.2, §10.1).
 */
import { lstatSync, readdirSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import type { PizzaPiOverlayV1 } from "@pizzapi/extension-sdk";
import { createLogger } from "@pizzapi/tools";
import { listDedupedConfiguredPackages } from "./resolve.js";
import { formatOverlayIssue, readOverlayManifest, resolveConfinedPath } from "./manifest.js";
import { readFileCapped, MAX_ENTRIES_PER_DIR } from "../plugins/types.js";

const log = createLogger("overlay/session");

export interface ResolvedOverlayPackage {
    identity: string;
    source: string;
    scope: "user" | "project";
    /** Installed package root — overlay paths are package-relative to this. */
    installedPath: string;
    overlay: PizzaPiOverlayV1;
}

export interface SessionOverlayResolution {
    /** Valid overlays only, in stable settings order (project-over-user deduped). */
    packages: ResolvedOverlayPackage[];
    warnings: string[];
}

/**
 * Resolve every configured (user + project scope) pi package's validated
 * `pi.pizzapi` overlay. Packages without an overlay, or with an invalid one,
 * are omitted from `packages` — invalid overlays instead produce a
 * provenance-rich warning and never block that package's pi-native
 * resources (which pi mounts independently of this module).
 */
export function resolveSessionOverlays(cwd: string, agentDir: string): SessionOverlayResolution {
    const warnings: string[] = [];
    let deduped: ReturnType<typeof listDedupedConfiguredPackages>;
    try {
        deduped = listDedupedConfiguredPackages(cwd, agentDir);
    } catch (err) {
        warnings.push(`overlay: failed to resolve configured packages: ${err instanceof Error ? err.message : String(err)}`);
        return { packages: [], warnings };
    }

    const packages: ResolvedOverlayPackage[] = [];
    for (const { identity, pkg } of deduped) {
        if (!pkg.installedPath) continue; // configured but not installed — non-interactive skip, no prompt
        const provenance = { identity, source: pkg.source, scope: pkg.scope };
        let result: ReturnType<typeof readOverlayManifest>;
        try {
            result = readOverlayManifest(pkg.installedPath, provenance);
        } catch (err) {
            warnings.push(`[${identity}] failed to read overlay: ${err instanceof Error ? err.message : String(err)}`);
            continue;
        }
        if (result.present && !result.overlay) {
            for (const issue of result.issues) warnings.push(formatOverlayIssue(issue));
            continue;
        }
        if (!result.overlay) continue;
        packages.push({ identity, source: pkg.source, scope: pkg.scope, installedPath: pkg.installedPath, overlay: result.overlay });
    }

    for (const w of warnings) log.warn(w);
    return { packages, warnings };
}

/**
 * Resolve an overlay's package-relative `agents`/`rules` entries to
 * confined absolute paths, split into directories and single `.md` files.
 * Entries that fail re-validation (moved/removed since manifest read) are
 * dropped with a warning rather than throwing.
 */
export function splitPathEntries(entries: string[] | undefined, packageRoot: string, identity: string, field: string): { dirs: string[]; files: string[] } {
    const dirs: string[] = [];
    const files: string[] = [];
    for (const entry of entries ?? []) {
        const resolved = resolveConfinedPath(packageRoot, entry);
        if (!resolved.ok) {
            log.warn(`[${identity}] ${field} entry "${entry}" failed re-validation: ${resolved.message}`);
            continue;
        }
        let isDir = false;
        try {
            isDir = statSync(resolved.absolutePath).isDirectory();
        } catch {
            continue;
        }
        if (isDir) dirs.push(resolved.absolutePath);
        else files.push(resolved.absolutePath);
    }
    return { dirs, files };
}

/**
 * Collect overlay agent directories, partitioned by scope, for
 * `subagent-agents.ts`'s `extraUserDirs`/`extraProjectDirs`.
 *
 * ponytail: a single `.md` file entry is folded in via its containing
 * directory (loadAgentsFromDir scans a directory, not one file) rather than
 * adding a parallel single-file loading path to subagent-agents.ts. This
 * means sibling `.md` files in that same directory are also picked up.
 * Upgrade to per-file loading if a package needs to declare one agent file
 * alongside unrelated markdown in the same directory.
 */
export function collectOverlayAgentDirs(cwd: string, agentDir: string): { userDirs: string[]; projectDirs: string[] } {
    const { packages } = resolveSessionOverlays(cwd, agentDir);
    const userDirs: string[] = [];
    const projectDirs: string[] = [];
    for (const pkg of packages) {
        if (!pkg.overlay.agents?.length) continue;
        const { dirs, files } = splitPathEntries(pkg.overlay.agents, pkg.installedPath, pkg.identity, "agents");
        const allDirs = [...dirs, ...new Set(files.map((f) => dirname(f)))];
        if (pkg.scope === "user") userDirs.push(...allDirs);
        else projectDirs.push(...allDirs);
    }
    return { userDirs, projectDirs };
}

/** Recursively collect `.md` files under `dir` (symlink-safe, entry-capped — mirrors plugins/parse.ts conventions). */
function collectMarkdownFilesRecursive(dir: string, out: string[], depth = 0): void {
    if (depth > 10 || out.length >= MAX_ENTRIES_PER_DIR) return;
    let entries: string[];
    try {
        entries = readdirSync(dir);
    } catch {
        return;
    }
    for (const entry of entries) {
        if (out.length >= MAX_ENTRIES_PER_DIR) return;
        const entryPath = join(dir, entry);
        let st;
        try {
            st = lstatSync(entryPath);
        } catch {
            continue;
        }
        if (st.isSymbolicLink()) continue; // never follow symlinks out of the package root
        if (st.isDirectory()) {
            collectMarkdownFilesRecursive(entryPath, out, depth + 1);
        } else if (st.isFile() && entry.toLowerCase().endsWith(".md")) {
            out.push(entryPath);
        }
    }
}

export interface OverlayRuleBlock {
    identity: string;
    scope: "user" | "project";
    /** Markdown section text, ready to append to the system prompt. */
    text: string;
}

/**
 * Build one Markdown section per package that declares `pi.pizzapi.rules`,
 * in mount order: all user-scope package rules first, then all
 * project-scope package rules, each preserving stable settings order within
 * its scope (§4.3: "User-package rules are injected before project-package
 * rules; settings order is preserved within each scope.").
 */
export function collectOverlayRuleBlocks(cwd: string, agentDir: string): OverlayRuleBlock[] {
    const { packages } = resolveSessionOverlays(cwd, agentDir);
    const build = (pkg: ResolvedOverlayPackage): OverlayRuleBlock | null => {
        if (!pkg.overlay.rules?.length) return null;
        const { dirs, files } = splitPathEntries(pkg.overlay.rules, pkg.installedPath, pkg.identity, "rules");
        const mdFiles: string[] = [...files];
        for (const dir of dirs) collectMarkdownFilesRecursive(dir, mdFiles);
        const parts: string[] = [];
        for (const file of mdFiles) {
            const content = readFileCapped(file);
            if (content === null) continue;
            parts.push(content.trim());
        }
        if (parts.length === 0) return null;
        return {
            identity: pkg.identity,
            scope: pkg.scope,
            text: `## [${pkg.identity}]\n\n${parts.join("\n\n")}`,
        };
    };

    const blocks: OverlayRuleBlock[] = [];
    for (const pkg of packages.filter((p) => p.scope === "user")) {
        const block = build(pkg);
        if (block) blocks.push(block);
    }
    for (const pkg of packages.filter((p) => p.scope === "project")) {
        const block = build(pkg);
        if (block) blocks.push(block);
    }
    return blocks;
}
