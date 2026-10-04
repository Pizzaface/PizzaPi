import { describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

describe("runner-usage-cache", () => {
    test("reads claude-subscription OAuth credentials for Anthropic usage", () => {
        const repoRoot = join(import.meta.dir, "../../../..");
        const runnerSrcDir = import.meta.dir.includes("/dist/runner")
            ? import.meta.dir.replace("/dist/runner", "/src/runner")
            : import.meta.dir;
        const childTestPath = join(runnerSrcDir, `.runner-usage-cache-claude-subscription-${Date.now()}-${Math.random().toString(16).slice(2)}.test.ts`);
        const home = mkdtempSync(join(tmpdir(), "runner-usage-credentials-"));
        try {
            writeFileSync(childTestPath, `
import { expect, mock, test } from "bun:test";
import { join } from "node:path";

const calls: string[] = [];
mock.module("@earendil-works/pi-coding-agent", () => ({
    readStoredCredential: (providerId: string) => {
        calls.push(providerId);
        return providerId === "claude-subscription" ? { type: "oauth", access: "subscription-token" } : undefined;
    },
}));
mock.module("../config.js", () => ({
    loadConfig: () => ({}),
    defaultAgentDir: () => join(process.cwd(), ".agent"),
    expandHome: (input: string) => input,
}));
mock.module("./usage-auth.js", () => ({
    getOAuthAccessToken: (raw: any) => raw?.access ?? null,
    getAnthropicKeychainToken: () => null,
}));
mock.module("./logger.js", () => ({ logInfo: () => {}, logWarn: () => {} }));

test("claude-subscription auth backs Anthropic usage", async () => {
    let auth = "";
    globalThis.fetch = async (_url: string | URL | Request, init?: RequestInit) => {
        auth = String((init?.headers as Record<string, string>)?.Authorization ?? "");
        return { ok: true, json: async () => ({ five_hour: { utilization: 1, resets_at: "2026-01-01T00:00:00.000Z" } }) } as Response;
    };
    const { getRunnerAnthropicUsageData } = await import("./runner-usage-cache.ts");
    const data = await getRunnerAnthropicUsageData({ force: true });
    expect(calls).toContain("anthropic");
    expect(calls).toContain("claude-subscription");
    expect(auth).toBe("Bearer subscription-token");
    expect(data?.status).toBe("ok");
    expect(typeof data?.fetchedAt).toBe("number");
    expect(data?.checkedAt).toBe(data?.fetchedAt);
    expect(typeof data?.expiresAt).toBe("number");
    const originalNow = Date.now;
    const now = Date.now();
    globalThis.fetch = async () => ({ ok: false, status: 429 }) as Response;
    expect((await getRunnerAnthropicUsageData({ force: true }))?.status).toBe("unknown");
    Date.now = () => now + 60_001;
    globalThis.fetch = async () => ({ ok: true, json: async () => ({ five_hour: { utilization: 2, resets_at: "2099-01-01T00:00:00Z" } }) }) as Response;
    expect((await getRunnerAnthropicUsageData())?.status).toBe("ok");
    Date.now = originalNow;
});
`);
            execFileSync(process.execPath, ["test", childTestPath], { cwd: repoRoot, env: { ...process.env, HOME: home }, encoding: "utf-8", stdio: ["ignore", "pipe", "pipe"] });
            expect(true).toBe(true);
        } finally {
            rmSync(childTestPath, { force: true });
            rmSync(home, { recursive: true, force: true });
        }
    });

    test("refreshes usage data with tracked cwd auth paths and drops them after untracking", () => {
        const repoRoot = join(import.meta.dir, "../../../..");
        const tmpHome = mkdtempSync(join(tmpdir(), "runner-usage-cache-test-"));

        // Always write the child test file into the **source** tree (src/runner/)
        // so that its relative `import("./runner-usage-cache.ts")` and
        // `mock.module("../config.js")` etc. resolve to the correct source modules.
        // This also makes the test correct when bun discovers and runs the compiled
        // dist/runner/runner-usage-cache.test.js from the project root.
        const runnerSrcDir = import.meta.dir.includes("/dist/runner")
            ? import.meta.dir.replace("/dist/runner", "/src/runner")
            : import.meta.dir;
        const childTestPath = join(runnerSrcDir, `.runner-usage-cache-child-${Date.now()}-${Math.random().toString(16).slice(2)}.test.ts`);

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

        mock.module("@earendil-works/pi-coding-agent", () => ({
            readStoredCredential: (_providerId: string, authPath: string) => {
                authCreateCalls.push(authPath);
                return { type: "oauth", access: authPath };
            },
        }));

        mock.module("../config.js", () => ({
            loadConfig: (cwd: string) => ({ agentDir: projectAgentDirByCwd.get(cwd) }),
            defaultAgentDir: () => join(home, ".pizzapi", "agent"),
            expandHome: (input: string) => input.replace(/^~(?=\\/|$)/, home),
        }));

        mock.module("./usage-auth.js", () => ({
            getOAuthAccessToken: (raw: any) => {
                // Return token only for anthropic
                if (!raw || raw.type !== "oauth" || !raw.access.includes("custom-agent-dir")) return null;
                return "token:" + raw.access;
            },
            getAnthropicKeychainToken: () => null,
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
            getRunnerAnthropicUsageData,
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
        expect(firstCache.providers.anthropic).toMatchObject({
            status: "ok",
            windows: [
                {
                    label: "5-hour",
                    utilization: 42,
                    resets_at: "2026-01-01T00:00:00.000Z",
                },
            ],
        });
        expect(typeof firstCache.providers.anthropic.fetchedAt).toBe("number");
        expect(firstCache.providers.anthropic.checkedAt).toBe(firstCache.providers.anthropic.fetchedAt);
        expect(firstCache.providers.anthropic.expiresAt).toBeGreaterThan(firstCache.providers.anthropic.fetchedAt);

        globalThis.fetch = async () => { throw new Error("temporary outage"); };
        expect(await getRunnerAnthropicUsageData({ force: true })).toMatchObject({
            windows: firstCache.providers.anthropic.windows,
            status: "unknown",
            fetchedAt: firstCache.providers.anthropic.fetchedAt,
            expiresAt: firstCache.providers.anthropic.expiresAt,
        });

        globalThis.fetch = async () => ({
            ok: true,
            json: async () => ({
                five_hour: { utilization: 42, resets_at: "2026-01-01T00:00:00.000Z" },
            }),
        }) as Response;
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

import { singleFlight } from "./runner-usage-cache.js";

describe("singleFlight", () => {
  test("concurrent calls coalesce into one in-flight execution", async () => {
    let calls = 0;
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const fn = singleFlight(async () => {
      calls++;
      await gate;
    });

    const p1 = fn();
    const p2 = fn();
    const p3 = fn();
    expect(p2).toBe(p1);
    expect(p3).toBe(p1);
    expect(calls).toBe(1);

    release();
    await p1;

    // After completion a new call runs again
    await fn();
    expect(calls).toBe(2);
  });

  test("a rejected in-flight run clears the guard", async () => {
    let calls = 0;
    const fn = singleFlight(async () => {
      calls++;
      if (calls === 1) throw new Error("boom");
    });

    await expect(fn()).rejects.toThrow("boom");
    await fn(); // must not stay stuck on the failed promise
    expect(calls).toBe(2);
  });
});
