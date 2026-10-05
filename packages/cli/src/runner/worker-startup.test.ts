import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { watchWorkerStartup, type WorkerStartupResult } from "./worker-startup.js";

const startupModule = join(import.meta.dir, "worker-startup.ts");

let tmp: string;
beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), "worker-startup-test-"));
});
afterEach(() => {
    rmSync(tmp, { recursive: true, force: true });
});

/** Spawn a real child with an IPC channel running `body` (has the worker-side helpers in scope). */
function spawnFixture(body: string, env: NodeJS.ProcessEnv = {}): ChildProcess {
    const file = join(tmp, `fixture-${Math.random().toString(16).slice(2)}.ts`);
    writeFileSync(
        file,
        `import { reportWorkerStartupError, reportWorkerStartupReady } from ${JSON.stringify(startupModule)};\n${body}\n`,
    );
    return spawn(process.execPath, [file], {
        cwd: tmp,
        env: { PATH: process.env.PATH, HOME: tmp, ...env },
        stdio: ["ignore", "ignore", "ignore", "ipc"],
    });
}

function waitForStartup(child: ChildProcess, timeoutMs = 10_000): Promise<WorkerStartupResult | "none"> {
    return new Promise((resolve) => {
        watchWorkerStartup(child, resolve, { timeoutMs });
        // exit 43 settles without calling onResult; resolve "none" shortly after exit.
        child.on("exit", () => setTimeout(() => resolve("none"), 100));
    });
}

describe("worker startup IPC (review R13)", () => {
    test("a startup error sent right before exit(1) reaches the daemon (flushed before exit)", async () => {
        const child = spawnFixture(`
            await reportWorkerStartupError(new Error("Refusing to start: sandbox unavailable"));
            process.exit(1);
        `);
        expect(await waitForStartup(child)).toEqual({ ok: false, message: "Refusing to start: sandbox unavailable" });
    });

    test("startup_ready reports ok", async () => {
        const child = spawnFixture(`
            reportWorkerStartupReady();
            // Errors after readiness are not re-reported as startup errors.
            await reportWorkerStartupError("late");
            setTimeout(() => process.exit(0), 200);
        `);
        expect(await waitForStartup(child)).toEqual({ ok: true });
    });

    test("exit before any report is a startup failure", async () => {
        const child = spawnFixture(`process.exit(3);`);
        const result = await waitForStartup(child);
        expect(result).toMatchObject({ ok: false });
        expect((result as { message: string }).message).toContain("exited during startup (code=3");
    });

    test("restart-in-place (exit 43) before readiness leaves reporting to the replacement worker", async () => {
        const child = spawnFixture(`process.exit(43);`);
        expect(await waitForStartup(child)).toBe("none");
    });

    test("bounded: a worker that never reports is treated as ready after the timeout", async () => {
        const child = spawnFixture(`setTimeout(() => process.exit(0), 3000);`);
        try {
            expect(await waitForStartup(child, 150)).toEqual({ ok: true, timedOut: true });
        } finally {
            child.kill("SIGKILL");
        }
    });

    test("onResult is called exactly once", async () => {
        const child = spawnFixture(`
            reportWorkerStartupReady();
            setTimeout(() => process.exit(1), 100);
        `);
        const calls: WorkerStartupResult[] = [];
        await new Promise<void>((resolve) => {
            watchWorkerStartup(child, (r) => calls.push(r), { timeoutMs: 50 });
            child.on("exit", () => setTimeout(resolve, 100));
        });
        expect(calls).toEqual([{ ok: true }]);
    });
});

// Real worker: an explicitly requested sandbox that cannot be enabled must be
// reported to the daemon as a startup error (not readiness). Only meaningful
// where the sandbox runtime is unavailable (no bubblewrap on Linux).
const sandboxUnavailable =
    process.platform === "linux" && spawnSync("sh", ["-c", "command -v bwrap"]).status !== 0;

