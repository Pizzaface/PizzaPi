import { describe, test, expect, beforeEach, afterEach, mock, spyOn } from "bun:test";
import { bashTool } from "./bash.js";
import {
    initSandbox,
    cleanupSandbox,
    getViolations,
    _resetState,
    type ResolvedSandboxConfig,
} from "./sandbox.js";

// ── Helpers ───────────────────────────────────────────────────────────────────

function makeConfig(overrides?: Partial<ResolvedSandboxConfig>): ResolvedSandboxConfig {
    return {
        enabled: true,
        mode: "enforce",
        network: {
            mode: "denylist",
            allowedDomains: [],
            deniedDomains: [],
        },
        filesystem: {
            denyRead: [],
            allowWrite: ["/tmp"],
            denyWrite: [],
        },
        sockets: {
            deny: [],
        },
        mcp: {
            allowedDomains: [],
            allowWrite: ["/tmp"],
        },
        ...overrides,
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
            // Just verifying a fast command works without explicit timeout
            const result = await execBash("echo fast");
            expect(result.content[0].text).toContain("fast");
        });

        test("respects custom timeout", async () => {
            const result = await execBash("echo quick", 5000);
            expect(result.content[0].text).toContain("quick");
        });
    });

    describe("sandbox disabled", () => {
        test("executes normally when sandbox is disabled", async () => {
            await initSandbox(makeConfig({ enabled: false }));
            const result = await execBash("echo no-sandbox");
            expect(result.content[0].text).toContain("no-sandbox");
        });

        test("executes normally when mode is off", async () => {
            await initSandbox(makeConfig({ mode: "off" }));
            const result = await execBash("echo off-mode");
            expect(result.content[0].text).toContain("off-mode");
        });

        test("no sandbox env vars when disabled", async () => {
            await initSandbox(makeConfig({ enabled: false }));
            // This command prints an env var that would be set by sandbox
            const result = await execBash("echo ${HTTP_PROXY:-none}");
            expect(result.content[0].text).toContain("none");
        });
    });

    describe("sandbox audit mode", () => {
        test("executes command without blocking in audit mode", async () => {
            await initSandbox(makeConfig({ mode: "audit" }));
            const result = await execBash("echo audit-test");
            expect(result.content[0].text).toContain("audit-test");
        });

        test("records violation in audit mode", async () => {
            await initSandbox(makeConfig({ mode: "audit" }));
            await execBash("echo audit-logged");

            const violations = getViolations();
            expect(violations.length).toBe(1);
            expect(violations[0].tier).toBe("bash");
            expect(violations[0].operation).toBe("execute");
        });

        test("logs audit warning to console", async () => {
            const consoleSpy = spyOn(console, "log").mockImplementation(() => {});
            try {
                await initSandbox(makeConfig({ mode: "audit" }));
                await execBash("echo audit-warn");

                // Find the audit log call
                const auditCalls = consoleSpy.mock.calls.filter(
                    (call) => typeof call[0] === "string" && call[0].includes("[sandbox:audit]"),
                );
                expect(auditCalls.length).toBe(1);
                expect(auditCalls[0][0]).toContain("Would sandbox");
                expect(auditCalls[0][0]).toContain("echo audit-warn");
            } finally {
                consoleSpy.mockRestore();
            }
        });

        test("accumulates violations across multiple commands", async () => {
            await initSandbox(makeConfig({ mode: "audit" }));
            await execBash("echo cmd1");
            await execBash("echo cmd2");
            await execBash("echo cmd3");

            const violations = getViolations();
            expect(violations.length).toBe(3);
        });
    });

    describe("sandbox enforce mode", () => {
        // Note: actual sandboxing via SandboxManager.wrapWithSandbox() requires
        // macOS/Linux with the actual sandbox runtime. On CI or unsupported
        // platforms, initSandbox degrades gracefully and isSandboxActive() returns
        // false, so these tests verify the integration plumbing works.

        test("still executes commands after sandbox init (graceful degradation)", async () => {
            // On platforms where sandbox isn't supported, this should still work
            await initSandbox(makeConfig({ mode: "enforce" }));
            const result = await execBash("echo sandboxed");
            expect(result.content[0].text).toContain("sandboxed");
        });

        test("details always contain original command", async () => {
            await initSandbox(makeConfig({ mode: "enforce" }));
            const result = await execBash("echo original");
            // details.command should always be the original, not the wrapped version
            expect(result.details.command).toBe("echo original");
        });
    });

    describe("error handling", () => {
        test("propagates command execution errors", async () => {
            await expect(execBash("exit 1")).rejects.toThrow();
        });

        test("propagates command-not-found errors", async () => {
            await expect(
                execBash("nonexistent_command_xyz_123"),
            ).rejects.toThrow();
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
    });
});
