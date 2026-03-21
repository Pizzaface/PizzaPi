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
 * Version labels injected by `resolveComposeMode()` for source builds.  These
 * carry no useful version information, so `getHubVersionInfo()` returns null
 * for them and callers (e.g. `/api/hub-info`) substitute the latest published
 * npm version instead.
 *
 * Mutable image tags such as "latest", "main", "stable", etc. are intentionally
 * NOT in this set.  They are returned as-is so the UI shows the actual deployed
 * tag rather than the latest npm release — otherwise the hub badge would
 * misrepresent which image is running (e.g. showing "0.2.0" when the operator
 * deployed `:main` which could be any commit).
 */
const SOURCE_BUILD_LABELS = new Set([
    "local",       // emitted by resolveComposeMode() for source builds
    "local-build", // safety label — should only appear as hubImage, not hubVersion
    "digest",      // fallback when truncateDigest() receives a malformed digest
]);

export function getHubVersionInfo(): { image: string | null; version: string | null } {
    const image = process.env.PIZZAPI_HUB_IMAGE?.trim() || null;
    const rawVersion = process.env.PIZZAPI_HUB_VERSION?.trim() || null;
    // Return null only for source-build labels so callers can fall back to the
    // npm registry version.  Mutable image tags ("latest", "main", etc.) and
    // pinned semver/digest versions are returned verbatim — rewriting a mutable
    // tag with the npm version would misrepresent the deployed image.
    const effectiveVersion = rawVersion && !SOURCE_BUILD_LABELS.has(rawVersion) ? rawVersion : null;
    return {
        image,
        version: effectiveVersion,
    };
}
