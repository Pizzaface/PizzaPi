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
    if (!cachedVersion && lastFailureAt && now - lastFailureAt < FAILURE_TTL_MS) {
        return null;
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
