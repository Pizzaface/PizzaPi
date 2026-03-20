import { readFileSync } from "fs";
import { join } from "path";

const NPM_PACKAGE = "@pizzapi/pizza";
const CACHE_TTL_MS = 15 * 60 * 1000; // 15 minutes
const FAILURE_TTL_MS = 60 * 1000; // 1 minute backoff on failure

/**
 * Version from the CLI package.json, read once at module load.
 * Used as a fallback when PIZZAPI_HUB_VERSION is not injected by compose.
 * Points to CLI package since that's the product release version (not @pizzapi/server).
 */
const LOCAL_PACKAGE_VERSION: string | null = (() => {
    try {
        const pkgPath = join(import.meta.dirname ?? __dirname, "../../cli/package.json");
        const pkg = JSON.parse(readFileSync(pkgPath, "utf-8")) as { version?: string };
        return pkg.version?.trim() || null;
    } catch {
        return null;
    }
})();

let cachedVersion: string | null = null;
let cachedAt = 0;
let lastFailureAt = 0;

/**
 * Fetch the latest published version of @pizzapi/pizza from npm.
 * Caches success for 15 minutes and failures for 1 minute to avoid
 * request amplification when npm is unreachable.
 */
export async function getLatestNpmVersion(): Promise<string | null> {
    const now = Date.now();
    if (cachedVersion && now - cachedAt < CACHE_TTL_MS) {
        return cachedVersion;
    }
    if (lastFailureAt && now - lastFailureAt < FAILURE_TTL_MS) {
        return cachedVersion;
    }

    try {
        const res = await fetch(`https://registry.npmjs.org/${NPM_PACKAGE}/latest`, {
            headers: { Accept: "application/json" },
            signal: AbortSignal.timeout(5000),
        });
        if (!res.ok) {
            lastFailureAt = now;
            return cachedVersion;
        }
        const data = (await res.json()) as { version?: string };
        if (data.version) {
            cachedVersion = data.version;
            cachedAt = now;
            lastFailureAt = 0;
        }
        return cachedVersion;
    } catch {
        lastFailureAt = now;
        return cachedVersion;
    }
}

/**
 * Tag values injected by `resolveComposeMode()` that carry no specific build
 * information — source builds get "local", mutable-tag image deployments get
 * the tag name itself (e.g. "latest", "main"). For these cases the server's
 * own package.json version is more useful to operators than the vague label.
 */
const VAGUE_VERSIONS = new Set([
    "local",
    "local-build",
    "latest",
    "main",
    "stable",
    "dev",
    "nightly",
    "digest",
]);

export function getHubVersionInfo(): { image: string | null; version: string | null } {
    const image = process.env.PIZZAPI_HUB_IMAGE?.trim();
    const version = process.env.PIZZAPI_HUB_VERSION?.trim();
    // Prefer the injected version for specific/pinned references (semver tags,
    // etc.).  For vague labels injected by mutable-tag or source-build paths,
    // fall back to the local package version so operators see the actual build
    // number (e.g. "0.1.32") rather than "latest" or "local".
    const effectiveVersion =
        version && !VAGUE_VERSIONS.has(version) ? version : LOCAL_PACKAGE_VERSION;
    return {
        image: image ? image : null,
        version: effectiveVersion,
    };
}
