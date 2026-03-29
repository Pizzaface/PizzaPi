/**
 * bash.test.ts — unit coverage for bashTool with injected dependencies.
 *
 * Strategy:
 *  - Uses createBashTool(deps) DI factory instead of mock.module(), so no
 *    module-level mocks leak into other test files.
 *  - exec is replaced via the execFn dep; sandbox via isSandboxActiveFn,
 *    getSandboxEnvFn, and wrapCommandFn.
 *  - Integration smoke test calls the real bashTool (no DI overrides) via
 *    Bun.spawnSync to verify actual shell execution works end-to-end.
 */

import { describe, test, expect, beforeEach } from "bun:test";
import { promisify } from "util";
import { createBashTool, bashTool } from "./bash.js";

// ── Mock State ────────────────────────────────────────────────────────────────

interface MockSuccess {
    stdout: string;
    stderr: string;
}

interface MockError {
    message: string;
    stdout?: string;
    stderr?: string;
    code?: number | string;
    killed?: boolean;
    signal?: string;
}

let mockSuccess: MockSuccess | null = null;
let mockError: MockError | null = null;
/** Captured from the most recent exec() call inside bashTool.execute() */
let capturedCmd = "";
let capturedOpts: { timeout?: number; env?: NodeJS.ProcessEnv } = {};

/** Sandbox state controlled per-test */
let sandboxActive = false;
let sandboxEnvVars: Record<string, string> = {};
let wrapCommandThrows = false;

// Helpers to set mock state
function setSuccess(stdout: string, stderr = "") {
    mockSuccess = { stdout, stderr };
    mockError = null;
}
function setError(err: MockError) {
    mockError = err;
    mockSuccess = null;
}
/** Passthrough mode: integration smoke test uses the real bashTool. */
function resetMockState() {
    mockSuccess = null;
    mockError = null;
    capturedCmd = "";
    capturedOpts = {};
    sandboxActive = false;
    sandboxEnvVars = {};
    wrapCommandThrows = false;
}

// ── Build the mock exec function ──────────────────────────────────────────────
// The real child_process.exec has util.promisify.custom so that promisify(exec)
// returns { stdout, stderr } instead of just the first callback value.
// We must replicate this or `const { stdout, stderr } = await execAsync(...)` in
// bash.ts will destructure undefined from a plain string.

import { exec } from "child_process";

function mockExecCallback(
    cmd: string,
    opts: any,
    callback: (err: any, stdout: string, stderr: string) => void
): void {
    capturedCmd = cmd;
    capturedOpts = { timeout: opts?.timeout, env: opts?.env };

    if (mockError) {
        const err = Object.assign(new Error(mockError.message), {
            stdout: mockError.stdout ?? "",
            stderr: mockError.stderr ?? "",
            code: mockError.code,
            killed: mockError.killed ?? false,
            signal: mockError.signal,
        });
        callback(err, mockError.stdout ?? "", mockError.stderr ?? "");
    } else if (mockSuccess) {
        callback(null, mockSuccess.stdout, mockSuccess.stderr);
    }
}

// Attach util.promisify.custom so promisify(mockExecCallback) behaves like
// promisify(exec): resolves with { stdout, stderr } on success, rejects with
// an error that has stdout/stderr attached on failure.
(mockExecCallback as any)[promisify.custom] = (cmd: string, opts: any) =>
    new Promise<{ stdout: string; stderr: string }>((resolve, reject) => {
        mockExecCallback(cmd, opts, (err, stdout, stderr) => {
            if (err) {
                Object.assign(err, { stdout, stderr });
                reject(err);
            } else {
                resolve({ stdout, stderr });
            }
        });
    });

// ── DI-based tool instance ────────────────────────────────────────────────────

const testTool = createBashTool({
    execFn: mockExecCallback as typeof exec,
    isSandboxActiveFn: () => sandboxActive,
    getSandboxEnvFn: () => ({ ...sandboxEnvVars }),
    wrapCommandFn: async (cmd: string) => {
        if (wrapCommandThrows) throw new Error("sandbox denied: path not allowed");
        return cmd;
    },
});

// ── Helper ────────────────────────────────────────────────────────────────────