describe("real worker fail-closed sandbox startup (review R13)", () => {
    test.skipIf(!sandboxUnavailable)("worker.ts reports startup_error and exits when a required sandbox is unavailable", async () => {
        const workerPath = join(import.meta.dir, "worker.ts");
        const child = spawn(process.execPath, [workerPath], {
            cwd: tmp,
            env: {
                PATH: process.env.PATH,
                HOME: tmp,
                PIZZAPI_WORKER_CWD: tmp,
                PIZZAPI_SESSION_ID: "r13-test-session",
                PIZZAPI_RELAY_URL: "http://127.0.0.1:9",
                PIZZAPI_API_KEY: "test-key",
                PIZZAPI_SANDBOX: "full",
                PIZZAPI_NO_MCP: "1",
                PIZZAPI_NO_PLUGINS: "1",
            },
            stdio: ["ignore", "ignore", "pipe", "ipc"],
        });
        let stderr = "";
        child.stderr?.on("data", (d) => { stderr += String(d); });
        const result = await waitForStartup(child, 30_000);
        if (result === "none" || result.ok) throw new Error(`expected startup error, got ${JSON.stringify(result)}; stderr:\n${stderr}`);
        expect(result.message).toContain("Refusing to start");
        expect(result.message).toContain("sandbox");
    }, 40_000);
});

// Review R2-1: a project's `.pizzapi/config.json` envOverrides must not reach
// any env var the worker consults when resolving its sandbox. Exercised end to
// end: real loadConfig → spawner envOverrides → real worker sandbox resolution.
describe("project envOverrides cannot disable an operator-required sandbox (review R2-1)", () => {
    const SANDBOX_ALIASES: Record<string, string> = {
        PIZZAPI_NO_SANDBOX: "1",
        PIZZAPI_SANDBOX: "off",
        PIZZAPI_SANDBOX_ALLOW_UNSANDBOXED: "1",
        PIZZAPI_SANDBOX_ACTIVE: "1",
        PIZZAPI_SANDBOX_MODE: "full",
    };

    async function projectWorkerEnv(): Promise<{ projectDir: string; overrides: Record<string, string> }> {
        const { mkdirSync } = await import("node:fs");
        const { _setGlobalConfigDir } = await import("../config/io.js");
        const { workerEnvOverrides } = await import("./session-spawner.js");
        const globalDir = join(tmp, ".pizzapi");
        const projectDir = join(tmp, "project");
        mkdirSync(globalDir, { recursive: true });
        mkdirSync(join(projectDir, ".pizzapi"), { recursive: true });
        // Operator requires the sandbox globally.
        writeFileSync(join(globalDir, "config.json"), JSON.stringify({ sandbox: { mode: "full" } }));
        writeFileSync(
            join(projectDir, ".pizzapi", "config.json"),
            JSON.stringify({ envOverrides: { ...SANDBOX_ALIASES, PIZZAPI_NO_MCP: "1" } }),
        );
        _setGlobalConfigDir(globalDir);
        try {
            return { projectDir, overrides: workerEnvOverrides(projectDir) };
        } finally {
            _setGlobalConfigDir(null);
        }
    }

    test("the spawner forwards no sandbox alias from a project config", async () => {
        const { overrides } = await projectWorkerEnv();
        for (const key of Object.keys(SANDBOX_ALIASES)) expect(overrides[key]).toBeUndefined();
        // Ordinary project overrides still flow through.
        expect(overrides.PIZZAPI_NO_MCP).toBe("1");
    });

    test.skipIf(!sandboxUnavailable)("the real worker still fails closed with the spawner-built env", async () => {
        const { projectDir, overrides } = await projectWorkerEnv();
        const child = spawn(process.execPath, [join(import.meta.dir, "worker.ts")], {
            cwd: projectDir,
            env: {
                PATH: process.env.PATH,
                HOME: tmp,
                ...overrides,
                PIZZAPI_WORKER_CWD: projectDir,
                PIZZAPI_SESSION_ID: "r2-1-test-session",
                PIZZAPI_RELAY_URL: "http://127.0.0.1:9",
                PIZZAPI_API_KEY: "test-key",
                PIZZAPI_NO_MCP: "1",
                PIZZAPI_NO_PLUGINS: "1",
            },
            stdio: ["ignore", "ignore", "pipe", "ipc"],
        });
        let stderr = "";
        child.stderr?.on("data", (d) => { stderr += String(d); });
        try {
            const result = await waitForStartup(child, 30_000);
            if (result === "none" || result.ok) throw new Error(`expected startup error, got ${JSON.stringify(result)}; stderr:\n${stderr}`);
            expect(result.message).toContain("Refusing to start");
            expect(result.message).toContain("sandbox");
        } finally {
            child.kill("SIGKILL");
        }
    }, 40_000);
});

