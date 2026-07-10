import { describe, test, expect } from "bun:test";
import {
    buildLocalBrowserUrl,
    buildLocalRelayUrl,
    buildLocalWsRelayUrl,
    hasLocalCredentials,
    isLocalRelayUrl,
    isRemoteConfig,
    isRunnerRunning,
    openBrowserCommand,
    parseLocalArgs,
    planLocalActions,
    pollRelayHealth,
    runLocal,
} from "./local.js";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { _setGlobalConfigDir } from "./config/io.js";

const originalHome = process.env.HOME;

function withTmpHome(testFn: (tmpDir: string) => void | Promise<void>): Promise<void> {
    return new Promise((resolve, reject) => {
        const tmpDir = mkdtempSync(join(tmpdir(), "pizzapi-local-test-"));
        process.env.HOME = tmpDir;
        _setGlobalConfigDir(join(tmpDir, ".pizzapi"));
        process.env.PIZZAPI_RUNNER_STATE_PATH = join(tmpDir, ".pizzapi", "runner.json");
        (async () => {
            try {
                await testFn(tmpDir);
            } finally {
                process.env.HOME = originalHome;
                _setGlobalConfigDir(null);
                delete process.env.PIZZAPI_RUNNER_STATE_PATH;
                try {
                    rmSync(tmpDir, { recursive: true, force: true });
                } catch {}
            }
            resolve();
        })().catch(reject);
    });
}

describe("parseLocalArgs", () => {
    test("defaults to port 7492 and browser open", () => {
        const r = parseLocalArgs([]);
        expect(r.port).toBe(7492);
        expect(r.noBrowser).toBe(false);
        expect(r.help).toBe(false);
    });

    test("--port sets custom port", () => {
        expect(parseLocalArgs(["--port", "8080"]).port).toBe(8080);
    });

    test("--no-browser disables browser open", () => {
        const r = parseLocalArgs(["--no-browser"]);
        expect(r.noBrowser).toBe(true);
        expect(r.port).toBe(7492);
    });

    test("--help sets help flag", () => {
        expect(parseLocalArgs(["--help"]).help).toBe(true);
        expect(parseLocalArgs(["-h"]).help).toBe(true);
    });

    test("rejects invalid port", () => {
        const exitCalls: number[] = [];
        const originalExit = process.exit;
        (process as any).exit = (code: number) => {
            exitCalls.push(code);
            throw new Error(`exit:${code}`);
        };
        try {
            expect(() => parseLocalArgs(["--port", "abc"])).toThrow("exit:1");
            expect(() => parseLocalArgs(["--port", "123abc"])).toThrow("exit:1");
            expect(() => parseLocalArgs(["--port"])).toThrow("exit:1");
            expect(() => parseLocalArgs(["--port", "0"])).toThrow("exit:1");
            expect(() => parseLocalArgs(["--port", "70000"])).toThrow("exit:1");
        } finally {
            (process as any).exit = originalExit;
        }
    });
});

describe("URL builders", () => {
    test("build local relay, ws, and browser URLs", () => {
        expect(buildLocalRelayUrl(7492)).toBe("http://localhost:7492");
        expect(buildLocalWsRelayUrl(7492)).toBe("ws://localhost:7492");
        expect(buildLocalBrowserUrl(7492)).toBe("http://localhost:7492");
        expect(buildLocalBrowserUrl(8080)).toBe("http://localhost:8080");
    });
});

describe("isLocalRelayUrl", () => {
    test("matches localhost and 127.0.0.1 with the configured port", () => {
        expect(isLocalRelayUrl("ws://localhost:7492", 7492)).toBe(true);
        expect(isLocalRelayUrl("wss://localhost:7492", 7492)).toBe(true);
        expect(isLocalRelayUrl("http://localhost:7492", 7492)).toBe(true);
        expect(isLocalRelayUrl("https://127.0.0.1:7492", 7492)).toBe(true);
    });

    test("rejects wrong port or remote hosts", () => {
        expect(isLocalRelayUrl("ws://localhost:8080", 7492)).toBe(false);
        expect(isLocalRelayUrl("wss://relay.example.com", 7492)).toBe(false);
        expect(isLocalRelayUrl("http://192.168.1.1:7492", 7492)).toBe(false);
    });

    test("rejects missing url", () => {
        expect(isLocalRelayUrl(undefined, 7492)).toBe(false);
    });
});

