import { describe, test, expect } from "bun:test";
import { matchesTool, runHook, parseHookOutput, normalizeToolInput, runEventHooks, runFireAndForgetHooks, resolveShell, _resetShellCache } from "./hooks.js";
import { mergeHooks, isProjectHooksTrusted } from "../config.js";
import type { HooksConfig, HookEntry } from "../config.js";
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
// resolveShell
// ---------------------------------------------------------------------------

describe("resolveShell", () => {
    test("returns /bin/sh -c on non-Windows", () => {
        if (process.platform !== "win32") {
            _resetShellCache();
            const { shell, flag } = resolveShell();
            expect(shell).toBe("/bin/sh");
            expect(flag).toBe("-c");
        }
    });

    test("shell and flag are non-empty strings", () => {
        _resetShellCache();
        const { shell, flag } = resolveShell();
        expect(typeof shell).toBe("string");
        expect(shell.length).toBeGreaterThan(0);
        expect(typeof flag).toBe("string");
        expect(flag.length).toBeGreaterThan(0);
    });

    test("result is cached across calls", () => {
        _resetShellCache();
        const first = resolveShell();
        const second = resolveShell();
        expect(first).toBe(second); // same object reference
    });

    test("flag is always -c (bash-compatible)", () => {
        _resetShellCache();
        const { flag } = resolveShell();
        expect(flag).toBe("-c");
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

    test("block-dangerous-commands.sh blocks force push to HEAD:refs/heads/main", async () => {
        const result = await runHook(
            { command: `bash "${projectDir}/.pizzapi/hooks/block-dangerous-commands.sh"` },
            JSON.stringify({ tool_input: { command: "git push --force origin HEAD:refs/heads/main" } }),
            projectDir,
        );
        expect(result.exitCode).toBe(2);
        expect(result.stderr).toContain("BLOCKED");
    });

    test("block-dangerous-commands.sh blocks force push to refs/heads/main", async () => {
        const result = await runHook(
            { command: `bash "${projectDir}/.pizzapi/hooks/block-dangerous-commands.sh"` },
            JSON.stringify({ tool_input: { command: "git push -f origin refs/heads/main" } }),
            projectDir,
        );
        expect(result.exitCode).toBe(2);
        expect(result.stderr).toContain("BLOCKED");
    });

    test("block-dangerous-commands.sh blocks +main refspec force push", async () => {
        const result = await runHook(
            { command: `bash "${projectDir}/.pizzapi/hooks/block-dangerous-commands.sh"` },
            JSON.stringify({ tool_input: { command: "git push origin +main" } }),
            projectDir,
        );
        expect(result.exitCode).toBe(2);
        expect(result.stderr).toContain("BLOCKED");
    });

    test("block-dangerous-commands.sh blocks +HEAD:main refspec force push", async () => {
        const result = await runHook(
            { command: `bash "${projectDir}/.pizzapi/hooks/block-dangerous-commands.sh"` },
            JSON.stringify({ tool_input: { command: "git push origin +HEAD:main" } }),
            projectDir,
        );
        expect(result.exitCode).toBe(2);
        expect(result.stderr).toContain("BLOCKED");
    });

    test("block-dangerous-commands.sh blocks quoted git executable force push", async () => {
        const result = await runHook(
            { command: `bash "${projectDir}/.pizzapi/hooks/block-dangerous-commands.sh"` },
            JSON.stringify({ tool_input: { command: '"/usr/bin/git" push --force origin main' } }),
            projectDir,
        );
        expect(result.exitCode).toBe(2);
        expect(result.stderr).toContain("BLOCKED");
    });

    test("block-dangerous-commands.sh blocks single-quoted git executable force push", async () => {
        const result = await runHook(
            { command: `bash "${projectDir}/.pizzapi/hooks/block-dangerous-commands.sh"` },
            JSON.stringify({ tool_input: { command: "'/usr/bin/git' push --force origin main" } }),
            projectDir,
        );
        expect(result.exitCode).toBe(2);
        expect(result.stderr).toContain("BLOCKED");
    });

    test("block-dangerous-commands.sh blocks git -C force push", async () => {
        const result = await runHook(
            { command: `bash "${projectDir}/.pizzapi/hooks/block-dangerous-commands.sh"` },
            JSON.stringify({ tool_input: { command: "git -C ./repo push --force origin main" } }),
            projectDir,
        );
        expect(result.exitCode).toBe(2);
        expect(result.stderr).toContain("BLOCKED");
    });

    test("block-dangerous-commands.sh blocks sudo git force push", async () => {
        const result = await runHook(
            { command: `bash "${projectDir}/.pizzapi/hooks/block-dangerous-commands.sh"` },
            JSON.stringify({ tool_input: { command: "sudo git push --force origin main" } }),
            projectDir,
        );
        expect(result.exitCode).toBe(2);
        expect(result.stderr).toContain("BLOCKED");
    });

    test("block-dangerous-commands.sh blocks command git force push", async () => {
        const result = await runHook(
            { command: `bash "${projectDir}/.pizzapi/hooks/block-dangerous-commands.sh"` },
            JSON.stringify({ tool_input: { command: "command git push --force origin main" } }),
            projectDir,
        );
        expect(result.exitCode).toBe(2);
        expect(result.stderr).toContain("BLOCKED");
    });

    test("block-dangerous-commands.sh blocks force push when branch is quoted", async () => {
        const result = await runHook(
            { command: `bash "${projectDir}/.pizzapi/hooks/block-dangerous-commands.sh"` },
            JSON.stringify({ tool_input: { command: 'git push --force origin "main"' } }),
            projectDir,
        );
        expect(result.exitCode).toBe(2);
        expect(result.stderr).toContain("BLOCKED");
    });

    // -- Implicit refspec force push (no branch on CLI → uses current branch) --

    test("block-dangerous-commands.sh blocks force push with no refspec when on main", async () => {
        // `git push --force origin` with no branch — pushes current branch.
        // When current branch is main/master, this must be blocked.
        // This test only works in a git repo where HEAD points to main/master
        // or we need to simulate. We test the script directly by checking
        // the current branch first.
        const branchResult = await runHook(
            { command: "git symbolic-ref --short HEAD 2>/dev/null || echo unknown" },
            "{}",
            projectDir,
        );
        const currentBranch = branchResult.stdout.trim();

        const result = await runHook(
            { command: `bash "${projectDir}/.pizzapi/hooks/block-dangerous-commands.sh"` },
            JSON.stringify({ tool_input: { command: "git push --force origin" } }),
            projectDir,
        );

        if (currentBranch === "main" || currentBranch === "master") {
            expect(result.exitCode).toBe(2);
            expect(result.stderr).toContain("BLOCKED");
            expect(result.stderr).toContain("Force push");
        } else {
            // On a feature branch, implicit refspec is allowed
            expect(result.exitCode).toBe(0);
        }
    });

    test("block-dangerous-commands.sh blocks force push with no args when on main", async () => {
        // `git push --force` — no remote, no refspec
        const branchResult = await runHook(
            { command: "git symbolic-ref --short HEAD 2>/dev/null || echo unknown" },
            "{}",
            projectDir,
        );
        const currentBranch = branchResult.stdout.trim();

        const result = await runHook(
            { command: `bash "${projectDir}/.pizzapi/hooks/block-dangerous-commands.sh"` },
            JSON.stringify({ tool_input: { command: "git push --force" } }),
            projectDir,
        );

        if (currentBranch === "main" || currentBranch === "master") {
            expect(result.exitCode).toBe(2);
            expect(result.stderr).toContain("BLOCKED");
        } else {
            expect(result.exitCode).toBe(0);
        }
    });

    test("block-dangerous-commands.sh blocks -f push with no refspec when on main", async () => {
        const branchResult = await runHook(
            { command: "git symbolic-ref --short HEAD 2>/dev/null || echo unknown" },
            "{}",
            projectDir,
        );
        const currentBranch = branchResult.stdout.trim();

        const result = await runHook(
            { command: `bash "${projectDir}/.pizzapi/hooks/block-dangerous-commands.sh"` },
            JSON.stringify({ tool_input: { command: "git push -f origin" } }),
            projectDir,
        );

        if (currentBranch === "main" || currentBranch === "master") {
            expect(result.exitCode).toBe(2);
            expect(result.stderr).toContain("BLOCKED");
        } else {
            expect(result.exitCode).toBe(0);
        }
    });

    test("block-dangerous-commands.sh allows force push to explicit feature branch", async () => {
        // `git push --force origin feature-branch` — explicit non-protected refspec
        const result = await runHook(
            { command: `bash "${projectDir}/.pizzapi/hooks/block-dangerous-commands.sh"` },
            JSON.stringify({ tool_input: { command: "git push --force origin feature-branch" } }),
            projectDir,
        );
        expect(result.exitCode).toBe(0);
    });

    test("block-dangerous-commands.sh allows +main:feature refspec force push", async () => {
        const result = await runHook(
            { command: `bash "${projectDir}/.pizzapi/hooks/block-dangerous-commands.sh"` },
            JSON.stringify({ tool_input: { command: "git push origin +main:feature-branch" } }),
            projectDir,
        );
        expect(result.exitCode).toBe(0);
    });

    test("block-dangerous-commands.sh allows normal git push", async () => {
        const result = await runHook(
            { command: `bash "${projectDir}/.pizzapi/hooks/block-dangerous-commands.sh"` },
            JSON.stringify({ tool_input: { command: "git push origin feature-branch" } }),
            projectDir,
        );
        expect(result.exitCode).toBe(0);
    });

    test("block-dangerous-commands.sh blocks deleting main with --delete", async () => {
        const result = await runHook(
            { command: `bash "${projectDir}/.pizzapi/hooks/block-dangerous-commands.sh"` },
            JSON.stringify({ tool_input: { command: "git push origin --delete main" } }),
            projectDir,
        );
        expect(result.exitCode).toBe(2);
        expect(result.stderr).toContain("BLOCKED");
    });

    test("block-dangerous-commands.sh blocks deleting main with :main refspec", async () => {
        const result = await runHook(
            { command: `bash "${projectDir}/.pizzapi/hooks/block-dangerous-commands.sh"` },
            JSON.stringify({ tool_input: { command: "git push origin :main" } }),
            projectDir,
        );
        expect(result.exitCode).toBe(2);
        expect(result.stderr).toContain("BLOCKED");
    });

    test("block-dangerous-commands.sh blocks deleting refs/heads/main with :refspec", async () => {
        const result = await runHook(
            { command: `bash "${projectDir}/.pizzapi/hooks/block-dangerous-commands.sh"` },
            JSON.stringify({ tool_input: { command: "git push origin :refs/heads/main" } }),
            projectDir,
        );
        expect(result.exitCode).toBe(2);
        expect(result.stderr).toContain("BLOCKED");
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

    test("block-dangerous-commands.sh blocks git -C push --no-verify", async () => {
        const result = await runHook(
            { command: `bash "${projectDir}/.pizzapi/hooks/block-dangerous-commands.sh"` },
            JSON.stringify({ tool_input: { command: "git -C ./repo push --no-verify origin feature" } }),
            projectDir,
        );
        expect(result.exitCode).toBe(2);
        expect(result.stderr).toContain("BLOCKED");
    });

    test("block-dangerous-commands.sh blocks command git commit --no-verify", async () => {
        const result = await runHook(
            { command: `bash "${projectDir}/.pizzapi/hooks/block-dangerous-commands.sh"` },
            JSON.stringify({ tool_input: { command: "command git commit --no-verify -m test" } }),
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

    test("block-dangerous-commands.sh blocks rm -rf ../", async () => {
        const result = await runHook(
            { command: `bash "${projectDir}/.pizzapi/hooks/block-dangerous-commands.sh"` },
            JSON.stringify({ tool_input: { command: "rm -rf ../" } }),
            projectDir,
        );
        expect(result.exitCode).toBe(2);
        expect(result.stderr).toContain("BLOCKED");
    });

    test("block-dangerous-commands.sh blocks rm -rf ../../", async () => {
        const result = await runHook(
            { command: `bash "${projectDir}/.pizzapi/hooks/block-dangerous-commands.sh"` },
            JSON.stringify({ tool_input: { command: "rm -rf ../../" } }),
            projectDir,
        );
        expect(result.exitCode).toBe(2);
        expect(result.stderr).toContain("BLOCKED");
    });

    test("block-dangerous-commands.sh blocks rm -rf ./../", async () => {
        const result = await runHook(
            { command: `bash "${projectDir}/.pizzapi/hooks/block-dangerous-commands.sh"` },
            JSON.stringify({ tool_input: { command: "rm -rf ./../" } }),
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

    // Absolute-path rm binaries (codex review: catch /bin/rm, /usr/bin/rm)

    test("block-dangerous-commands.sh blocks /bin/rm -rf /", async () => {
        const result = await runHook(
            { command: `bash "${projectDir}/.pizzapi/hooks/block-dangerous-commands.sh"` },
            JSON.stringify({ tool_input: { command: "/bin/rm -rf /" } }),
            projectDir,
        );
        expect(result.exitCode).toBe(2);
        expect(result.stderr).toContain("BLOCKED");
    });

    test("block-dangerous-commands.sh blocks /usr/bin/rm -rf /", async () => {
        const result = await runHook(
            { command: `bash "${projectDir}/.pizzapi/hooks/block-dangerous-commands.sh"` },
            JSON.stringify({ tool_input: { command: "/usr/bin/rm -rf /" } }),
            projectDir,
        );
        expect(result.exitCode).toBe(2);
        expect(result.stderr).toContain("BLOCKED");
    });

    test("block-dangerous-commands.sh blocks sudo /bin/rm -rf /", async () => {
        const result = await runHook(
            { command: `bash "${projectDir}/.pizzapi/hooks/block-dangerous-commands.sh"` },
            JSON.stringify({ tool_input: { command: "sudo /bin/rm -rf /" } }),
            projectDir,
        );
        expect(result.exitCode).toBe(2);
        expect(result.stderr).toContain("BLOCKED");
    });

    test("block-dangerous-commands.sh blocks /bin/rm -r .git", async () => {
        const result = await runHook(
            { command: `bash "${projectDir}/.pizzapi/hooks/block-dangerous-commands.sh"` },
            JSON.stringify({ tool_input: { command: "/bin/rm -r .git" } }),
            projectDir,
        );
        expect(result.exitCode).toBe(2);
        expect(result.stderr).toContain("BLOCKED");
    });

    test("block-dangerous-commands.sh blocks quoted /bin/rm executable", async () => {
        const result = await runHook(
            { command: `bash "${projectDir}/.pizzapi/hooks/block-dangerous-commands.sh"` },
            JSON.stringify({ tool_input: { command: '"/bin/rm" -rf /' } }),
            projectDir,
        );
        expect(result.exitCode).toBe(2);
        expect(result.stderr).toContain("BLOCKED");
    });

    test("block-dangerous-commands.sh blocks single-quoted /bin/rm executable", async () => {
        const result = await runHook(
            { command: `bash "${projectDir}/.pizzapi/hooks/block-dangerous-commands.sh"` },
            JSON.stringify({ tool_input: { command: "'/bin/rm' -rf /" } }),
            projectDir,
        );
        expect(result.exitCode).toBe(2);
        expect(result.stderr).toContain("BLOCKED");
    });

    test("block-dangerous-commands.sh blocks rm -rf /*", async () => {
        const result = await runHook(
            { command: `bash "${projectDir}/.pizzapi/hooks/block-dangerous-commands.sh"` },
            JSON.stringify({ tool_input: { command: "rm -rf /*" } }),
            projectDir,
        );
        expect(result.exitCode).toBe(2);
        expect(result.stderr).toContain("BLOCKED");
    });

    test("block-dangerous-commands.sh blocks rm -rf $HOME/*", async () => {
        const result = await runHook(
            { command: `bash "${projectDir}/.pizzapi/hooks/block-dangerous-commands.sh"` },
            JSON.stringify({ tool_input: { command: "rm -rf $HOME/*" } }),
            projectDir,
        );
        expect(result.exitCode).toBe(2);
        expect(result.stderr).toContain("BLOCKED");
    });

    // Quoted targets (codex review: rm -rf "/" should still be caught)

    test('block-dangerous-commands.sh blocks rm -rf "/"', async () => {
        const result = await runHook(
            { command: `bash "${projectDir}/.pizzapi/hooks/block-dangerous-commands.sh"` },
            JSON.stringify({ tool_input: { command: 'rm -rf "/"' } }),
            projectDir,
        );
        expect(result.exitCode).toBe(2);
        expect(result.stderr).toContain("BLOCKED");
    });

    test("block-dangerous-commands.sh blocks rm -rf '~'", async () => {
        const result = await runHook(
            { command: `bash "${projectDir}/.pizzapi/hooks/block-dangerous-commands.sh"` },
            JSON.stringify({ tool_input: { command: "rm -rf '~'" } }),
            projectDir,
        );
        expect(result.exitCode).toBe(2);
        expect(result.stderr).toContain("BLOCKED");
    });

    test('block-dangerous-commands.sh blocks /bin/rm -rf "/"', async () => {
        const result = await runHook(
            { command: `bash "${projectDir}/.pizzapi/hooks/block-dangerous-commands.sh"` },
            JSON.stringify({ tool_input: { command: '/bin/rm -rf "/"' } }),
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

// ---------------------------------------------------------------------------
// parseHookOutput — new fields (Input, BeforeAgentStart)
// ---------------------------------------------------------------------------

describe("parseHookOutput — new fields", () => {
    test("parses Input hook text transform", () => {
        const result = parseHookOutput(JSON.stringify({
            text: "bun install express",
        }));
        expect(result?.text).toBe("bun install express");
    });

    test("parses Input hook action: handled", () => {
        const result = parseHookOutput(JSON.stringify({
            action: "handled",
        }));
        expect(result?.action).toBe("handled");
    });

    test("parses Input hook action: transform with text", () => {
        const result = parseHookOutput(JSON.stringify({
            action: "transform",
            text: "rewritten text",
        }));
        expect(result?.action).toBe("transform");
        expect(result?.text).toBe("rewritten text");
    });

    test("parses BeforeAgentStart systemPrompt", () => {
        const result = parseHookOutput(JSON.stringify({
            systemPrompt: "You are a helpful assistant focused on testing.",
        }));
        expect(result?.systemPrompt).toBe("You are a helpful assistant focused on testing.");
    });

    test("parses combined BeforeAgentStart context and systemPrompt", () => {
        const result = parseHookOutput(JSON.stringify({
            additionalContext: "Remember to use bun",
            systemPrompt: "Custom system prompt",
        }));
        expect(result?.additionalContext).toBe("Remember to use bun");
        expect(result?.systemPrompt).toBe("Custom system prompt");
    });

    test("parses nested hookSpecificOutput with new fields", () => {
        const result = parseHookOutput(JSON.stringify({
            hookSpecificOutput: {
                text: "transformed text",
                action: "transform",
            },
        }));
        expect(result?.text).toBe("transformed text");
        expect(result?.action).toBe("transform");
    });
});

// ---------------------------------------------------------------------------
// runEventHooks
// ---------------------------------------------------------------------------

describe("runEventHooks", () => {
    test("returns blocked=false when hook exits 0 with no output", async () => {
        const hooks: HookEntry[] = [{ command: "true" }];
        const result = await runEventHooks(hooks, "{}", process.cwd(), "Test");
        expect(result.blocked).toBe(false);
        expect(result.outputs).toHaveLength(0);
    });

    test("returns blocked=true when hook exits 2", async () => {
        const hooks: HookEntry[] = [{ command: 'echo "BLOCKED: test reason" >&2; exit 2' }];
        const result = await runEventHooks(hooks, "{}", process.cwd(), "Test");
        expect(result.blocked).toBe(true);
        expect(result.reason).toContain("BLOCKED: test reason");
    });

    test("returns blocked=true when hook exits non-zero (not 2)", async () => {
        const hooks: HookEntry[] = [{ command: "exit 1" }];
        const result = await runEventHooks(hooks, "{}", process.cwd(), "Test");
        expect(result.blocked).toBe(true);
        expect(result.reason).toContain("exited with code 1");
    });

    test("returns blocked=true when hook times out", async () => {
        const hooks: HookEntry[] = [{ command: "sleep 10", timeout: 200 }];
        const result = await runEventHooks(hooks, "{}", process.cwd(), "Test");
        expect(result.blocked).toBe(true);
        expect(result.reason).toContain("timed out");
    });

    test("collects JSON outputs from successful hooks", async () => {
        const hooks: HookEntry[] = [
            { command: 'echo \'{"additionalContext":"ctx1"}\'' },
            { command: 'echo \'{"additionalContext":"ctx2"}\'' },
        ];
        const result = await runEventHooks(hooks, "{}", process.cwd(), "Test");
        expect(result.blocked).toBe(false);
        expect(result.outputs).toHaveLength(2);
        expect(result.outputs[0].additionalContext).toBe("ctx1");
        expect(result.outputs[1].additionalContext).toBe("ctx2");
    });

    test("stops at first blocking hook, preserving earlier outputs", async () => {
        const hooks: HookEntry[] = [
            { command: 'echo \'{"additionalContext":"before block"}\'' },
            { command: "exit 2" },
            { command: 'echo \'{"additionalContext":"should not run"}\'' },
        ];
        const result = await runEventHooks(hooks, "{}", process.cwd(), "Test");
        expect(result.blocked).toBe(true);
        expect(result.outputs).toHaveLength(1);
        expect(result.outputs[0].additionalContext).toBe("before block");
    });

    test("passes payload to hooks on stdin", async () => {
        const hooks: HookEntry[] = [
            { command: "cat | jq -r '.event'" },
        ];
        const payload = JSON.stringify({ event: "Test", data: "hello" });
        const result = await runEventHooks(hooks, payload, process.cwd(), "Test");
        expect(result.blocked).toBe(false);
        // The hook ran jq on the input and printed "Test" to stdout
        // which is not valid JSON, so outputs will be empty
        expect(result.outputs).toHaveLength(0);
    });

    test("collects text transform output from Input hook", async () => {
        const hooks: HookEntry[] = [
            { command: 'echo \'{"text":"bun install express","action":"transform"}\'' },
        ];
        const result = await runEventHooks(hooks, "{}", process.cwd(), "Input");
        expect(result.blocked).toBe(false);
        expect(result.outputs).toHaveLength(1);
        expect(result.outputs[0].text).toBe("bun install express");
        expect(result.outputs[0].action).toBe("transform");
    });

    test("collects systemPrompt from BeforeAgentStart hook", async () => {
        const hooks: HookEntry[] = [
            { command: 'echo \'{"systemPrompt":"Custom prompt","additionalContext":"Remember X"}\'' },
        ];
        const result = await runEventHooks(hooks, "{}", process.cwd(), "BeforeAgentStart");
        expect(result.blocked).toBe(false);
        expect(result.outputs[0].systemPrompt).toBe("Custom prompt");
        expect(result.outputs[0].additionalContext).toBe("Remember X");
    });
});

// ---------------------------------------------------------------------------
// runFireAndForgetHooks
// ---------------------------------------------------------------------------

describe("runFireAndForgetHooks", () => {
    test("runs hooks without blocking on errors", async () => {
        const hooks: HookEntry[] = [
            { command: "exit 1" },
            { command: "true" },
        ];
        // Should not throw
        await runFireAndForgetHooks(hooks, "{}", process.cwd(), "Test");
    });

    test("runs hooks without blocking on timeouts", async () => {
        const hooks: HookEntry[] = [
            { command: "sleep 10", timeout: 200 },
        ];
        const start = Date.now();
        await runFireAndForgetHooks(hooks, "{}", process.cwd(), "Test");
        const elapsed = Date.now() - start;
        // Should finish relatively quickly (timeout + some overhead)
        expect(elapsed).toBeLessThan(2000);
    });

    test("runs all hooks even if some fail", async () => {
        // We can't easily observe that hooks ran, but we can verify no exceptions
        const hooks: HookEntry[] = [
            { command: "exit 1" },
            { command: "exit 2" },
            { command: "true" },
        ];
        await runFireAndForgetHooks(hooks, "{}", process.cwd(), "Test");
    });
});

// ---------------------------------------------------------------------------
// mergeHooks — new event hook types
// ---------------------------------------------------------------------------

describe("mergeHooks — event hooks", () => {
    test("merges Input hooks from both sources", () => {
        const a: HooksConfig = {
            Input: [{ command: "a.sh" }],
        };
        const b: HooksConfig = {
            Input: [{ command: "b.sh" }],
        };
        const result = mergeHooks(a, b);
        expect(result?.Input).toHaveLength(2);
        expect(result?.Input?.[0].command).toBe("a.sh");
        expect(result?.Input?.[1].command).toBe("b.sh");
    });

    test("merges BeforeAgentStart hooks", () => {
        const a: HooksConfig = {
            BeforeAgentStart: [{ command: "a.sh" }],
        };
        const b: HooksConfig = {};
        const result = mergeHooks(a, b);
        expect(result?.BeforeAgentStart).toHaveLength(1);
    });

    test("merges UserBash hooks", () => {
        const a: HooksConfig = {};
        const b: HooksConfig = {
            UserBash: [{ command: "guard.sh" }],
        };
        const result = mergeHooks(a, b);
        expect(result?.UserBash).toHaveLength(1);
    });

    test("merges SessionBeforeSwitch hooks", () => {
        const a: HooksConfig = { SessionBeforeSwitch: [{ command: "a.sh" }] };
        const b: HooksConfig = { SessionBeforeSwitch: [{ command: "b.sh" }] };
        const result = mergeHooks(a, b);
        expect(result?.SessionBeforeSwitch).toHaveLength(2);
    });

    test("merges SessionBeforeFork hooks", () => {
        const a: HooksConfig = { SessionBeforeFork: [{ command: "check.sh" }] };
        const result = mergeHooks(a, undefined);
        expect(result?.SessionBeforeFork).toHaveLength(1);
    });

    test("merges SessionShutdown hooks", () => {
        const a: HooksConfig = { SessionShutdown: [{ command: "cleanup.sh" }] };
        const b: HooksConfig = { SessionShutdown: [{ command: "save.sh" }] };
        const result = mergeHooks(a, b);
        expect(result?.SessionShutdown).toHaveLength(2);
    });

    test("merges ModelSelect hooks", () => {
        const result = mergeHooks(
            { ModelSelect: [{ command: "log.sh" }] },
            { ModelSelect: [{ command: "notify.sh" }] },
        );
        expect(result?.ModelSelect).toHaveLength(2);
    });

    test("merges SessionBeforeCompact hooks", () => {
        const result = mergeHooks(
            { SessionBeforeCompact: [{ command: "check.sh" }] },
            undefined,
        );
        expect(result?.SessionBeforeCompact).toHaveLength(1);
    });

    test("merges SessionBeforeTree hooks", () => {
        const result = mergeHooks(
            undefined,
            { SessionBeforeTree: [{ command: "guard.sh" }] },
        );
        expect(result?.SessionBeforeTree).toHaveLength(1);
    });

    test("merges mixed PreToolUse and event hooks", () => {
        const a: HooksConfig = {
            PreToolUse: [{ matcher: "Bash", hooks: [{ command: "pre.sh" }] }],
            Input: [{ command: "input.sh" }],
            SessionShutdown: [{ command: "shutdown.sh" }],
        };
        const b: HooksConfig = {
            PostToolUse: [{ matcher: ".*", hooks: [{ command: "post.sh" }] }],
            UserBash: [{ command: "bash-guard.sh" }],
        };
        const result = mergeHooks(a, b);
        expect(result?.PreToolUse).toHaveLength(1);
        expect(result?.PostToolUse).toHaveLength(1);
        expect(result?.Input).toHaveLength(1);
        expect(result?.SessionShutdown).toHaveLength(1);
        expect(result?.UserBash).toHaveLength(1);
    });

    test("skips empty arrays in result", () => {
        const a: HooksConfig = { Input: [] };
        const b: HooksConfig = { Input: [] };
        const result = mergeHooks(a, b);
        // Empty arrays should not be included
        expect(result).toBeUndefined();
    });
});

// ---------------------------------------------------------------------------
// Integration: Input hook scripts
// ---------------------------------------------------------------------------

describe("event hook integration — Input", () => {
    test("Input hook can rewrite text", async () => {
        const hooks: HookEntry[] = [
            // Read the input text and rewrite npm → bun
            { command: `bash -c 'INPUT=$(cat | jq -r ".text"); echo "{\\\"text\\\": \\\"$(echo $INPUT | sed s/npm/bun/g)\\\"}"'` },
        ];
        const payload = JSON.stringify({ event: "Input", text: "npm install express", source: "interactive" });
        const result = await runEventHooks(hooks, payload, process.cwd(), "Input");
        expect(result.blocked).toBe(false);
        expect(result.outputs).toHaveLength(1);
        expect(result.outputs[0].text).toBe("bun install express");
    });

    test("Input hook can block with exit 2", async () => {
        const hooks: HookEntry[] = [
            { command: 'echo "Policy violation: forbidden input" >&2; exit 2' },
        ];
        const payload = JSON.stringify({ event: "Input", text: "do something bad", source: "interactive" });
        const result = await runEventHooks(hooks, payload, process.cwd(), "Input");
        expect(result.blocked).toBe(true);
        expect(result.reason).toContain("Policy violation");
    });

    test("Input hook can mark as handled", async () => {
        const hooks: HookEntry[] = [
            { command: 'echo \'{"action":"handled"}\'' },
        ];
        const result = await runEventHooks(hooks, "{}", process.cwd(), "Input");
        expect(result.blocked).toBe(false);
        expect(result.outputs[0].action).toBe("handled");
    });
});

// ---------------------------------------------------------------------------
// Integration: UserBash hook scripts
// ---------------------------------------------------------------------------

describe("event hook integration — UserBash", () => {
    test("UserBash hook can read command from payload", async () => {
        const hooks: HookEntry[] = [
            // Check if command contains "rm -rf" and block
            { command: `bash -c 'CMD=$(cat | jq -r ".command"); if echo "$CMD" | grep -q "rm -rf"; then echo "Dangerous!" >&2; exit 2; fi'` },
        ];
        const payload = JSON.stringify({
            event: "UserBash",
            command: "rm -rf /",
            exclude_from_context: false,
            cwd: "/tmp",
            tool_input: { command: "rm -rf /" },
        });
        const result = await runEventHooks(hooks, payload, process.cwd(), "UserBash");
        expect(result.blocked).toBe(true);
        expect(result.reason).toContain("Dangerous");
    });

    test("UserBash hook allows safe commands", async () => {
        const hooks: HookEntry[] = [
            { command: `bash -c 'CMD=$(cat | jq -r ".command"); if echo "$CMD" | grep -q "rm -rf"; then echo "Dangerous!" >&2; exit 2; fi'` },
        ];
        const payload = JSON.stringify({
            event: "UserBash",
            command: "ls -la",
            exclude_from_context: false,
            cwd: "/tmp",
        });
        const result = await runEventHooks(hooks, payload, process.cwd(), "UserBash");
        expect(result.blocked).toBe(false);
    });

    test("UserBash hook receives tool_input for PreToolUse script compat", async () => {
        const hooks: HookEntry[] = [
            // Use tool_input.command (same key as PreToolUse:Bash hooks)
            { command: `bash -c 'cat | jq -r ".tool_input.command"'` },
        ];
        const payload = JSON.stringify({
            event: "UserBash",
            command: "echo hello",
            tool_input: { command: "echo hello" },
        });
        const result = await runEventHooks(hooks, payload, process.cwd(), "UserBash");
        expect(result.blocked).toBe(false);
    });
});

// ---------------------------------------------------------------------------
// Integration: SessionBeforeSwitch / SessionBeforeFork
// ---------------------------------------------------------------------------

describe("event hook integration — SessionBeforeSwitch", () => {
    test("can block a session switch", async () => {
        const hooks: HookEntry[] = [
            { command: 'echo "Uncommitted changes — commit first" >&2; exit 2' },
        ];
        const payload = JSON.stringify({
            event: "SessionBeforeSwitch",
            reason: "resume",
            target_session_file: "/path/to/session.json",
        });
        const result = await runEventHooks(hooks, payload, process.cwd(), "SessionBeforeSwitch");
        expect(result.blocked).toBe(true);
        expect(result.reason).toContain("Uncommitted changes");
    });

    test("allows session switch when hook exits 0", async () => {
        const hooks: HookEntry[] = [{ command: "true" }];
        const payload = JSON.stringify({
            event: "SessionBeforeSwitch",
            reason: "new",
        });
        const result = await runEventHooks(hooks, payload, process.cwd(), "SessionBeforeSwitch");
        expect(result.blocked).toBe(false);
    });
});

describe("event hook integration — SessionBeforeFork", () => {
    test("can block a session fork", async () => {
        const hooks: HookEntry[] = [
            { command: 'echo "Dirty working tree" >&2; exit 2' },
        ];
        const payload = JSON.stringify({
            event: "SessionBeforeFork",
            entry_id: "abc-123",
        });
        const result = await runEventHooks(hooks, payload, process.cwd(), "SessionBeforeFork");
        expect(result.blocked).toBe(true);
        expect(result.reason).toContain("Dirty working tree");
    });

    test("allows fork when hook exits 0", async () => {
        const hooks: HookEntry[] = [{ command: "true" }];
        const result = await runEventHooks(hooks, "{}", process.cwd(), "SessionBeforeFork");
        expect(result.blocked).toBe(false);
    });
});

// ---------------------------------------------------------------------------
// Integration: SessionShutdown
// ---------------------------------------------------------------------------

describe("event hook integration — SessionShutdown", () => {
    test("runs shutdown hooks without throwing", async () => {
        const hooks: HookEntry[] = [
            { command: "echo cleanup" },
            { command: "exit 1" }, // errors are swallowed
        ];
        const payload = JSON.stringify({ event: "SessionShutdown" });
        // Should not throw
        await runFireAndForgetHooks(hooks, payload, process.cwd(), "SessionShutdown");
    });
});

// ---------------------------------------------------------------------------
// Integration: BeforeAgentStart
// ---------------------------------------------------------------------------

describe("event hook integration — BeforeAgentStart", () => {
    test("can inject additionalContext", async () => {
        const hooks: HookEntry[] = [
            { command: 'echo \'{"additionalContext":"Remember: always use bun, never npm"}\'' },
        ];
        const payload = JSON.stringify({
            event: "BeforeAgentStart",
            prompt: "install express",
            system_prompt: "You are a helpful assistant.",
        });
        const result = await runEventHooks(hooks, payload, process.cwd(), "BeforeAgentStart");
        expect(result.blocked).toBe(false);
        expect(result.outputs[0].additionalContext).toBe("Remember: always use bun, never npm");
    });

    test("can override systemPrompt", async () => {
        const hooks: HookEntry[] = [
            { command: 'echo \'{"systemPrompt":"You are a strict code reviewer."}\'' },
        ];
        const payload = JSON.stringify({
            event: "BeforeAgentStart",
            prompt: "review my code",
            system_prompt: "You are a helpful assistant.",
        });
        const result = await runEventHooks(hooks, payload, process.cwd(), "BeforeAgentStart");
        expect(result.blocked).toBe(false);
        expect(result.outputs[0].systemPrompt).toBe("You are a strict code reviewer.");
    });
});

// ---------------------------------------------------------------------------
// Integration: SessionBeforeCompact / SessionBeforeTree / ModelSelect
// ---------------------------------------------------------------------------

describe("event hook integration — second wave", () => {
    test("SessionBeforeCompact can cancel compaction", async () => {
        const hooks: HookEntry[] = [
            { command: 'echo "Important context — do not compact" >&2; exit 2' },
        ];
        const payload = JSON.stringify({
            event: "SessionBeforeCompact",
            custom_instructions: "summarize",
        });
        const result = await runEventHooks(hooks, payload, process.cwd(), "SessionBeforeCompact");
        expect(result.blocked).toBe(true);
        expect(result.reason).toContain("Important context");
    });

    test("SessionBeforeCompact allows when hook exits 0", async () => {
        const hooks: HookEntry[] = [{ command: "true" }];
        const result = await runEventHooks(hooks, "{}", process.cwd(), "SessionBeforeCompact");
        expect(result.blocked).toBe(false);
    });

    test("SessionBeforeTree can cancel navigation", async () => {
        const hooks: HookEntry[] = [
            { command: 'echo "Unsaved work on current branch" >&2; exit 2' },
        ];
        const payload = JSON.stringify({
            event: "SessionBeforeTree",
            target_id: "node-123",
            old_leaf_id: "node-456",
        });
        const result = await runEventHooks(hooks, payload, process.cwd(), "SessionBeforeTree");
        expect(result.blocked).toBe(true);
        expect(result.reason).toContain("Unsaved work");
    });

    test("SessionBeforeTree allows when hook exits 0", async () => {
        const hooks: HookEntry[] = [{ command: "true" }];
        const result = await runEventHooks(hooks, "{}", process.cwd(), "SessionBeforeTree");
        expect(result.blocked).toBe(false);
    });

    test("ModelSelect runs as fire-and-forget", async () => {
        const hooks: HookEntry[] = [
            // Even with exit 1, should not throw
            { command: "exit 1" },
        ];
        const payload = JSON.stringify({
            event: "ModelSelect",
            model: { provider: "anthropic", id: "claude-sonnet-4-20250514", name: "Claude 4 Sonnet" },
            previous_model: null,
            source: "set",
        });
        await runFireAndForgetHooks(hooks, payload, process.cwd(), "ModelSelect");
    });
});
