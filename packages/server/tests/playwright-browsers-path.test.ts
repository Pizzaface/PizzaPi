import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

// Bun's os.homedir() is resolved once at process start and ignores later
// mutations of process.env.HOME, so "clean HOME" scenarios must be exercised
// in a subprocess launched with the env already set — not by mutating HOME
// in this test process and calling the harness in-process.
function runInFakeHome(fakeHome: string, extraEnv: Record<string, string | undefined> = {}): string {
    const result = Bun.spawnSync({
        cmd: [
            "bun",
            "-e",
            `const { ensurePlaywrightBrowsersPath } = await import("${path.join(
                import.meta.dir,
                "harness/playwright-browsers.ts",
            )}"); ensurePlaywrightBrowsersPath(); process.stdout.write(process.env.PLAYWRIGHT_BROWSERS_PATH ?? "");`,
        ],
        env: { ...process.env, HOME: fakeHome, PLAYWRIGHT_BROWSERS_PATH: undefined, ...extraEnv },
    });
    if (result.exitCode !== 0) {
        throw new Error(`subprocess failed: ${result.stderr.toString()}`);
    }
    return result.stdout.toString().trim();
}

// Mirrors the HOME-derived candidate the harness checks first on this platform.
function homeCacheDir(home: string): string {
    if (process.platform === "darwin") return path.join(home, "Library", "Caches", "ms-playwright");
    return path.join(home, ".cache", "ms-playwright");
}

describe("Playwright browser cache resolution", () => {
    // win32 resolves primarily via LOCALAPPDATA, not HOME, so this fixture doesn't apply there.
    test.skipIf(process.platform === "win32")(
        "resolves a fake browser cache under a clean HOME without touching a real install",
        () => {
            const fakeHome = mkdtempSync(path.join(tmpdir(), "pizzapi-playwright-home-"));
            try {
                const cacheDir = homeCacheDir(fakeHome);
                mkdirSync(path.join(cacheDir, "chromium-1234"), { recursive: true });

                expect(runInFakeHome(fakeHome)).toBe(cacheDir);
            } finally {
                rmSync(fakeHome, { recursive: true, force: true });
            }
        },
    );

    test("preserves an existing PLAYWRIGHT_BROWSERS_PATH override (e.g. '0' or a custom cache)", () => {
        const fakeHome = mkdtempSync(path.join(tmpdir(), "pizzapi-playwright-home-"));
        try {
            expect(runInFakeHome(fakeHome, { PLAYWRIGHT_BROWSERS_PATH: "0" })).toBe("0");
        } finally {
            rmSync(fakeHome, { recursive: true, force: true });
        }
    });

    test.skipIf(process.platform === "win32")(
        "still resolves via HOME when the account lookup throws (e.g. container with no passwd entry)",
        () => {
            const fakeHome = mkdtempSync(path.join(tmpdir(), "pizzapi-playwright-home-"));
            try {
                const cacheDir = homeCacheDir(fakeHome);
                mkdirSync(path.join(cacheDir, "chromium-1234"), { recursive: true });

                const result = Bun.spawnSync({
                    cmd: [
                        "bun",
                        "-e",
                        `const os = (await import("node:os")).default;
                         os.userInfo = () => { throw new Error("no passwd entry for uid"); };
                         const { ensurePlaywrightBrowsersPath } = await import("${path.join(
                             import.meta.dir,
                             "harness/playwright-browsers.ts",
                         )}");
                         ensurePlaywrightBrowsersPath();
                         process.stdout.write(process.env.PLAYWRIGHT_BROWSERS_PATH ?? "");`,
                    ],
                    env: { ...process.env, HOME: fakeHome, PLAYWRIGHT_BROWSERS_PATH: undefined },
                });
                expect(result.exitCode).toBe(0);
                expect(result.stdout.toString().trim()).toBe(cacheDir);
            } finally {
                rmSync(fakeHome, { recursive: true, force: true });
            }
        },
    );
});