describe("credential classification", () => {
    test("hasLocalCredentials requires apiKey + local relayUrl", () => {
        expect(hasLocalCredentials({ apiKey: "k", relayUrl: "ws://localhost:7492" }, 7492)).toBe(true);
        expect(hasLocalCredentials({ apiKey: "k", relayUrl: "wss://remote.example.com" }, 7492)).toBe(false);
        expect(hasLocalCredentials({ relayUrl: "ws://localhost:7492" }, 7492)).toBe(false);
        expect(hasLocalCredentials({ apiKey: "k" }, 7492)).toBe(false);
    });

    test("isRemoteConfig detects saved remote credentials", () => {
        expect(isRemoteConfig({ apiKey: "k", relayUrl: "wss://remote.example.com" }, 7492)).toBe(true);
        expect(isRemoteConfig({ apiKey: "k", relayUrl: "ws://localhost:7492" }, 7492)).toBe(false);
        expect(isRemoteConfig({ relayUrl: "wss://remote.example.com" }, 7492)).toBe(false);
        expect(isRemoteConfig({}, 7492)).toBe(false);
    });
});

describe("planLocalActions", () => {
    test("starts relay when not healthy", () => {
        const plan = planLocalActions({
            relayHealthy: false,
            hasLocalApiKey: false,
            hasRemoteConfig: false,
            runnerRunning: false,
            noBrowser: false,
        });
        expect(plan).toEqual({
            startRelay: true,
            runSetup: false,
            startRunner: false,
            openBrowser: false,
        });
    });

    test("remote config blocks before starting local relay", () => {
        const plan = planLocalActions({
            relayHealthy: false,
            hasLocalApiKey: false,
            hasRemoteConfig: true,
            runnerRunning: false,
            noBrowser: false,
        });
        expect(plan.fatal).toContain("remote relay");
        expect(plan.startRelay).toBe(false);
    });

    test("runs setup when relay is healthy but no credentials exist", () => {
        const plan = planLocalActions({
            relayHealthy: true,
            hasLocalApiKey: false,
            hasRemoteConfig: false,
            runnerRunning: false,
            noBrowser: false,
        });
        expect(plan).toEqual({
            startRelay: false,
            runSetup: true,
            startRunner: false,
            openBrowser: false,
        });
    });

    test("fails with remote config blocking local runner", () => {
        const plan = planLocalActions({
            relayHealthy: true,
            hasLocalApiKey: false,
            hasRemoteConfig: true,
            runnerRunning: false,
            noBrowser: false,
        });
        expect(plan.fatal).toContain("remote relay");
        expect(plan.startRunner).toBe(false);
    });

    test("starts runner when healthy + local apiKey + runner not running", () => {
        const plan = planLocalActions({
            relayHealthy: true,
            hasLocalApiKey: true,
            hasRemoteConfig: false,
            runnerRunning: false,
            noBrowser: false,
        });
        expect(plan).toEqual({
            startRelay: false,
            runSetup: false,
            startRunner: true,
            openBrowser: true,
        });
    });

    test("does not start runner when already running", () => {
        const plan = planLocalActions({
            relayHealthy: true,
            hasLocalApiKey: true,
            hasRemoteConfig: false,
            runnerRunning: true,
            noBrowser: false,
        });
        expect(plan.startRunner).toBe(false);
        expect(plan.openBrowser).toBe(true);
        expect(plan.note).toBe("Runner is already running.");
    });

    test("honors --no-browser", () => {
        const plan = planLocalActions({
            relayHealthy: true,
            hasLocalApiKey: true,
            hasRemoteConfig: false,
            runnerRunning: false,
            noBrowser: true,
        });
        expect(plan.openBrowser).toBe(false);
        expect(plan.startRunner).toBe(true);
    });
});

describe("pollRelayHealth", () => {
    test("returns true when signup-status is reachable", async () => {
        const originalFetch = globalThis.fetch;
        globalThis.fetch = (async (input: RequestInfo | URL) => {
            const url = input.toString();
            if (url === "http://localhost:7492/api/signup-status") {
                return new Response(JSON.stringify({ signupEnabled: true }), { status: 200 });
            }
            return originalFetch(input);
        }) as unknown as typeof fetch;
        try {
            const ok = await pollRelayHealth("http://localhost:7492", { timeoutMs: 500, pollMs: 100 });
            expect(ok).toBe(true);
        } finally {
            globalThis.fetch = originalFetch;
        }
    });

    test("returns false when signup-status never responds", async () => {
        const originalFetch = globalThis.fetch;
        globalThis.fetch = (async () => {
            await new Promise((_, reject) => setTimeout(() => reject(new Error("timeout")), 10));
            return new Response("", { status: 500 });
        }) as unknown as typeof fetch;
        try {
            const ok = await pollRelayHealth("http://localhost:7492", { timeoutMs: 250, pollMs: 100 });
            expect(ok).toBe(false);
        } finally {
            globalThis.fetch = originalFetch;
        }
    });
});

