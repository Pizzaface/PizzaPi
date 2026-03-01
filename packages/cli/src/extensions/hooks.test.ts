import { describe, test, expect } from "bun:test";
import { matchesTool, runHook, parseHookOutput, normalizeToolInput } from "./hooks.js";
import { mergeHooks, isProjectHooksTrusted } from "../config.js";
import type { HooksConfig } from "../config.js";
import { join } from "path";

// ---------------------------------------------------------------------------
// matchesTool
// ---------------------------------------------------------------------------

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

    test("preserves regex alternation inside parentheses", () => {
        // Grouped alternation should not be split — the entire pattern is one regex
        expect(matchesTool("mcp__(github|filesystem)__.*", "mcp__github__search")).toBe(true);
        expect(matchesTool("mcp__(github|filesystem)__.*", "mcp__filesystem__read")).toBe(true);
        expect(matchesTool("mcp__(github|filesystem)__.*", "mcp__slack__post")).toBe(false);
    });

    test("handles nested parentheses in regex", () => {
        expect(matchesTool("mcp__((gh|git)hub|filesystem)__.*", "mcp__github__search")).toBe(true);
        expect(matchesTool("mcp__((gh|git)hub|filesystem)__.*", "mcp__github__search")).toBe(true);
        expect(matchesTool("mcp__((gh|git)hub|filesystem)__.*", "mcp__filesystem__read")).toBe(true);
        expect(matchesTool("mcp__((gh|git)hub|filesystem)__.*", "mcp__slack__post")).toBe(false);
    });

    test("top-level | still works alongside grouped alternation", () => {
        // "bash|mcp__(github|filesystem)__.*" has a top-level | between "bash" and the regex
        expect(matchesTool("bash|mcp__(github|filesystem)__.*", "bash")).toBe(true);
        expect(matchesTool("bash|mcp__(github|filesystem)__.*", "mcp__github__search")).toBe(true);
        expect(matchesTool("bash|mcp__(github|filesystem)__.*", "mcp__filesystem__read")).toBe(true);
        expect(matchesTool("bash|mcp__(github|filesystem)__.*", "edit")).toBe(false);
    });
});

// ---------------------------------------------------------------------------
// normalizeToolInput
// ---------------------------------------------------------------------------

describe("normalizeToolInput", () => {
    test("adds file_path alias when path is present", () => {
        const result = normalizeToolInput("write", { path: "/foo/bar.ts", content: "hi" });
        expect(result.path).toBe("/foo/bar.ts");
        expect(result.file_path).toBe("/foo/bar.ts");
        expect(result.content).toBe("hi");
    });

    test("adds path alias when file_path is present", () => {
        const result = normalizeToolInput("write", { file_path: "/foo/bar.ts" });
        expect(result.path).toBe("/foo/bar.ts");
        expect(result.file_path).toBe("/foo/bar.ts");
    });

    test("does not overwrite if both keys exist", () => {
        const result = normalizeToolInput("write", { path: "/a.ts", file_path: "/b.ts" });
        expect(result.path).toBe("/a.ts");
        expect(result.file_path).toBe("/b.ts");
    });

    test("passes through non-file tools unchanged", () => {
        const input = { command: "ls -la" };
        const result = normalizeToolInput("bash", input);
        expect(result).toEqual(input);
    });
});

// ---------------------------------------------------------------------------
// parseHookOutput
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// runHook
// ---------------------------------------------------------------------------

