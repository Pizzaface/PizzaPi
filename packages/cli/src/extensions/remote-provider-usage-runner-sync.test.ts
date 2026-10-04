import { afterAll, expect, test } from "bun:test";
import { mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const dir = mkdtempSync(join(tmpdir(), "usage-sync-"));
const cachePath = join(dir, "usage-cache.json");
const originalCachePath = process.env.PIZZAPI_RUNNER_USAGE_CACHE_PATH;
process.env.PIZZAPI_RUNNER_USAGE_CACHE_PATH = cachePath;
// Query string forces a fresh module instance that reads the env var above.
const freshSpecifier = "./remote-provider-usage.js?runner-sync";
const { syncFromRunnerCacheIfChanged, buildProviderUsage } = (await import(freshSpecifier)) as typeof import("./remote-provider-usage.js");
afterAll(() => {
    if (originalCachePath === undefined) delete process.env.PIZZAPI_RUNNER_USAGE_CACHE_PATH;
    else process.env.PIZZAPI_RUNNER_USAGE_CACHE_PATH = originalCachePath;
    rmSync(dir, { recursive: true, force: true });
});

function writeCache(utilization: number, mtimeSec: number) {
    const now = Date.now();
    writeFileSync(cachePath, JSON.stringify({
        fetchedAt: now,
        providers: { anthropic: { windows: [{ label: "5-hour", utilization, resets_at: new Date(now + 3600_000).toISOString() }], status: "ok", fetchedAt: now, expiresAt: now + 900_000 } },
    }));
    utimesSync(cachePath, mtimeSec, mtimeSec);
}

test("every session picks up daemon rewrites of the runner usage cache", () => {
    expect(syncFromRunnerCacheIfChanged()).toBe(false); // no file yet
    writeCache(10, 1000);
    expect(syncFromRunnerCacheIfChanged()).toBe(true);
    expect(buildProviderUsage().anthropic?.windows[0]?.utilization).toBe(10);
    expect(syncFromRunnerCacheIfChanged()).toBe(false); // unchanged
    writeCache(42, 2000);
    expect(syncFromRunnerCacheIfChanged()).toBe(true);
    expect(buildProviderUsage().anthropic?.windows[0]?.utilization).toBe(42);
});
