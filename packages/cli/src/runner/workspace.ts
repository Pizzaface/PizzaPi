import { lstatSync, realpathSync } from "node:fs";
import { dirname, isAbsolute, parse, resolve } from "node:path";

function parseRoots(raw: string): string[] {
    return raw
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean)
        .map((s) => s.replace(/\\/g, "/"))
        .map((s) => (s.length > 1 ? s.replace(/\/+$/, "") : s));
}

export function getWorkspaceRoots(): string[] {
    // Preferred env vars
    const rootsRaw = process.env.PIZZAPI_WORKSPACE_ROOTS;
    const rootSingle = process.env.PIZZAPI_WORKSPACE_ROOT;

    // Back-compat
    const legacy = process.env.PIZZAPI_RUNNER_ROOTS;

    if (rootsRaw && rootsRaw.trim()) return parseRoots(rootsRaw);
    if (rootSingle && rootSingle.trim()) return parseRoots(rootSingle);
    if (legacy && legacy.trim()) return parseRoots(legacy);
    return [];
}

export function isCwdAllowed(cwd: string | undefined): boolean {
    if (!cwd) return true;
    const roots = getWorkspaceRoots();
    if (roots.length === 0) return true; // unscoped runner
    // Resolve symlinks + normalize ".." segments to prevent path traversal.
    // Prospective (not-yet-existing) paths are canonicalized through their
    // nearest existing ancestor so an in-root symlinked parent cannot smuggle
    // a create operation (e.g. `git worktree add`) outside the roots.
    const canonicalCwd = canonicalizeProspectivePath(cwd);
    if (canonicalCwd === null) return false; // fail closed (e.g. dangling symlink)
    const canonicalize = (p: string) => {
        try { return realpathSync(p); } catch { return resolve(p); }
    };
    const nCwd = canonicalCwd.replace(/\\/g, "/").replace(/\/+$/, "") || "/";
    // Windows paths are case-insensitive
    const isWin = /^[A-Za-z]:/.test(cwd);
    return roots.some((root) => {
        const nRoot = canonicalize(root).replace(/\\/g, "/").replace(/\/+$/, "") || "/";
        // Special-case filesystem root: everything is under "/"
        if (nRoot === "/") return true;
        const rc = isWin ? nCwd.toLowerCase() : nCwd;
        const rr = isWin ? nRoot.toLowerCase() : nRoot;
        return rc === rr || rc.startsWith(rr + "/");
    });
}

/**
 * Canonicalize a path that may not exist yet, following the same symlink
 * semantics the kernel (and tools like git or `mkdir -p`) would apply.
 *
 * Components are resolved left-to-right: every existing component is passed
 * through realpath, so symlinks (including multi-hop chains) are followed and
 * ".." is applied to the *resolved* parent rather than lexically. From the
 * first missing component onward the remainder is appended lexically, since
 * anything created there is a real directory under the resolved parent.
 *
 * Returns null when an existing component cannot be resolved (for example a
 * dangling or looping symlink, which a create operation would follow to an
 * unverified location) so callers can fail closed.
 */
export function canonicalizeProspectivePath(p: string): string | null {
    const abs = isAbsolute(p) ? p : `${process.cwd()}/${p}`;
    const { root } = parse(abs);
    const segments = abs.slice(root.length).split(/[\\/]+/).filter(Boolean);
    const appendSegment = (base: string, seg: string) =>
        /[\\/]$/.test(base) ? base + seg : `${base}/${seg}`;
    let current = root;
    let missing = false;
    for (const seg of segments) {
        if (seg === ".") continue;
        if (seg === "..") {
            current = dirname(current);
            continue;
        }
        const candidate = appendSegment(current, seg);
        if (missing) {
            current = candidate;
            continue;
        }
        try {
            lstatSync(candidate);
        } catch (err) {
            const code = (err as NodeJS.ErrnoException).code;
            if (code !== "ENOENT" && code !== "ENOTDIR") return null;
            missing = true;
            current = candidate;
            continue;
        }
        try {
            current = realpathSync(candidate);
        } catch {
            // Exists but cannot be resolved: dangling/looping symlink or EACCES.
            return null;
        }
    }
    return resolve(current);
}