async function execBash(command: string, timeout?: number) {
    return testTool.execute("test-call", { command, timeout });
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe("bashTool", () => {
    // Reset all mock state before each test so stale state from a mid-test
    // throw can't bleed into subsequent tests.
    beforeEach(() => resetMockState());

    // ── Integration smoke test ─────────────────────────────────────────────

    describe("integration smoke test", () => {
        test("runs real `echo hello` through the actual shell", async () => {
            // Use the real bashTool (no DI), which runs through the real shell
            const result = await bashTool.execute("test-call", { command: "echo hello" });
            expect(result.content[0].text).toContain("hello");
            expect(result.details.stdout).toContain("hello");
        });
    });

    // ── Timeout selection ──────────────────────────────────────────────────

    describe("timeout selection", () => {
        test("uses default 30 000 ms when no timeout param is given", async () => {
            setSuccess("ok");
            await execBash("echo ok");
            expect(capturedOpts.timeout).toBe(30_000);
        });

        test("forwards an explicit timeout to exec", async () => {
            setSuccess("ok");
            await execBash("echo ok", 5_000);
            expect(capturedOpts.timeout).toBe(5_000);
        });

        test("accepts large timeout values", async () => {
            setSuccess("ok");
            await execBash("echo ok", 120_000);
            expect(capturedOpts.timeout).toBe(120_000);
        });
    });

    // ── Sandbox env injection ──────────────────────────────────────────────

    describe("sandbox env injection", () => {
        test("passes process.env directly when sandbox is inactive", async () => {
            sandboxActive = false;
            setSuccess("ok");
            await execBash("echo ok");
            // Same object reference — no copy is made in the no-sandbox path
            expect(capturedOpts.env).toBe(process.env);
        });

        test("merges sandbox env vars with process.env when sandbox is active", async () => {
            sandboxActive = true;
            sandboxEnvVars = {
                HTTP_PROXY: "http://sandbox:8080",
                HTTPS_PROXY: "http://sandbox:8080",
                NO_PROXY: "localhost",
            };
            setSuccess("ok");
            await execBash("echo ok");
            expect(capturedOpts.env).toMatchObject({
                HTTP_PROXY: "http://sandbox:8080",
                HTTPS_PROXY: "http://sandbox:8080",
                NO_PROXY: "localhost",
            });
            // Original env vars are preserved in the merged copy
            expect(capturedOpts.env?.PATH).toBeDefined();
            sandboxActive = false;
            sandboxEnvVars = {};
        });

        test("returns sandboxBlocked=true when wrapCommand throws", async () => {
            sandboxActive = true;
            wrapCommandThrows = true;
            const result = await execBash("echo ok");
            expect(result.details.sandboxBlocked).toBe(true);
            expect(result.content[0].text).toContain("Sandbox blocked");
            sandboxActive = false;
            wrapCommandThrows = false;
        });
    });

    // ── Stdout/stderr formatting ───────────────────────────────────────────

    describe("stdout/stderr formatting", () => {
        test("returns raw stdout when stderr is empty", async () => {
            setSuccess("hello world\n", "");
            const result = await execBash("echo hello");
            expect(result.content[0].text).toBe("hello world\n");
            expect(result.details.stdout).toBe("hello world\n");
            expect(result.details.stderr).toBe("");
        });

        test("appends stderr with 'stderr:' label when non-empty", async () => {
            setSuccess("stdout line\n", "err line\n");
            const result = await execBash("echo test");
            expect(result.content[0].text).toBe("stdout line\n\nstderr: err line\n");
            expect(result.details.stderr).toBe("err line\n");
        });

        test("does not add stderr label when stderr is empty string", async () => {
            setSuccess("output only\n", "");
            const result = await execBash("echo output");
            expect(result.content[0].text).toBe("output only\n");
            expect(result.content[0].text).not.toContain("stderr:");
        });

        test("preserves original command in details regardless of sandbox wrapping", async () => {
            setSuccess("wrapped output");
            const result = await execBash("echo original-cmd");
            expect(result.details.command).toBe("echo original-cmd");
        });

        test("passes large output through without truncation", async () => {
            const largeOutput = "x".repeat(100_000) + "\n";
            setSuccess(largeOutput, "");
            const result = await execBash("big-cmd");
            expect(result.details.stdout).toBe(largeOutput);
            expect(result.details.stdout.length).toBe(100_001);
        });
    });

    // ── Error normalization ────────────────────────────────────────────────

    describe("error normalization", () => {
        test("captures stdout and stderr on non-zero exit, records exitCode", async () => {
            setError({
                message: "Command failed: exit 1",
                stdout: "partial stdout\n",
                stderr: "error output\n",
                code: 1,
            });
            const result = await execBash("exit 1");
            expect(result.content[0].text).toContain("partial stdout");
            expect(result.content[0].text).toContain("error output");
            expect(result.details.stderr).toBe("error output\n");
            expect(result.details.exitCode).toBe(1);
        });

        test("handles killed/timeout process gracefully (no exitCode)", async () => {
            setError({
                message: "Command timed out",
                stdout: "",
                stderr: "",
                killed: true,
                signal: "SIGTERM",
            });
            const result = await execBash("sleep 999", 100);
            expect(result).toBeDefined();
            expect(result.content[0].text).toBeDefined();
            // error.code is undefined for signal kills
            expect(result.details.exitCode).toBeUndefined();
        });

        test("preserves partial stdout captured before failure", async () => {
            setError({
                message: "Command failed",
                stdout: "partial output\n",
                stderr: "then it failed\n",
                code: 2,
            });
            const result = await execBash("some-cmd");
            expect(result.details.stdout).toBe("partial output\n");
            expect(result.content[0].text).toContain("partial output");
        });

        test("falls back to error.message when both stdout and stderr are empty", async () => {
            setError({
                message: "spawn error ENOENT",
                stdout: "",
                stderr: "",
                code: "ENOENT",
            });
            const result = await execBash("nonexistent_cmd");
            // bash.ts: `stderr = error.stderr || error.message`
            // error.stderr="" is falsy → falls through to error.message
            expect(result.details.stderr).toBe("spawn error ENOENT");
        });

        test("always returns a defined result even on unexpected errors", async () => {
            setError({ message: "some unexpected error", code: 127 });
            const result = await execBash("bad-command");
            expect(result).toBeDefined();
            expect(result.content).toBeDefined();
            expect(result.content[0].text).toBeDefined();
        });
    });

    // ── Tool metadata ──────────────────────────────────────────────────────

    describe("tool metadata", () => {
        test("name is 'bash'", () => {
            expect(bashTool.name).toBe("bash");
        });

        test("label is 'Bash'", () => {
            expect(bashTool.label).toBe("Bash");
        });

        test("description is non-empty", () => {
            expect(bashTool.description).toBeTruthy();
        });

        test("parameters schema is defined", () => {
            expect(bashTool.parameters).toBeDefined();
        });
    });
});
