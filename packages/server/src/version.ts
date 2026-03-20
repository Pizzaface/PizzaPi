const NPM_PACKAGE = "@pizzapi/pizza";
const CACHE_TTL_MS = 15 * 60 * 1000; // 15 minutes
const FAILURE_TTL_MS = 60 * 1000; // 1 minute backoff on failure

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
 * the tag name itself (e.g. "latest", "main"). These are considered vague:
 * `getHubVersionInfo()` returns null for them so callers can substitute the
 * latest published npm version instead of a stale local package.json value.
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
    // Only return the injected version when it is a specific/pinned reference
    // (semver tag, digest abbreviation, etc.).  For vague labels like "latest",
    // "local", or "main" we return null so callers can fall back to the npm
    // registry version via getLatestNpmVersion() — the server's own
    // package.json is NOT stamped during the release workflow (only
    // packages/cli and packages/npm are), so it would permanently report a
    // stale version for source builds and mutable-tag deployments.
    const effectiveVersion = version && !VAGUE_VERSIONS.has(version) ? version : null;
    return {
        image: image ? image : null,
        version: effectiveVersion,
    };
}
