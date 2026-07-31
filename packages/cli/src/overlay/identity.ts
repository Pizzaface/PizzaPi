/**
 * Package identity normalization for the `pi.pizzapi` overlay.
 *
 * Mirrors the identity rules from docs/specs/pi-pizzapi-overlay.md §6.1 /
 * pi 0.82.1 `docs/packages.md` ("Scope and Deduplication"):
 *   - npm:  package name, version stripped
 *   - git:  `host/path`, ref stripped, protocol/SSH forms normalized
 *   - local: resolved canonical absolute path
 *
 * ponytail: pi's own git URL parsing goes through `hosted-git-info` (an
 * upstream-only dependency we don't have access to and won't add). This is
 * a small resolver covering the four documented source forms from
 * docs/packages.md, characterized by identity.test.ts. It is not a full
 * git URL parser — expand if an unsupported form surfaces in practice.
 */
import { realpathSync } from "node:fs";
import { resolve as resolvePath } from "node:path";

export type PackageSourceKind = "npm" | "git" | "local";

export interface PackageIdentity {
    kind: PackageSourceKind;
    /** Normalized identity string, e.g. "npm:@acme/pkg", "git:github.com/user/repo", "local:/abs/path". */
    identity: string;
}

const GIT_PROTOCOL_RE = /^(https?|ssh|git):\/\//i;

function stripVersionSuffix(spec: string): string {
    const atIdx = spec.lastIndexOf("@");
    return atIdx > 0 ? spec.slice(0, atIdx) : spec;
}

function normalizeGitSource(source: string): string {
    let s = source;
    if (s.startsWith("git:")) s = s.slice(4);
    s = s.replace(/^(https?:\/\/|ssh:\/\/|git:\/\/)/i, "");
    s = s.replace(/^git@/, "");
    // scp-like shorthand "host:path" -> "host/path" (only the first colon
    // separates host from path; version refs use "@", not ":").
    s = s.replace(":", "/");
    s = stripVersionSuffix(s);
    s = s.replace(/\.git$/i, "");
    s = s.replace(/\/+$/, "");
    return s.toLowerCase();
}

/**
 * Compute the normalized package identity for a configured source string.
 *
 * `baseDir` resolves relative local paths (matches pi: relative local paths
 * resolve against the settings file's directory — the agent dir for user
 * scope). Prefer `installedPath` from `PackageManager.listConfiguredPackages()`
 * for local packages when available; it is already the upstream-resolved
 * canonical path and avoids re-deriving this resolution ourselves.
 */
export function computePackageIdentity(source: string, baseDir: string = process.cwd()): PackageIdentity {
    const trimmed = source.trim();
    if (trimmed.startsWith("npm:")) {
        return { kind: "npm", identity: `npm:${stripVersionSuffix(trimmed.slice(4).trim())}` };
    }
    if (trimmed.startsWith("git:") || GIT_PROTOCOL_RE.test(trimmed)) {
        return { kind: "git", identity: `git:${normalizeGitSource(trimmed)}` };
    }
    return { kind: "local", identity: `local:${canonicalLocalPath(trimmed, baseDir)}` };
}

/** Resolve a local path to its canonical (symlink-resolved) absolute identity path. */
export function canonicalLocalPath(path: string, baseDir: string = process.cwd()): string {
    const abs = resolvePath(baseDir, path);
    try {
        return realpathSync(abs);
    } catch {
        // Target may not exist yet (or no longer exists) — fall back to the
        // resolved absolute path so identity is still stable and comparable.
        return abs;
    }
}

/** Build a `local:<canonical-path>` identity directly from an already-resolved absolute path. */
export function localIdentityFromResolvedPath(resolvedAbsolutePath: string): string {
    try {
        return `local:${realpathSync(resolvedAbsolutePath)}`;
    } catch {
        return `local:${resolvedAbsolutePath}`;
    }
}
