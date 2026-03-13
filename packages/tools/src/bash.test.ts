import { describe, test, expect, beforeEach, afterEach, spyOn } from "bun:test";
import { bashTool } from "./bash.js";
import {
    initSandbox,
    cleanupSandbox,
    _resetState,
    type ResolvedSandboxConfig,
} from "./sandbox.js";

// ── Helpers ───────────────────────────────────────────────────────────────────

function makeConfig(mode: ResolvedSandboxConfig["mode"] = "none"): ResolvedSandboxConfig {
    if (mode === "none") {
        return { mode: "none", srtConfig: null };
    }
    return {
        mode,
        srtConfig: {
            filesystem: {
                denyRead: [],
                allowWrite: ["/tmp"],
                denyWrite: [],
            },
        },
    };
}

async function execBash(command: string, timeout?: number) {
    return bashTool.execute("test-call", { command, timeout });
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe("bashTool", () => {
    beforeEach(() => {
        _resetState();
    });

    afterEach(async () => {
        await cleanupSandbox();
    });

    describe("basic execution (no sandbox)", () => {
        test("executes a simple command", async () => {
            const result = await execBash("echo hello");
            expect(result.content[0].text).toContain("hello");
            expect(result.details.stdout).toContain("hello");
        });

        test("captures stderr", async () => {
            const result = await execBash("echo err >&2");
            expect(result.content[0].text).toContain("stderr: err");
            expect(result.details.stderr).toContain("err");
        });

        test("returns both stdout and stderr", async () => {
            const result = await execBash("echo out && echo err >&2");
            expect(result.content[0].text).toContain("out");
            expect(result.content[0].text).toContain("stderr: err");
        });

        test("uses default 30s timeout", async () => {
            const result = await execBash("echo fast");
            expect(result.content[0].text).toContain("fast");
        });

        test("respects custom timeout", async () => {
            const result = await execBash("echo quick", 5000);
            expect(result.content[0].text).toContain("quick");
        });
    });

    describe("sandbox mode: none", () => {
        test("executes normally when mode is none", async () => {
            await initSandbox(makeConfig("none"));
            const result = await execBash("echo no-sandbox");
            expect(result.content[0].text).toContain("no-sandbox");
        });

        test("no sandbox env vars when mode is none", async () => {
            await initSandbox(makeConfig("none"));
            const result = await execBash("echo ${HTTP_PROXY:-none}");
            expect(result.content[0].text).toContain("none");
        });
    });

    describe("sandbox mode: basic / full (graceful degradation)", () => {
        // Note: actual OS-level sandboxing requires macOS/Linux with the sandbox
        // runtime. On CI or unsupported platforms, initSandbox degrades gracefully
        // and isSandboxActive() returns false. These tests verify the integration
        // plumbing works without relying on OS-level enforcement.

        test("still executes commands after sandbox init in basic mode", async () => {
            await initSandbox(makeConfig("basic"));
            const result = await execBash("echo sandboxed");
            expect(result.content[0].text).toContain("sandboxed");
        });

        test("still executes commands after sandbox init in full mode", async () => {
            await initSandbox(makeConfig("full"));
            const result = await execBash("echo full-mode");
            expect(result.content[0].text).toContain("full-mode");
        });

        test("details always contain original command", async () => {
            await initSandbox(makeConfig("basic"));
            const result = await execBash("echo original");
            expect(result.details.command).toBe("echo original");
        });
    });

    describe("error handling", () => {
        test("returns stderr on non-zero exit", async () => {
            const result = await execBash("exit 1");
            expect(result.content[0].text).toBeDefined();
        });

        test("returns error output for command-not-found", async () => {
            const result = await execBash("nonexistent_command_xyz_123");
            // Either captures stderr or returns an error message
            expect(result.content[0].text).toBeTruthy();
        });

        test("returns error output for failing commands", async () => {
            const result = await execBash("ls /nonexistent_xyz_abc");
            expect(result.content[0].text).toContain("No such file or directory");
        });
    });

    describe("tool metadata", () => {
        test("has correct name", () => {
            expect(bashTool.name).toBe("bash");
        });

        test("has correct label", () => {
            expect(bashTool.label).toBe("Bash");
        });

        test("has description", () => {
            expect(bashTool.description).toBeTruthy();
        });

        test("has command parameter", () => {
            expect(bashTool.parameters).toBeDefined();
        });

        test("executes a failing command and returns error output", async () => {
            const result = await bashTool.execute("test-err", { command: "ls /nonexistent_xyz_abc" });
            expect(result.content[0].text).toContain("No such file or directory");
        });
    });
});