describe("isRunnerRunning", () => {
    test("returns false when state file is missing", () => {
        return withTmpHome(() => {
            expect(isRunnerRunning()).toBe(false);
        });
    });

    test("returns false for missing or unreadable state file", () => {
        return withTmpHome((tmpDir) => {
            mkdirSync(join(tmpDir, ".pizzapi"), { recursive: true });
            const statePath = join(tmpDir, ".pizzapi", "runner.json");
            writeFileSync(statePath, "not json", "utf-8");
            expect(isRunnerRunning()).toBe(false);
        });
    });

    test("returns false when recorded PIDs are not running", () => {
        return withTmpHome((tmpDir) => {
            mkdirSync(join(tmpDir, ".pizzapi"), { recursive: true });
            const statePath = join(tmpDir, ".pizzapi", "runner.json");
            writeFileSync(
                statePath,
                JSON.stringify({ pid: 99999999, supervisorPid: 99999998 }),
                "utf-8",
            );
            expect(isRunnerRunning()).toBe(false);
        });
    });
});

describe("openBrowserCommand", () => {
    test("selects platform-specific opener", () => {
        const originalPlatform = process.platform;
        const cases: { platform: NodeJS.Platform; command: string; args: string[] }[] = [
            { platform: "darwin", command: "open", args: ["__URL__"] },
            { platform: "win32", command: "cmd", args: ["/c", "start", "", "__URL__"] },
            { platform: "linux", command: "xdg-open", args: ["__URL__"] },
        ];
        for (const c of cases) {
            Object.defineProperty(process, "platform", { value: c.platform });
            const result = openBrowserCommand();
            expect(result.command).toBe(c.command);
            expect(result.args).toEqual(c.args);
        }
        Object.defineProperty(process, "platform", { value: originalPlatform });
    });
});