describe("runHook", () => {
    test("runs a simple echo hook and captures stdout", async () => {
        const result = await runHook(
            { command: 'echo \'{"additionalContext":"hello"}\'' },
            "{}",
            process.cwd(),
        );
        expect(result.exitCode).toBe(0);
        expect(result.stdout).toContain("additionalContext");
        expect(result.killed).toBe(false);
    });

    test("captures exit code 2 for blocking hooks", async () => {
        const result = await runHook(
            { command: 'echo "BLOCKED: test" >&2; exit 2' },
            "{}",
            process.cwd(),
        );
        expect(result.exitCode).toBe(2);
        expect(result.stderr).toContain("BLOCKED: test");
        expect(result.killed).toBe(false);
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

    test("marks killed processes with killed=true and non-zero exit", async () => {
        const start = Date.now();
        const result = await runHook(
            { command: "sleep 10", timeout: 500 },
            "{}",
            process.cwd(),
        );
        const elapsed = Date.now() - start;
        // Should finish well before 10s — timeout killed the process
        expect(elapsed).toBeLessThan(5000);
        expect(result.killed).toBe(true);
        expect(result.exitCode).not.toBe(0);
    });

    test("detects kill even when child traps SIGTERM and exits 0", async () => {
        // Child traps SIGTERM and exits 0 — proc.killed should still catch it
        const result = await runHook(
            { command: 'trap "exit 0" TERM; sleep 10', timeout: 500 },
            "{}",
            process.cwd(),
        );
        expect(result.killed).toBe(true);
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

// ---------------------------------------------------------------------------
// mergeHooks
// ---------------------------------------------------------------------------

describe("mergeHooks", () => {
    test("returns undefined when both are undefined", () => {
        expect(mergeHooks(undefined, undefined)).toBeUndefined();
    });

    test("returns first when second is undefined", () => {
        const a: HooksConfig = { PreToolUse: [{ matcher: "Bash", hooks: [{ command: "a.sh" }] }] };
        expect(mergeHooks(a, undefined)).toEqual(a);
    });

    test("returns second when first is undefined", () => {
        const b: HooksConfig = { PostToolUse: [{ matcher: "Edit", hooks: [{ command: "b.sh" }] }] };
        expect(mergeHooks(undefined, b)).toEqual(b);
    });

    test("concatenates PreToolUse and PostToolUse arrays", () => {
        const a: HooksConfig = {
            PreToolUse: [{ matcher: "Bash", hooks: [{ command: "a.sh" }] }],
            PostToolUse: [{ matcher: "Bash", hooks: [{ command: "c.sh" }] }],
        };
        const b: HooksConfig = {
            PreToolUse: [{ matcher: "Edit", hooks: [{ command: "b.sh" }] }],
            PostToolUse: [{ matcher: "Edit", hooks: [{ command: "d.sh" }] }],
        };
        const result = mergeHooks(a, b);
        expect(result?.PreToolUse).toHaveLength(2);
        expect(result?.PostToolUse).toHaveLength(2);
        expect(result?.PreToolUse?.[0].matcher).toBe("Bash");
        expect(result?.PreToolUse?.[1].matcher).toBe("Edit");
    });
});

// ---------------------------------------------------------------------------
// isProjectHooksTrusted
// ---------------------------------------------------------------------------

describe("isProjectHooksTrusted", () => {
    const origEnv = process.env.PIZZAPI_ALLOW_PROJECT_HOOKS;

    test("returns false when global config has no allowProjectHooks", () => {
        delete process.env.PIZZAPI_ALLOW_PROJECT_HOOKS;
        expect(isProjectHooksTrusted({})).toBe(false);
    });

    test("returns true when global config has allowProjectHooks: true", () => {
        delete process.env.PIZZAPI_ALLOW_PROJECT_HOOKS;
        expect(isProjectHooksTrusted({ allowProjectHooks: true })).toBe(true);
    });

    test("returns false when global config has allowProjectHooks: false", () => {
        delete process.env.PIZZAPI_ALLOW_PROJECT_HOOKS;
        expect(isProjectHooksTrusted({ allowProjectHooks: false })).toBe(false);
    });

    test("returns true when PIZZAPI_ALLOW_PROJECT_HOOKS=1 env is set", () => {
        process.env.PIZZAPI_ALLOW_PROJECT_HOOKS = "1";
        expect(isProjectHooksTrusted({})).toBe(true);
    });

    // Restore env
    test("cleanup", () => {
        if (origEnv !== undefined) process.env.PIZZAPI_ALLOW_PROJECT_HOOKS = origEnv;
        else delete process.env.PIZZAPI_ALLOW_PROJECT_HOOKS;
        expect(true).toBe(true);
    });
});

// ---------------------------------------------------------------------------
// Real hook scripts — integration tests
// ---------------------------------------------------------------------------

describe("real hook scripts", () => {
    const projectDir = join(import.meta.dir, "../../../..");

    // -- block-dangerous-commands.sh --

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

    test("block-dangerous-commands.sh blocks -f push to main", async () => {
        const result = await runHook(
            { command: `bash "${projectDir}/.pizzapi/hooks/block-dangerous-commands.sh"` },
            JSON.stringify({ tool_input: { command: "git push -f origin main" } }),
            projectDir,
        );
        expect(result.exitCode).toBe(2);
        expect(result.stderr).toContain("BLOCKED");
    });

    test("block-dangerous-commands.sh blocks --force-with-lease to main", async () => {
        const result = await runHook(
            { command: `bash "${projectDir}/.pizzapi/hooks/block-dangerous-commands.sh"` },
            JSON.stringify({ tool_input: { command: "git push --force-with-lease origin main" } }),
            projectDir,
        );
        expect(result.exitCode).toBe(2);
        expect(result.stderr).toContain("BLOCKED");
    });

    test("block-dangerous-commands.sh allows normal git push", async () => {
        const result = await runHook(
            { command: `bash "${projectDir}/.pizzapi/hooks/block-dangerous-commands.sh"` },
            JSON.stringify({ tool_input: { command: "git push origin feature-branch" } }),
            projectDir,
        );
        expect(result.exitCode).toBe(0);
    });

    test("block-dangerous-commands.sh blocks --no-verify on commit", async () => {
        const result = await runHook(
            { command: `bash "${projectDir}/.pizzapi/hooks/block-dangerous-commands.sh"` },
            JSON.stringify({ tool_input: { command: "git commit --no-verify -m 'test'" } }),
            projectDir,
        );
        expect(result.exitCode).toBe(2);
        expect(result.stderr).toContain("BLOCKED");
    });

    test("block-dangerous-commands.sh blocks --no-verify on push", async () => {
        const result = await runHook(
            { command: `bash "${projectDir}/.pizzapi/hooks/block-dangerous-commands.sh"` },
            JSON.stringify({ tool_input: { command: "git push --no-verify origin main" } }),
            projectDir,
        );
        expect(result.exitCode).toBe(2);
        expect(result.stderr).toContain("BLOCKED");
    });

    test("block-dangerous-commands.sh blocks rm -r -f / (split flags)", async () => {
        const result = await runHook(
            { command: `bash "${projectDir}/.pizzapi/hooks/block-dangerous-commands.sh"` },
            JSON.stringify({ tool_input: { command: "rm -r -f /" } }),
            projectDir,
        );
        expect(result.exitCode).toBe(2);
        expect(result.stderr).toContain("BLOCKED");
        expect(result.stderr).toContain("Recursive delete");
    });

    test("block-dangerous-commands.sh blocks rm -f -r / (split flags, reversed)", async () => {
        const result = await runHook(
            { command: `bash "${projectDir}/.pizzapi/hooks/block-dangerous-commands.sh"` },
            JSON.stringify({ tool_input: { command: "rm -f -r /" } }),
            projectDir,
        );
        expect(result.exitCode).toBe(2);
        expect(result.stderr).toContain("BLOCKED");
    });

    test("block-dangerous-commands.sh blocks rm --recursive --force /", async () => {
        const result = await runHook(
            { command: `bash "${projectDir}/.pizzapi/hooks/block-dangerous-commands.sh"` },
            JSON.stringify({ tool_input: { command: "rm --recursive --force /" } }),
            projectDir,
        );
        expect(result.exitCode).toBe(2);
        expect(result.stderr).toContain("BLOCKED");
    });

    test("block-dangerous-commands.sh blocks rm --recursive -f /", async () => {
        const result = await runHook(
            { command: `bash "${projectDir}/.pizzapi/hooks/block-dangerous-commands.sh"` },
            JSON.stringify({ tool_input: { command: "rm --recursive -f /" } }),
            projectDir,
        );
        expect(result.exitCode).toBe(2);
        expect(result.stderr).toContain("BLOCKED");
    });

    test("block-dangerous-commands.sh blocks rm -r --force ~", async () => {
        const result = await runHook(
            { command: `bash "${projectDir}/.pizzapi/hooks/block-dangerous-commands.sh"` },
            JSON.stringify({ tool_input: { command: "rm -r --force ~" } }),
            projectDir,
        );
        expect(result.exitCode).toBe(2);
        expect(result.stderr).toContain("BLOCKED");
    });

    test("block-dangerous-commands.sh blocks rm -rf ..", async () => {
        const result = await runHook(
            { command: `bash "${projectDir}/.pizzapi/hooks/block-dangerous-commands.sh"` },
            JSON.stringify({ tool_input: { command: "rm -rf .." } }),
            projectDir,
        );
        expect(result.exitCode).toBe(2);
        expect(result.stderr).toContain("BLOCKED");
    });

    test("block-dangerous-commands.sh allows rm -rf on safe paths", async () => {
        const result = await runHook(
            { command: `bash "${projectDir}/.pizzapi/hooks/block-dangerous-commands.sh"` },
            JSON.stringify({ tool_input: { command: "rm -rf ./dist" } }),
            projectDir,
        );
        expect(result.exitCode).toBe(0);
    });

    test("block-dangerous-commands.sh blocks rm -r .git", async () => {
        const result = await runHook(
            { command: `bash "${projectDir}/.pizzapi/hooks/block-dangerous-commands.sh"` },
            JSON.stringify({ tool_input: { command: "rm -r .git" } }),
            projectDir,
        );
        expect(result.exitCode).toBe(2);
        expect(result.stderr).toContain("BLOCKED");
        expect(result.stderr).toContain(".git");
    });

    test("block-dangerous-commands.sh blocks rm --recursive .git/", async () => {
        const result = await runHook(
            { command: `bash "${projectDir}/.pizzapi/hooks/block-dangerous-commands.sh"` },
            JSON.stringify({ tool_input: { command: "rm --recursive .git/" } }),
            projectDir,
        );
        expect(result.exitCode).toBe(2);
        expect(result.stderr).toContain("BLOCKED");
    });

    // -- lights-on-bun.sh --

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

    // -- lights-on-no-node-modules.sh (with both path keys) --

    test("lights-on-no-node-modules.sh blocks edits using file_path key", async () => {
        const result = await runHook(
            { command: `bash "${projectDir}/.pizzapi/hooks/lights-on-no-node-modules.sh"` },
            JSON.stringify({ tool_input: { file_path: "node_modules/foo/index.js" } }),
            projectDir,
        );
        expect(result.exitCode).toBe(2);
        expect(result.stderr).toContain("BLOCKED");
        expect(result.stderr).toContain("patches/");
    });

    test("lights-on-no-node-modules.sh blocks edits using path key (pi format)", async () => {
        const result = await runHook(
            { command: `bash "${projectDir}/.pizzapi/hooks/lights-on-no-node-modules.sh"` },
            JSON.stringify({ tool_input: { path: "node_modules/foo/index.js" } }),
            projectDir,
        );
        expect(result.exitCode).toBe(2);
        expect(result.stderr).toContain("BLOCKED");
    });

    test("lights-on-no-node-modules.sh allows edits to src files", async () => {
        const result = await runHook(
            { command: `bash "${projectDir}/.pizzapi/hooks/lights-on-no-node-modules.sh"` },
            JSON.stringify({ tool_input: { path: "packages/server/src/index.ts" } }),
            projectDir,
        );
        expect(result.exitCode).toBe(0);
    });

    // -- lights-on-tests-post.sh (with both path keys) --

    test("lights-on-tests-post.sh asks about tests for source files (path key)", async () => {
        const result = await runHook(
            { command: `bash "${projectDir}/.pizzapi/hooks/lights-on-tests-post.sh"` },
            JSON.stringify({ tool_input: { path: "packages/server/src/auth.ts" } }),
            projectDir,
        );
        expect(result.exitCode).toBe(0);
        const output = parseHookOutput(result.stdout);
        expect(output?.additionalContext).toContain("test");
    });

    test("lights-on-tests-post.sh asks about tests for source files (file_path key)", async () => {
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
            JSON.stringify({ tool_input: { path: "packages/server/src/auth.test.ts" } }),
            projectDir,
        );
        expect(result.exitCode).toBe(0);
        expect(result.stdout).toBe("");
    });

    test("lights-on-tests-post.sh skips non-code files", async () => {
        const result = await runHook(
            { command: `bash "${projectDir}/.pizzapi/hooks/lights-on-tests-post.sh"` },
            JSON.stringify({ tool_input: { path: "README.md" } }),
            projectDir,
        );
        expect(result.exitCode).toBe(0);
        expect(result.stdout).toBe("");
    });

    // -- lights-on-bash-post.sh --

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
