import { describe, test, expect } from "bun:test";
import { matchesTool, runHook, parseHookOutput } from "./hooks.js";
import { join } from "path";

const FIXTURES_DIR = join(import.meta.dir, "__fixtures__", "hooks");

describe("matchesTool", () => {
    test("matches exact tool name (case-insensitive)", () => {
        expect(matchesTool("Bash", "bash")).toBe(true);
        expect(matchesTool("bash", "bash")).toBe(true);
        expect(matchesTool("Bash", "Bash")).toBe(true);
    });

    test("matches display name", () => {
        expect(matchesTool("Bash", "bash")).toBe(true);
        expect(matchesTool("Edit", "edit")).toBe(true);
        expect(matchesTool("Write", "write")).toBe(true);
        expect(matchesTool("Read", "read")).toBe(true);
    });

    test("supports | alternation", () => {
        expect(matchesTool("Edit|Write", "edit")).toBe(true);
        expect(matchesTool("Edit|Write", "write")).toBe(true);
        expect(matchesTool("Edit|Write", "bash")).toBe(false);
    });

    test("supports .* wildcard", () => {
        expect(matchesTool(".*", "bash")).toBe(true);
        expect(matchesTool(".*", "edit")).toBe(true);
        expect(matchesTool(".*", "anything")).toBe(true);
    });

    test("does not match unrelated tools", () => {
        expect(matchesTool("Bash", "edit")).toBe(false);
        expect(matchesTool("Edit", "bash")).toBe(false);
        expect(matchesTool("Read", "write")).toBe(false);
    });

    test("handles regex patterns", () => {
        expect(matchesTool("mcp__.*", "mcp__github__search")).toBe(true);
        expect(matchesTool("mcp__.*", "bash")).toBe(false);
    });
});

describe("parseHookOutput", () => {
    test("returns null for empty string", () => {
        expect(parseHookOutput("")).toBeNull();
    });

    test("returns null for invalid JSON", () => {
        expect(parseHookOutput("not json")).toBeNull();
    });

    test("parses flat format", () => {
        const result = parseHookOutput(JSON.stringify({
            additionalContext: "Did you mean bun?",
        }));
        expect(result).toEqual({
            additionalContext: "Did you mean bun?",
            permissionDecision: undefined,
            decision: undefined,
        });
    });

    test("parses nested hookSpecificOutput format (Claude Code compat)", () => {
        const result = parseHookOutput(JSON.stringify({
            hookSpecificOutput: {
                hookEventName: "PreToolUse",
                permissionDecision: "allow",
                additionalContext: "Are you using bun?",
            },
        }));
        expect(result).toEqual({
            additionalContext: "Are you using bun?",
            permissionDecision: "allow",
            decision: undefined,
        });
    });

    test("parses deny decision", () => {
        const result = parseHookOutput(JSON.stringify({
            hookSpecificOutput: {
                hookEventName: "PreToolUse",
                permissionDecision: "deny",
                additionalContext: "Blocked for safety",
            },
        }));
        expect(result?.permissionDecision).toBe("deny");
        expect(result?.additionalContext).toBe("Blocked for safety");
    });

    test("parses PostToolUse with block decision", () => {
        const result = parseHookOutput(JSON.stringify({
            hookSpecificOutput: {
                hookEventName: "PostToolUse",
                additionalContext: "Check the error",
            },
            decision: "block",
        }));
        expect(result?.decision).toBe("block");
        expect(result?.additionalContext).toBe("Check the error");
    });
});

