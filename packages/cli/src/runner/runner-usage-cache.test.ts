import { describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

describe("runner-usage-cache", () => {
    test("refreshes usage data with tracked cwd auth paths and drops them after untracking", () => {
        const repoRoot = join(import.meta.dir, "../../../..");
        const tmpHome = mkdtempSync(join(tmpdir(), "runner-usage-cache-test-"));
        const childTestPath = join(import.meta.dir, `.runner-usage-cache-child-${Date.now()}-${Math.random().toString(16).slice(2)}.test.ts`);

        try {
            writeFileSync(
                childTestPath,
                `
import { describe, expect, mock, test } from "bun:test";
import { join } from "node:path";
import { homedir } from "node:os";

describe("runner-usage-cache child", () => {
    test("tracks project-local auth paths across refreshes", async () => {
        const authCreateCalls: string[] = [];
        const home = homedir();
        const projectCwd = join(home, "project");
        const projectAgentDirByCwd = new Map([[projectCwd, "~/custom-agent-dir"]]);

        mock.module("@mariozechner/pi-coding-agent", () => ({
            AuthStorage: {
                create: (authPath: string) => {
                    authCreateCalls.push(authPath);
                    return {
                        authPath,
                        getApiKey: async () => undefined,
                    };
                },
            },
        }));

        mock.module("../config.js", () => ({
            loadConfig: (cwd: string) => ({ agentDir: projectAgentDirByCwd.get(cwd) }),
            defaultAgentDir: () => join(home, ".pizzapi", "agent"),
            expandHome: (input: string) => input.replace(/^~(?=\\/|$)/, home),
        }));

        mock.module("./usage-auth.js", () => ({
            getRefreshedOAuthToken: async (storage: { authPath: string }, provider: string) =>
                provider === "anthropic" ? "token:" + storage.authPath : null,
            parseGeminiQuotaCredential: () => null,
        }));

        mock.module("./logger.js", () => ({
            logInfo: () => {},
            logWarn: () => {},
        }));

        globalThis.fetch = async () => ({
            ok: true,
            json: async () => ({
                five_hour: {
                    utilization: 42,
                    resets_at: "2026-01-01T00:00:00.000Z",
                },
            }),
        }) as Response;

        const {
            runnerUsageCacheFilePath,
            startUsageRefreshLoop,
            stopUsageRefreshLoop,
            trackSessionCwd,
            untrackSessionCwd,
        } = await import("./runner-usage-cache.ts");

        const { existsSync, mkdirSync, readFileSync, rmSync } = await import("node:fs");
        mkdirSync(join(home, ".pizzapi"), { recursive: true });

        async function waitForWrite(cachePath: string) {
            for (let i = 0; i < 400; i++) {
                if (existsSync(cachePath)) return readFileSync(cachePath, "utf-8");
                await new Promise((resolve) => setTimeout(resolve, 10));
            }
            throw new Error("Timed out waiting for usage cache write");
        }

        const cachePath = runnerUsageCacheFilePath();
        expect(cachePath).toBe(join(home, ".pizzapi", "usage-cache.json"));

        trackSessionCwd("sess-1", projectCwd);
        startUsageRefreshLoop();
        const firstWrite = await waitForWrite(cachePath);
        stopUsageRefreshLoop();

        const authPathsWhileTracked = new Set(authCreateCalls);
        expect(authPathsWhileTracked).toContain(join(home, ".pizzapi", "agent", "auth.json"));
        expect(authPathsWhileTracked).toContain(join(home, "custom-agent-dir", "auth.json"));

        const firstCache = JSON.parse(firstWrite);
        expect(firstCache.providers.anthropic.windows).toEqual([
            {
                label: "5-hour",
                utilization: 42,
                resets_at: "2026-01-01T00:00:00.000Z",
            },
        ]);

        authCreateCalls.length = 0;
        rmSync(cachePath, { force: true });
        untrackSessionCwd("sess-1", projectCwd);
        startUsageRefreshLoop();
        await waitForWrite(cachePath);
        stopUsageRefreshLoop();

        const authPathsAfterUntrack = new Set(authCreateCalls);
        expect(authPathsAfterUntrack).toContain(join(home, ".pizzapi", "agent", "auth.json"));
        expect(authPathsAfterUntrack).not.toContain(join(home, "custom-agent-dir", "auth.json"));
    });
});
`,
            );

            execFileSync(process.execPath, ["test", childTestPath], {
                cwd: repoRoot,
                encoding: "utf-8",
                env: {
                    ...process.env,
                    HOME: tmpHome,
                    USERPROFILE: tmpHome,
                },
                stdio: ["ignore", "pipe", "pipe"],
            });

            expect(true).toBe(true);
        } finally {
            rmSync(childTestPath, { force: true });
            rmSync(tmpHome, { recursive: true, force: true });
        }
    });
});
