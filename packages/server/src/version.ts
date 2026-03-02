const NPM_PACKAGE = "@pizzapi/pizza";
const CACHE_TTL_MS = 15 * 60 * 1000; // 15 minutes

let cachedVersion: string | null = null;
let cachedAt = 0;

/**
 * Fetch the latest published version of @pizzapi/pizza from npm.
 * Caches the result for 15 minutes to avoid hammering the registry.
 */
export async function getLatestNpmVersion(): Promise<string | null> {
    const now = Date.now();
    if (cachedVersion && now - cachedAt < CACHE_TTL_MS) {
        return cachedVersion;
    }

    try {
        const res = await fetch(`https://registry.npmjs.org/${NPM_PACKAGE}/latest`, {
            headers: { Accept: "application/json" },
            signal: AbortSignal.timeout(5000),
        });
        if (!res.ok) return cachedVersion;
        const data = (await res.json()) as { version?: string };
        if (data.version) {
            cachedVersion = data.version;
            cachedAt = now;
        }
        return cachedVersion;
    } catch {
        return cachedVersion;
    }
}