describe("runHook", () => {
    test("runs a simple echo hook and captures stdout", async () => {
        const result = await runHook(
            { command: 'echo \'{"additionalContext":"hello"}\'' },
            "{}",
            process.cwd(),
        );
        expect(result.exitCode).toBe(0);
        expect(result.stdout).toContain("additionalContext");
    });

    test("captures exit code 2 for blocking hooks", async () => {
        const result = await runHook(
            { command: 'echo "BLOCKED: test" >&2; exit 2' },
            "{}",
            process.cwd(),
        );
        expect(result.exitCode).toBe(2);
        expect(result.stderr).toContain("BLOCKED: test");
    });

    test("passes stdin payload to the hook", async () => {
        const result = await runHook(
            { command: "cat | jq -r '.tool_input.command'" },
            JSON.stringify({ tool_input: { command: "npm install" } }),
            process.cwd(),
        );
        expect(result.exitCode).toBe(0);
        expect(result.stdout).toBe("npm install");
    });

    test("sets PIZZAPI_PROJECT_DIR environment variable", async () => {
        const result = await runHook(
            { command: "echo $PIZZAPI_PROJECT_DIR" },
            "{}",
            "/tmp",
        );
        expect(result.exitCode).toBe(0);
        expect(result.stdout).toBe("/tmp");
    });

    test("handles hook timeout gracefully", async () => {
        const start = Date.now();
        const result = await runHook(
            { command: "sleep 10", timeout: 500 },
            "{}",
            process.cwd(),
        );
        const elapsed = Date.now() - start;
        // Should finish well before 10s — timeout killed the process
        expect(elapsed).toBeLessThan(5000);
        // stdout should be empty (no output from sleep)
        expect(result.stdout).toBe("");
    });

    test("handles missing command gracefully", async () => {
        const result = await runHook(
            { command: "nonexistent_command_12345" },
            "{}",
            process.cwd(),
        );
        expect(result.exitCode).not.toBe(0);
    });
});

