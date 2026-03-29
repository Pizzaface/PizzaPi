/**
 * bash.test.ts — unit coverage for bashTool with mocked child_process.
 *
 * Strategy:
 *  - mock.module("child_process", ...) is hoisted by Bun before static imports,
 *    so we cannot rely on `import { exec as realExec }` being the real exec.
 *  - We attach util.promisify.custom to the mock exec so promisify(exec) returns
 *    { stdout, stderr } exactly as the real child_process.exec does.
 *  - Integration smoke test uses Bun.spawnSync (bypasses child_process entirely).
 */

import { describe, test, expect, afterAll, mock } from "bun:test";
import { promisify } from "util";

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
/** Passthrough mode: integration smoke test uses Bun.spawnSync directly. */
function passthrough() {
    mockSuccess = null;
    mockError = null;
}

// ── Build the mock exec function ──────────────────────────────────────────────
// The real child_process.exec has util.promisify.custom so that promisify(exec)
// returns { stdout, stderr } instead of just the first callback value.
// We must replicate this or `const { stdout, stderr } = await execAsync(...)` in
// bash.ts will destructure undefined from a plain string.

function mockExecCallback(
    cmd: string,
    opts: any,
    callback: (err: any, stdout: string, stderr: string) => void
): void {
    capturedCmd = cmd;
    capturedOpts = { timeout: opts?.timeout, env: opts?.env };

    if (mockSuccess === null && mockError === null) {
        // Passthrough: run the real shell via Bun.spawnSync (no child_process).
        const proc = Bun.spawnSync(["bash", "-c", cmd], { env: opts?.env ?? process.env });
        const stdout = proc.stdout.toString();
        const stderr = proc.stderr.toString();
        callback(null, stdout, stderr);
        return;
    }

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

// ── Module Mocks (declared before dynamic imports of bash.ts) ─────────────────

mock.module("child_process", () => ({
    exec: mockExecCallback,
}));

mock.module("./sandbox.js", () => ({
    isSandboxActive: () => sandboxActive,
    getSandboxEnv: () => ({ ...sandboxEnvVars }),
    wrapCommand: async (cmd: string) => {
        if (wrapCommandThrows) throw new Error("sandbox denied: path not allowed");
        return cmd;
    },
    initSandbox: async () => {},
    cleanupSandbox: async () => {},
    _resetState: () => {},
}));

// ── Load bash.ts after mocks are registered ───────────────────────────────────

const { bashTool } = await import("./bash.js");

// ── Helper ────────────────────────────────────────────────────────────────────

async function execBash(command: string, timeout?: number) {
    return bashTool.execute("test-call", { command, timeout });
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe("bashTool", () => {
    afterAll(() => {
        mock.restore();
    });

    // ── Integration smoke test ─────────────────────────────────────────────

    describe("integration smoke test", () => {
        test("runs real `echo hello` through the actual shell", async () => {
            passthrough();
            const result = await execBash("echo hello");
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
            // exec should never be reached — mock result doesn't matter
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