// Review R2-12: readiness is reported only after the whole boot chain, so a
// fatal error after the sandbox stage (here: agentDir is a regular file, which
// fails resource/model-runtime setup) reaches the daemon as a startup error
// instead of following an already-reported ready.
describe("real worker reports post-sandbox boot failures as startup errors (review R2-12)", () => {
    test("agentDir pointing at a file yields startup_error, not ready", async () => {
        const { mkdirSync } = await import("node:fs");
        mkdirSync(join(tmp, ".pizzapi"), { recursive: true });
        const agentDirFile = join(tmp, "agent-dir-is-a-file");
        writeFileSync(agentDirFile, "not a directory");
        writeFileSync(
            join(tmp, ".pizzapi", "config.json"),
            JSON.stringify({ sandbox: { mode: "none" }, agentDir: agentDirFile }),
        );
        const child = spawn(process.execPath, [join(import.meta.dir, "worker.ts")], {
            cwd: tmp,
            env: {
                PATH: process.env.PATH,
                HOME: tmp,
                PIZZAPI_WORKER_CWD: tmp,
                PIZZAPI_SESSION_ID: "r2-12-test-session",
                PIZZAPI_RELAY_URL: "http://127.0.0.1:9",
                PIZZAPI_API_KEY: "test-key",
                PIZZAPI_NO_MCP: "1",
                PIZZAPI_NO_PLUGINS: "1",
                PIZZAPI_NO_RELAY: "1",
            },
            stdio: ["ignore", "ignore", "pipe", "ipc"],
        });
        let stderr = "";
        child.stderr?.on("data", (d) => { stderr += String(d); });
        try {
            const result = await waitForStartup(child, 30_000);
            if (result === "none" || result.ok) throw new Error(`expected startup error, got ${JSON.stringify(result)}; stderr:\n${stderr}`);
            // The worker's own error, not the generic "exited during startup".
            expect(result.message).not.toContain("exited during startup");
        } finally {
            child.kill("SIGKILL");
        }
    }, 40_000);
});

describe("real worker reports ready once fully booted (review R2-12)", () => {
    test("a healthy worker reaches startup_ready after the full boot chain", async () => {
        const { mkdirSync } = await import("node:fs");
        mkdirSync(join(tmp, ".pizzapi"), { recursive: true });
        writeFileSync(join(tmp, ".pizzapi", "config.json"), JSON.stringify({ sandbox: { mode: "none" } }));
        const child = spawn(process.execPath, [join(import.meta.dir, "worker.ts")], {
            cwd: tmp,
            env: {
                PATH: process.env.PATH,
                HOME: tmp,
                PIZZAPI_WORKER_CWD: tmp,
                PIZZAPI_SESSION_ID: "r2-12-ok-session",
                PIZZAPI_RELAY_URL: "http://127.0.0.1:9",
                PIZZAPI_API_KEY: "test-key",
                PIZZAPI_NO_MCP: "1",
                PIZZAPI_NO_PLUGINS: "1",
                PIZZAPI_NO_RELAY: "1",
            },
            stdio: ["ignore", "pipe", "pipe", "ipc"],
        });
        let output = "";
        child.stdout?.on("data", (d) => { output += String(d); });
        child.stderr?.on("data", (d) => { output += String(d); });
        try {
            const result = await waitForStartup(child, 30_000);
            if (result === "none" || !result.ok || result.timedOut) {
                throw new Error(`expected ready, got ${JSON.stringify(result)}; output:\n${output}`);
            }
            // Ready is reported only after the boot chain finished, which logs
            // this line first (stdout may be delivered after the IPC message).
            for (let i = 0; i < 100 && !output.includes("started (cwd="); i++) {
                await new Promise((r) => setTimeout(r, 20));
            }
            expect(output).toContain("started (cwd=");
        } finally {
            child.kill("SIGKILL");
        }
    }, 40_000);
});
