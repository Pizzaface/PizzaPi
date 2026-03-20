import { realpathSync } from "node:fs";
import { resolve } from "node:path";

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
    // Use realpathSync when the path exists (resolves symlinks), fall back
    // to resolve() for non-existent paths (still collapses "..").
    const canonicalize = (p: string) => {
        try { return realpathSync(p); } catch { return resolve(p); }
    };
    const nCwd = canonicalize(cwd).replace(/\\/g, "/").replace(/\/+$/, "") || "/";
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
