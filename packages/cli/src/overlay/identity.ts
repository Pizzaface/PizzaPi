/**
 * Package identity normalization for the `pi.pizzapi` overlay.
 *
 * Mirrors the identity rules from docs/specs/pi-pizzapi-overlay.md §6.1 /
 * pi 0.82.1 `DefaultPackageManager.getPackageIdentity()` (a private method —
 * pinned by identity.test.ts via a narrow test-only cast, not imported here):
 *   - npm:  package name, version stripped
 *   - git:  `host/path`, ref stripped, host lowercased, path case preserved
 *   - local: resolved canonical absolute path, symlinks dereferenced
 *
 * ponytail: pi's own git URL parsing goes through `hosted-git-info` (an
 * upstream-only dependency we don't have access to and won't add). This is
 * a small resolver covering the documented source forms from
 * docs/packages.md (git:/https:/ssh: protocols plus the scp-like
 * `git@host:path` shorthand), characterized against the real upstream
 * `getPackageIdentity()` by identity.test.ts. It is not a full git URL
 * parser — expand if an unsupported form surfaces in practice. Known
 * divergence: upstream's `hosted-git-info` inconsistently skips host
 * lowercasing for some non-documented ssh:// + mixed-case-host combinations;
 * we always lowercase the host, which is the documented/intended behavior.
 */
import { realpathSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve as resolvePath } from "node:path";
import { CONFIG_DIR_NAME } from "@earendil-works/pi-coding-agent";

export type PackageSourceKind = "npm" | "git" | "local";
export type PackageScope = "user" | "project";

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

/** Expand a leading `~` or `~/...` to the user's home directory, matching pi's resolvePath(). */
function expandTilde(input: string): string {
    if (input === "~") return homedir();
    if (input.startsWith("~/") || input.startsWith("~\\")) return join(homedir(), input.slice(2));
    return input;
}

/**
 * Split a non-protocol git source (after any `git:`/user-info prefix has
 * been considered) into host/path at the first `:` (scp-like shorthand,
 * e.g. "github.com:user/repo") or the first `/` (bare shorthand, e.g.
 * "github.com/user/repo") — whichever comes first, matching pi's own
 * scp-like-then-bare parsing order.
 */
function splitHostPath(rest: string): { host: string; path: string } {
    const withoutUserInfo = rest.replace(/^[^@/:]+@/, "");
    const colonIdx = withoutUserInfo.indexOf(":");
    const slashIdx = withoutUserInfo.indexOf("/");
    if (colonIdx >= 0 && (slashIdx < 0 || colonIdx < slashIdx)) {
        return { host: withoutUserInfo.slice(0, colonIdx), path: withoutUserInfo.slice(colonIdx + 1) };
    }
    if (slashIdx >= 0) {
        return { host: withoutUserInfo.slice(0, slashIdx), path: withoutUserInfo.slice(slashIdx + 1) };
    }
    return { host: withoutUserInfo, path: "" };
}

function normalizeGitSource(source: string): string {
    let s = source.trim();
    if (s.startsWith("git:")) s = s.slice(4).trim();

    let host: string;
    let path: string;
    if (GIT_PROTOCOL_RE.test(s)) {
        try {
            const url = new URL(s);
            host = url.hostname; // URL strips the port automatically — handles ssh://host:port/path.
            path = url.pathname.replace(/^\/+/, "");
        } catch {
            ({ host, path } = splitHostPath(s));
        }
    } else {
        ({ host, path } = splitHostPath(s));
    }

    path = stripVersionSuffix(path);
    path = path.replace(/\.git$/i, "");
    return `${host.toLowerCase()}/${path}`;
}

/**
 * Compute the normalized package identity for a configured source string.
 *
 * `baseDir` resolves relative local paths and must be the same scope-aware
 * base pi itself uses: the agent dir for user-scope packages, or
 * `<cwd>/.pizzapi` (pi's `CONFIG_DIR_NAME`) for project-scope packages. See
 * `packageScopeBaseDir()`. Prefer `installedPath` from
 * `PackageManager.listConfiguredPackages()` for local packages when
 * available; it is already the upstream-resolved path.
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
    const abs = resolvePath(baseDir, expandTilde(path.trim()));
    try {
        return realpathSync(abs);
    } catch {
        // Target may not exist yet (or no longer exists) — fall back to the
        // resolved absolute path so identity is still stable and comparable.
        return abs;
    }
}

/**
 * The base directory pi resolves relative local package paths against for a
 * given scope — matches `DefaultPackageManager.getBaseDirForScope()`
 * exactly: the agent dir for user scope, `<cwd>/.pizzapi` for project scope.
 */
export function packageScopeBaseDir(scope: PackageScope, cwd: string, agentDir: string): string {
    return scope === "project" ? join(cwd, CONFIG_DIR_NAME) : agentDir;
}