describe("real hook scripts", () => {
    const projectDir = join(import.meta.dir, "../../../..");

    test("block-dangerous-commands.sh blocks force push to main", async () => {
        const result = await runHook(
            { command: `bash "${projectDir}/.pizzapi/hooks/block-dangerous-commands.sh"` },
            JSON.stringify({ tool_input: { command: "git push --force origin main" } }),
            projectDir,
        );
        expect(result.exitCode).toBe(2);
        expect(result.stderr).toContain("BLOCKED");
        expect(result.stderr).toContain("Force push");
    });

    test("block-dangerous-commands.sh allows normal git push", async () => {
        const result = await runHook(
            { command: `bash "${projectDir}/.pizzapi/hooks/block-dangerous-commands.sh"` },
            JSON.stringify({ tool_input: { command: "git push origin feature-branch" } }),
            projectDir,
        );
        expect(result.exitCode).toBe(0);
    });

    test("block-dangerous-commands.sh blocks --no-verify", async () => {
        const result = await runHook(
            { command: `bash "${projectDir}/.pizzapi/hooks/block-dangerous-commands.sh"` },
            JSON.stringify({ tool_input: { command: "git commit --no-verify -m 'test'" } }),
            projectDir,
        );
        expect(result.exitCode).toBe(2);
        expect(result.stderr).toContain("BLOCKED");
    });

    test("lights-on-bun.sh warns about npm usage", async () => {
        const result = await runHook(
            { command: `bash "${projectDir}/.pizzapi/hooks/lights-on-bun.sh"` },
            JSON.stringify({ tool_input: { command: "npm install express" } }),
            projectDir,
        );
        expect(result.exitCode).toBe(0);
        const output = parseHookOutput(result.stdout);
        expect(output?.additionalContext).toContain("Bun exclusively");
    });

    test("lights-on-bun.sh allows bun commands", async () => {
        const result = await runHook(
            { command: `bash "${projectDir}/.pizzapi/hooks/lights-on-bun.sh"` },
            JSON.stringify({ tool_input: { command: "bun install express" } }),
            projectDir,
        );
        expect(result.exitCode).toBe(0);
        expect(result.stdout).toBe("");
    });

    test("lights-on-bun.sh allows npx playwright", async () => {
        const result = await runHook(
            { command: `bash "${projectDir}/.pizzapi/hooks/lights-on-bun.sh"` },
            JSON.stringify({ tool_input: { command: "npx @playwright/mcp@latest" } }),
            projectDir,
        );
        expect(result.exitCode).toBe(0);
        expect(result.stdout).toBe("");
    });

    test("lights-on-no-node-modules.sh blocks edits to node_modules", async () => {
        const result = await runHook(
            { command: `bash "${projectDir}/.pizzapi/hooks/lights-on-no-node-modules.sh"` },
            JSON.stringify({ tool_input: { file_path: "node_modules/foo/index.js" } }),
            projectDir,
        );
        expect(result.exitCode).toBe(2);
        expect(result.stderr).toContain("BLOCKED");
        expect(result.stderr).toContain("patches/");
    });

    test("lights-on-no-node-modules.sh allows edits to src files", async () => {
        const result = await runHook(
            { command: `bash "${projectDir}/.pizzapi/hooks/lights-on-no-node-modules.sh"` },
            JSON.stringify({ tool_input: { file_path: "packages/server/src/index.ts" } }),
            projectDir,
        );
        expect(result.exitCode).toBe(0);
    });

    test("lights-on-tests-post.sh asks about tests for source files", async () => {
        const result = await runHook(
            { command: `bash "${projectDir}/.pizzapi/hooks/lights-on-tests-post.sh"` },
            JSON.stringify({ tool_input: { file_path: "packages/server/src/auth.ts" } }),
            projectDir,
        );
        expect(result.exitCode).toBe(0);
        const output = parseHookOutput(result.stdout);
        expect(output?.additionalContext).toContain("test");
    });

    test("lights-on-tests-post.sh skips test files", async () => {
        const result = await runHook(
            { command: `bash "${projectDir}/.pizzapi/hooks/lights-on-tests-post.sh"` },
            JSON.stringify({ tool_input: { file_path: "packages/server/src/auth.test.ts" } }),
            projectDir,
        );
        expect(result.exitCode).toBe(0);
        expect(result.stdout).toBe("");
    });

    test("lights-on-tests-post.sh skips non-code files", async () => {
        const result = await runHook(
            { command: `bash "${projectDir}/.pizzapi/hooks/lights-on-tests-post.sh"` },
            JSON.stringify({ tool_input: { file_path: "README.md" } }),
            projectDir,
        );
        expect(result.exitCode).toBe(0);
        expect(result.stdout).toBe("");
    });

    test("lights-on-bash-post.sh warns on command failure", async () => {
        const result = await runHook(
            { command: `bash "${projectDir}/.pizzapi/hooks/lights-on-bash-post.sh"` },
            JSON.stringify({
                tool_input: { command: "cat missing-file.txt" },
                tool_response: "error: No such file or directory",
            }),
            projectDir,
        );
        expect(result.exitCode).toBe(0);
        const output = parseHookOutput(result.stdout);
        expect(output?.additionalContext).toContain("failed");
    });

    test("lights-on-bash-post.sh skips test command failures", async () => {
        const result = await runHook(
            { command: `bash "${projectDir}/.pizzapi/hooks/lights-on-bash-post.sh"` },
            JSON.stringify({
                tool_input: { command: "bun test packages/server" },
                tool_response: "error: 2 tests failed",
            }),
            projectDir,
        );
        expect(result.exitCode).toBe(0);
        expect(result.stdout).toBe("");
    });

    test("lights-on-bash-post.sh warns about build order on build failure", async () => {
        const result = await runHook(
            { command: `bash "${projectDir}/.pizzapi/hooks/lights-on-bash-post.sh"` },
            JSON.stringify({
                tool_input: { command: "bun run build:server" },
                tool_response: "error: Cannot find module '../tools/dist/index.js'",
            }),
            projectDir,
        );
        expect(result.exitCode).toBe(0);
        const output = parseHookOutput(result.stdout);
        expect(output?.additionalContext).toContain("build order");
    });
});