describe("runLocal orchestration", () => {
    function makeDeps(overrides: Partial<Awaited<typeof import("./local.js")["defaultLocalDeps"]>> = {}) {
        const calls = {
            runWeb: [] as string[][],
            runSetup: [] as { force?: boolean; relayDefault?: string }[],
            runSupervisor: 0,
            openBrowser: [] as string[],
            logs: [] as string[],
            exits: [] as number[],
        };
        const deps = {
            runWeb: async (args: string[]) => {
                calls.runWeb.push(args);
            },
            runSetup: async (opts: { force?: boolean; relayDefault?: string }) => {
                calls.runSetup.push(opts);
                return false;
            },
            runSupervisor: async () => {
                calls.runSupervisor++;
                return 0;
            },
            loadGlobalConfig: () => ({} as Partial<{ apiKey?: string; relayUrl?: string }>),
            pollRelayHealth: async () => false,
            isRunnerRunning: () => false,
            openBrowser: (url: string) => {
                calls.openBrowser.push(url);
            },
            log: {
                info: (msg: string) => calls.logs.push(`info:${msg}`),
                warn: (msg: string) => calls.logs.push(`warn:${msg}`),
                error: (msg: string) => calls.logs.push(`error:${msg}`),
            },
            processExit: (code: number) => {
                calls.exits.push(code);
                throw new Error(`exit:${code}`);
            },
            ...overrides,
        };
        return { deps, calls };
    }

    test("existing healthy relay skips web start and runs setup if no api key", async () => {
        let setupCalled = false;
        const { deps, calls } = makeDeps({
            pollRelayHealth: async () => true,
            runSetup: async (opts: { force?: boolean; relayDefault?: string }) => {
                calls.runSetup.push(opts);
                setupCalled = true;
                return true;
            },
            loadGlobalConfig: () => {
                if (!setupCalled) return {};
                return { apiKey: "k", relayUrl: "ws://localhost:7492" };
            },
        });
        await expect(runLocal([], deps as any)).rejects.toThrow("exit:0");
        expect(calls.runWeb).toHaveLength(0);
        expect(setupCalled).toBe(true);
        expect(calls.runSetup).toEqual([{ force: false, relayDefault: "http://localhost:7492" }]);
        expect(calls.runSupervisor).toBe(1);
        expect(calls.openBrowser).toEqual(["http://localhost:7492"]);
    });

    test("web failure exits with actionable message", async () => {
        const { deps, calls } = makeDeps({
            runWeb: async () => {
                throw new Error("docker unavailable");
            },
        });
        await expect(runLocal([], deps as any)).rejects.toThrow("docker unavailable");
        expect(calls.exits).toHaveLength(0);
    });

    test("relay unhealthy after runWeb exits with actionable message", async () => {
        const { deps, calls } = makeDeps({
            pollRelayHealth: async () => false,
        });
        await expect(runLocal([], deps as any)).rejects.toThrow("exit:1");
        expect(calls.runWeb).toHaveLength(1);
        expect(calls.exits).toEqual([1]);
        const errorLog = calls.logs.find((l) => l.startsWith("error:"));
        expect(errorLog).toContain("did not become healthy");
    });

    test("setup cancellation leaves relay running and does not start runner", async () => {
        let setupCalled = false;
        const { deps, calls } = makeDeps({
            pollRelayHealth: async () => true,
            runSetup: async () => {
                setupCalled = true;
                return false;
            },
        });
        await runLocal([], deps as any);
        expect(calls.runWeb).toHaveLength(0);
        expect(setupCalled).toBe(true);
        expect(calls.runSupervisor).toBe(0);
        expect(calls.openBrowser).toHaveLength(0);
        const infoLog = calls.logs.find((l) => l.includes("Setup cancelled"));
        expect(infoLog).toBeDefined();
    });

    test("existing healthy relay + local apiKey skips setup and starts runner", async () => {
        const { deps, calls } = makeDeps({
            pollRelayHealth: async () => true,
            loadGlobalConfig: () => ({ apiKey: "k", relayUrl: "ws://localhost:7492" }),
        });
        await expect(runLocal([], deps as any)).rejects.toThrow("exit:0");
        expect(calls.runWeb).toHaveLength(0);
        expect(calls.runSetup).toHaveLength(0);
        expect(calls.runSupervisor).toBe(1);
        expect(calls.openBrowser).toEqual(["http://localhost:7492"]);
    });

    test("existing runner is reported and command exits cleanly", async () => {
        const { deps, calls } = makeDeps({
            pollRelayHealth: async () => true,
            loadGlobalConfig: () => ({ apiKey: "k", relayUrl: "ws://localhost:7492" }),
            isRunnerRunning: () => true,
        });
        await runLocal([], deps as any);
        expect(calls.runSupervisor).toBe(0);
        const noteLog = calls.logs.find((l) => l.includes("already running"));
        expect(noteLog).toBeDefined();
    });

    test("runner exit code is forwarded", async () => {
        let supervisorCalled = false;
        const { deps, calls } = makeDeps({
            pollRelayHealth: async () => true,
            loadGlobalConfig: () => ({ apiKey: "k", relayUrl: "ws://localhost:7492" }),
            runSupervisor: async () => {
                supervisorCalled = true;
                return 42;
            },
        });
        await expect(runLocal([], deps as any)).rejects.toThrow("exit:42");
        expect(supervisorCalled).toBe(true);
    });

    test("remote config blocks local runner start", async () => {
        const { deps, calls } = makeDeps({
            pollRelayHealth: async () => true,
            loadGlobalConfig: () => ({ apiKey: "k", relayUrl: "wss://remote.example.com" }),
        });
        await expect(runLocal([], deps as any)).rejects.toThrow("exit:1");
        expect(calls.runSetup).toHaveLength(0);
        expect(calls.runSupervisor).toBe(0);
        const errorLog = calls.logs.find((l) => l.includes("remote relay"));
        expect(errorLog).toBeDefined();
    });

    test("--no-browser skips openBrowser", async () => {
        const { deps, calls } = makeDeps({
            pollRelayHealth: async () => true,
            loadGlobalConfig: () => ({ apiKey: "k", relayUrl: "ws://localhost:7492" }),
        });
        await expect(runLocal(["--no-browser"], deps as any)).rejects.toThrow("exit:0");
        expect(calls.openBrowser).toHaveLength(0);
        expect(calls.runSupervisor).toBe(1);
    });

    test("--port is passed to runWeb", async () => {
        let webStarted = false;
        const { deps, calls } = makeDeps({
            pollRelayHealth: async () => webStarted,
            runWeb: async (args: string[]) => {
                webStarted = true;
                calls.runWeb.push(args);
            },
            loadGlobalConfig: () => ({ apiKey: "k", relayUrl: "ws://localhost:8080" }),
        });
        await expect(runLocal(["--port", "8080"], deps as any)).rejects.toThrow("exit:0");
        expect(calls.runWeb).toEqual([["--port", "8080"]]);
        expect(calls.openBrowser).toEqual(["http://localhost:8080"]);
    });

    test("--port is passed to setup default relay", async () => {
        let setupCalled = false;
        const { deps, calls } = makeDeps({
            pollRelayHealth: async () => true,
            runSetup: async (opts: { force?: boolean; relayDefault?: string }) => {
                calls.runSetup.push(opts);
                setupCalled = true;
                return true;
            },
            loadGlobalConfig: () => {
                if (!setupCalled) return {};
                return { apiKey: "k", relayUrl: "ws://localhost:8080" };
            },
        });
        await expect(runLocal(["--port", "8080", "--no-browser"], deps as any)).rejects.toThrow("exit:0");
        expect(calls.runSetup).toEqual([{ force: false, relayDefault: "http://localhost:8080" }]);
        expect(calls.runSupervisor).toBe(1);
    });
});
