import { execSync } from "child_process";
import { existsSync } from "fs";
import { join } from "path";
import type { ExtensionFactory } from "@mariozechner/pi-coding-agent";
import type { HooksConfig, HookMatcher, HookEntry } from "../config.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/**
 * Result of running a hook script. Mirrors the Claude Code hook JSON protocol:
 * - Exit 0 + JSON with additionalContext → inject context (soft nudge)
 * - Exit 2 + stderr → hard-block the tool call
 * - Exit 0 with no output → allow silently
 */
export interface HookResult {
    exitCode: number;
    stdout: string;
    stderr: string;
    /** True when the process was killed by a signal (e.g. timeout). */
    killed: boolean;
}

/** Parsed output from a hook that returned JSON on stdout. */
export interface HookOutput {
    /** Text to inject into the agent's context window. */
    additionalContext?: string;
    /** For PreToolUse: "allow" | "deny" | "ask". Default: "allow". */
    permissionDecision?: "allow" | "deny" | "ask";
    /** For PostToolUse: "block" to signal a problem. */
    decision?: "block";

    // -- Input hook fields --

    /** For Input hooks: transformed text to replace the original input. */
    text?: string;
    /** For Input hooks: "continue" | "transform" | "handled". */
    action?: "continue" | "transform" | "handled";

    // -- BeforeAgentStart hook fields --

    /** For BeforeAgentStart hooks: override the system prompt for this turn. */
    systemPrompt?: string;
}

// ---------------------------------------------------------------------------
// Tool name helpers
// ---------------------------------------------------------------------------

/** Map tool names from pi to hook-friendly display names. */
function toolDisplayName(toolName: string): string {
    switch (toolName) {
        case "bash":
            return "Bash";
        case "read":
            return "Read";
        case "write":
            return "Write";
        case "edit":
            return "Edit";
        case "grep":
            return "Grep";
        case "find":
            return "Find";
        case "ls":
            return "Ls";
        default:
            return toolName;
    }
}

/**
 * Split a matcher string on top-level `|` only — `|` inside parentheses is
 * left intact so regex groups like `mcp__(github|filesystem)__.*` survive.
 */
function splitTopLevelAlternation(matcher: string): string[] {
    const parts: string[] = [];
    let depth = 0;
    let current = "";
    for (const ch of matcher) {
        if (ch === "(") {
            depth++;
            current += ch;
        } else if (ch === ")") {
            depth = Math.max(0, depth - 1);
            current += ch;
        } else if (ch === "|" && depth === 0) {
            parts.push(current);
            current = "";
        } else {
            current += ch;
        }
    }
    parts.push(current);
    return parts.map((p) => p.trim());
}

/** Check if a tool name matches a hook matcher pattern (supports `|` alternation). */
export function matchesTool(matcher: string, toolName: string): boolean {
    const displayName = toolDisplayName(toolName);
    // Support | alternation: "Edit|Write" matches either.
    // Uses paren-aware splitting so grouped alternation like
    // `mcp__(github|filesystem)__.*` is preserved as a single regex.
    const patterns = splitTopLevelAlternation(matcher);
    for (const pattern of patterns) {
        if (pattern === ".*") return true;
        // Case-insensitive match against both raw name and display name
        if (pattern.toLowerCase() === toolName.toLowerCase()) return true;
        if (pattern.toLowerCase() === displayName.toLowerCase()) return true;
        // Regex match for complex patterns (e.g., mcp__.*)
        try {
            const re = new RegExp(`^${pattern}$`, "i");
            if (re.test(toolName) || re.test(displayName)) return true;
        } catch {
            // Invalid regex — fall through to literal comparison only
        }
    }
    return false;
}

// ---------------------------------------------------------------------------
// Payload normalization — bridge pi tool input → hook script expectations
// ---------------------------------------------------------------------------

/**
 * Normalize tool input for hook scripts. Pi tools use `path` for file paths,
 * but the hook protocol (matching Claude Code) expects `file_path`. We include
 * both so scripts work regardless of which key they check.
 */
export function normalizeToolInput(toolName: string, input: Record<string, unknown>): Record<string, unknown> {
    const normalized = { ...input };
    // If the tool has `path` but not `file_path`, add the alias
    if ("path" in normalized && !("file_path" in normalized)) {
        normalized.file_path = normalized.path;
    }
    // Reverse alias too: if script sends file_path, also set path
    if ("file_path" in normalized && !("path" in normalized)) {
        normalized.path = normalized.file_path;
    }
    return normalized;
}

// ---------------------------------------------------------------------------
// Hook runner
// ---------------------------------------------------------------------------

/**
 * Find Git for Windows' bundled bash.exe by checking well-known install
 * paths and falling back to `git --exec-path` to derive the Git root.
 * Returns the absolute path to bash.exe, or null if not found.
 */
function findGitBashOnWindows(): string | null {
    const programFiles = process.env.ProgramFiles || "C:\\Program Files";
    const programFilesX86 = process.env["ProgramFiles(x86)"] || "C:\\Program Files (x86)";
    const localAppData = process.env.LOCALAPPDATA || "";

    const candidates = [
        join(programFiles, "Git", "bin", "bash.exe"),
        join(programFilesX86, "Git", "bin", "bash.exe"),
        ...(localAppData ? [join(localAppData, "Programs", "Git", "bin", "bash.exe")] : []),
    ];

    for (const candidate of candidates) {
        if (existsSync(candidate)) return candidate;
    }

    // Try to derive from `git --exec-path` (e.g. C:\Program Files\Git\mingw64\libexec\git-core)
    try {
        const execPath = execSync("git --exec-path", {
            encoding: "utf-8",
            stdio: ["ignore", "pipe", "ignore"],
        }).trim();
        // Walk up to the Git root: <root>/mingw64/libexec/git-core → <root>
        const gitRoot = join(execPath, "..", "..", "..");
        const bashFromGit = join(gitRoot, "bin", "bash.exe");
        if (existsSync(bashFromGit)) return bashFromGit;
    } catch {
        // git not in PATH or other error — fall through
    }

    return null;
}

/** Cached result so we only probe the filesystem once per process. */
let _cachedShell: { shell: string; flag: string } | undefined;

/**
 * Resolve the platform shell and flag for running hook commands.
 *
 * - **Unix / macOS**: `/bin/sh -c` (POSIX-guaranteed to exist). Hook
 *   scripts that need bash features should have a `#!/bin/bash` shebang
 *   or be invoked explicitly via `bash my-script.sh` in the command string.
 * - **Windows**: Git for Windows' bundled `bash.exe` (searched at common
 *   install locations, then derived from `git --exec-path`). Falls back to
 *   bare `bash` in PATH so the error message is clear ("bash not found")
 *   rather than an opaque cmd.exe syntax failure.
 *
 * The result is cached for the lifetime of the process.
 */
export function resolveShell(): { shell: string; flag: string } {
    if (_cachedShell) return _cachedShell;

    if (process.platform !== "win32") {
        _cachedShell = { shell: "/bin/sh", flag: "-c" };
        return _cachedShell;
    }

    // Windows: prefer Git for Windows bash, fall back to bare `bash`
    const gitBash = findGitBashOnWindows();
    _cachedShell = { shell: gitBash ?? "bash", flag: "-c" };
    return _cachedShell;
}

/**
 * Reset the cached shell — only needed for testing.
 * @internal
 */
export function _resetShellCache(): void {
    _cachedShell = undefined;
}

/** Run a single hook script, piping JSON payload on stdin. */
export async function runHook(entry: HookEntry, payload: string, cwd: string): Promise<HookResult> {
    const hookTimeout = entry.timeout ?? 10_000;

    const { shell, flag } = resolveShell();

    let timedOut = false;
    let timer: ReturnType<typeof setTimeout> | undefined;

    try {
        const proc = Bun.spawn([shell, flag, entry.command], {
            cwd,
            stdin: "pipe",
            stdout: "pipe",
            stderr: "pipe",
            env: { ...process.env, PIZZAPI_PROJECT_DIR: cwd },
        });

        // Write the JSON payload on stdin
        proc.stdin.write(payload);
        proc.stdin.end();

        // Race the process exit against a timeout
        const exitCode = await Promise.race([
            proc.exited,
            new Promise<never>((_, reject) => {
                timer = setTimeout(() => {
                    timedOut = true;
                    proc.kill(9); // SIGKILL
                    reject(new Error("__hook_timeout__"));
                }, hookTimeout);
            }),
        ]);

        // Process exited normally — cancel the timeout
        clearTimeout(timer);

        const [stdout, stderr] = await Promise.all([
            new Response(proc.stdout).text(),
            new Response(proc.stderr).text(),
        ]);

        const killed = timedOut || proc.signalCode !== null;
        return {
            exitCode: killed ? (exitCode ?? 124) : (exitCode ?? 0),
            stdout: stdout.trim(),
            stderr: stderr.trim(),
            killed,
        };
    } catch (err) {
        clearTimeout(timer);
        if (err instanceof Error && err.message === "__hook_timeout__") {
            return { exitCode: 124, stdout: "", stderr: "", killed: true };
        }
        return {
            exitCode: 1,
            stdout: "",
            stderr: err instanceof Error ? err.message : String(err),
            killed: false,
        };
    }
}

// ---------------------------------------------------------------------------
// Output parsing
// ---------------------------------------------------------------------------

/** Parse the JSON output from a hook script, extracting additionalContext etc. */
export function parseHookOutput(stdout: string): HookOutput | null {
    if (!stdout) return null;
    try {
        const parsed = JSON.parse(stdout);
        // Support nested hookSpecificOutput (Claude Code format) or flat format
        const specific = parsed.hookSpecificOutput ?? parsed;
        return {
            additionalContext: specific.additionalContext,
            permissionDecision: specific.permissionDecision,
            decision: specific.decision ?? parsed.decision,
            // Input hook fields
            text: specific.text,
            action: specific.action,
            // BeforeAgentStart hook fields
            systemPrompt: specific.systemPrompt,
        };
    } catch {
        return null;
    }
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/** Collect all matching hook entries for a given event type and tool name. */
function getMatchingHooks(matchers: HookMatcher[] | undefined, toolName: string): HookEntry[] {
    if (!matchers) return [];
    const entries: HookEntry[] = [];
    for (const m of matchers) {
        if (matchesTool(m.matcher, toolName)) {
            entries.push(...m.hooks);
        }
    }
    return entries;
}

// ---------------------------------------------------------------------------
// Shared helpers for event hooks
// ---------------------------------------------------------------------------

/**
 * Run all hook entries for an event, returning early on block/kill.
 * Used by cancelable events (Input, UserBash, SessionBefore*).
 *
 * Returns { blocked, reason, outputs } where outputs contains parsed
 * JSON from successful hooks.
 */
export async function runEventHooks(
    hooks: HookEntry[],
    payload: string,
    cwd: string,
    eventName: string,
): Promise<{ blocked: boolean; reason?: string; outputs: HookOutput[] }> {
    const outputs: HookOutput[] = [];
    for (const hook of hooks) {
        const result = await runHook(hook, payload, cwd);

        // Killed (timeout / signal) → fail-closed for safety
        if (result.killed) {
            return {
                blocked: true,
                reason: `${eventName} hook timed out — blocking for safety.`,
                outputs,
            };
        }

        // Exit 2 = hard block / cancel
        if (result.exitCode === 2) {
            return {
                blocked: true,
                reason: result.stderr || `Blocked by ${eventName} hook`,
                outputs,
            };
        }

        // Exit 0 with JSON output
        if (result.exitCode === 0 && result.stdout) {
            const output = parseHookOutput(result.stdout);
            if (output) outputs.push(output);
        }

        // Non-zero exit (other than 2) → fail-closed
        if (result.exitCode !== 0) {
            return {
                blocked: true,
                reason: result.stderr || `${eventName} hook exited with code ${result.exitCode}`,
                outputs,
            };
        }
    }
    return { blocked: false, outputs };
}

/**
 * Run all hook entries for a fire-and-forget event (SessionShutdown, ModelSelect).
 * Errors are logged but never block anything.
 */
export async function runFireAndForgetHooks(
    hooks: HookEntry[],
    payload: string,
    cwd: string,
    eventName: string,
): Promise<void> {
    for (const hook of hooks) {
        try {
            await runHook(hook, payload, cwd);
        } catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            console.error(`[hooks] ${eventName} handler error: ${msg}`);
        }
    }
}

// ---------------------------------------------------------------------------
// Extension factory
// ---------------------------------------------------------------------------

/** Check if a HooksConfig has any configured hooks at all. */
function hasAnyHooks(config: HooksConfig): boolean {
    return Object.values(config).some((v) => Array.isArray(v) && v.length > 0);
}

/**
 * Hooks extension — runs shell scripts at agent lifecycle points.
 *
 * **Tool hooks** (PreToolUse / PostToolUse):
 *   Scripts receive JSON on stdin with tool_input (and tool_response for PostToolUse).
 *   - Exit 0 + JSON { additionalContext: "..." } → injects context into agent
 *   - Exit 2 + stderr message → hard-blocks the tool call (PreToolUse only)
 *   - Exit 0 with no output → allows silently
 *   - Signal kill (timeout) → treated as non-zero exit (fail-closed for safety)
 *
 * **Event hooks** (Input, BeforeAgentStart, UserBash, Session*, ModelSelect):
 *   Scripts receive JSON on stdin with event-specific fields.
 *   - Exit 0 → allow / no-op
 *   - Exit 2 → cancel / block (for cancelable events)
 *   - JSON output can carry additionalContext, text transforms, systemPrompt overrides
 *
 * Security: Project-local hooks (from .pizzapi/config.json) require
 * `allowProjectHooks: true` in the global ~/.pizzapi/config.json or the
 * PIZZAPI_ALLOW_PROJECT_HOOKS=1 env var. Global hooks always run.
 */
export function createHooksExtension(hooksConfig: HooksConfig | undefined, cwd: string): ExtensionFactory | null {
    if (!hooksConfig || !hasAnyHooks(hooksConfig)) return null;

    const hasPreHooks = (hooksConfig.PreToolUse?.length ?? 0) > 0;
    const hasPostHooks = (hooksConfig.PostToolUse?.length ?? 0) > 0;
    const hasInputHooks = (hooksConfig.Input?.length ?? 0) > 0;
    const hasBeforeAgentStartHooks = (hooksConfig.BeforeAgentStart?.length ?? 0) > 0;
    const hasUserBashHooks = (hooksConfig.UserBash?.length ?? 0) > 0;
    const hasSessionBeforeSwitchHooks = (hooksConfig.SessionBeforeSwitch?.length ?? 0) > 0;
    const hasSessionBeforeForkHooks = (hooksConfig.SessionBeforeFork?.length ?? 0) > 0;
    const hasSessionShutdownHooks = (hooksConfig.SessionShutdown?.length ?? 0) > 0;
    const hasSessionBeforeCompactHooks = (hooksConfig.SessionBeforeCompact?.length ?? 0) > 0;
    const hasSessionBeforeTreeHooks = (hooksConfig.SessionBeforeTree?.length ?? 0) > 0;
    const hasModelSelectHooks = (hooksConfig.ModelSelect?.length ?? 0) > 0;

    // Advisory context from PreToolUse hooks is stashed here per tool-call-id
    // and injected into the tool_result so the agent sees it in the same turn
    // without blocking the tool from executing.
    const preToolContext = new Map<string, string[]>();

    const factory: ExtensionFactory = (pi) => {
        // ---------------------------------------------------------------
        // Tool lifecycle hooks
        // ---------------------------------------------------------------

        // PreToolUse: fire before tool executes, can block or inject context
        if (hasPreHooks) {
            pi.on("tool_call", async (event) => {
                try {
                    const hooks = getMatchingHooks(hooksConfig.PreToolUse, event.toolName);
                    if (hooks.length === 0) return;

                    const normalizedInput = normalizeToolInput(event.toolName, event.input as Record<string, unknown>);
                    const payload = JSON.stringify({
                        tool_name: event.toolName,
                        tool_input: normalizedInput,
                    });

                    const advisoryParts: string[] = [];

                    for (const hook of hooks) {
                        const result = await runHook(hook, payload, cwd);

                        // Killed (timeout / signal) → fail-closed for safety
                        if (result.killed) {
                            return { block: true, reason: "Hook timed out — blocking for safety. Check .pizzapi/hooks/ configuration." };
                        }

                        // Exit 2 = hard block
                        if (result.exitCode === 2) {
                            const reason = result.stderr || "Blocked by hook";
                            return { block: true, reason };
                        }

                        // Exit 0 with JSON output = inspect for decisions/context
                        if (result.exitCode === 0 && result.stdout) {
                            const output = parseHookOutput(result.stdout);
                            if (output?.permissionDecision === "deny") {
                                return { block: true, reason: output.additionalContext || "Denied by hook" };
                            }
                            if (output?.additionalContext) {
                                advisoryParts.push(output.additionalContext);
                            }
                        }

                        // Non-zero exit (other than 2) → fail-closed
                        if (result.exitCode !== 0) {
                            return { block: true, reason: result.stderr || `Hook exited with code ${result.exitCode}` };
                        }
                    }

                    // Stash advisory context — it will be appended to the
                    // tool_result so the agent sees it in the same turn without
                    // blocking the tool from executing.
                    if (advisoryParts.length > 0) {
                        preToolContext.set(event.toolCallId, advisoryParts);
                    }
                } catch (err) {
                    // Defensive: never let hook errors crash the tool pipeline
                    const msg = err instanceof Error ? err.message : String(err);
                    console.error(`[hooks] PreToolUse handler error: ${msg}`);
                }
            });
        }

        // PostToolUse + PreToolUse advisory: fire after tool executes, inject context.
        // This handler always runs (not gated on hasPostHooks) because it also
        // drains advisory context stashed by PreToolUse hooks.
        if (hasPreHooks || hasPostHooks) {
            pi.on("tool_result", async (event) => {
                try {
                    const contextParts: string[] = [];

                    // Drain any advisory context stashed by PreToolUse hooks
                    const preAdvice = preToolContext.get(event.toolCallId);
                    if (preAdvice) {
                        contextParts.push(...preAdvice);
                        preToolContext.delete(event.toolCallId);
                    }

                    // Run PostToolUse hooks
                    const hooks = getMatchingHooks(hooksConfig.PostToolUse, event.toolName);
                    if (hooks.length > 0) {
                        const normalizedInput = normalizeToolInput(event.toolName, event.input as Record<string, unknown>);

                        // Build the tool response text from content array
                        const responseText = event.content
                            ?.map((c: any) => (c.type === "text" ? c.text : ""))
                            .filter(Boolean)
                            .join("\n");

                        const payload = JSON.stringify({
                            tool_name: event.toolName,
                            tool_input: normalizedInput,
                            tool_response: responseText ?? "",
                        });

                        for (const hook of hooks) {
                            const result = await runHook(hook, payload, cwd);

                            // Only process successful hooks — killed/errored PostToolUse
                            // hooks are silently ignored (tool already ran, can't undo)
                            if (result.exitCode === 0 && result.stdout) {
                                const output = parseHookOutput(result.stdout);
                                if (output?.additionalContext) {
                                    contextParts.push(output.additionalContext);
                                }
                            }
                        }
                    }

                    // Append all hook context (PreToolUse advisory + PostToolUse)
                    // to the tool result so the agent sees it in the same turn.
                    if (contextParts.length > 0) {
                        const hookNotice = contextParts.join("\n\n");
                        const existingContent = event.content ?? [];
                        return {
                            content: [
                                ...existingContent,
                                { type: "text" as const, text: `\n\n[Hook] ${hookNotice}` },
                            ],
                        };
                    }
                } catch (err) {
                    // Defensive: never let hook errors crash the tool pipeline
                    const msg = err instanceof Error ? err.message : String(err);
                    console.error(`[hooks] PostToolUse handler error: ${msg}`);
                }
            });
        }

        // ---------------------------------------------------------------
        // Input hook — catches raw user text before skill/template expansion
        // ---------------------------------------------------------------

        if (hasInputHooks) {
            pi.on("input", async (event) => {
                try {
                    const payload = JSON.stringify({
                        event: "Input",
                        text: event.text,
                        source: event.source,
                    });

                    const { blocked, reason, outputs } = await runEventHooks(
                        hooksConfig.Input!,
                        payload,
                        cwd,
                        "Input",
                    );

                    // Block → mark as handled so the agent doesn't see it
                    if (blocked) {
                        console.error(`[hooks] Input blocked: ${reason}`);
                        return { action: "handled" as const };
                    }

                    // Check if any hook wants to transform the input or mark handled
                    for (const output of outputs) {
                        if (output.action === "handled") {
                            return { action: "handled" as const };
                        }
                        if (output.text !== undefined) {
                            return { action: "transform" as const, text: output.text };
                        }
                        if (output.action === "transform" && output.text !== undefined) {
                            return { action: "transform" as const, text: output.text };
                        }
                    }

                    return { action: "continue" as const };
                } catch (err) {
                    const msg = err instanceof Error ? err.message : String(err);
                    console.error(`[hooks] Input handler error: ${msg}`);
                    return { action: "continue" as const };
                }
            });
        }

        // ---------------------------------------------------------------
        // BeforeAgentStart hook — inject context or tweak system prompt
        // ---------------------------------------------------------------

        if (hasBeforeAgentStartHooks) {
            pi.on("before_agent_start", async (event) => {
                try {
                    const payload = JSON.stringify({
                        event: "BeforeAgentStart",
                        prompt: event.prompt,
                        system_prompt: event.systemPrompt,
                    });

                    const { blocked, outputs } = await runEventHooks(
                        hooksConfig.BeforeAgentStart!,
                        payload,
                        cwd,
                        "BeforeAgentStart",
                    );

                    // BeforeAgentStart doesn't support blocking — just log
                    if (blocked) {
                        console.error("[hooks] BeforeAgentStart hook failed (non-fatal)");
                    }

                    // Collect context and system prompt overrides
                    const contextParts: string[] = [];
                    let systemPrompt: string | undefined;

                    for (const output of outputs) {
                        if (output.additionalContext) {
                            contextParts.push(output.additionalContext);
                        }
                        if (output.systemPrompt) {
                            systemPrompt = output.systemPrompt;
                        }
                    }

                    const result: any = {};

                    if (contextParts.length > 0) {
                        result.message = {
                            customType: "hook_context",
                            content: contextParts.join("\n\n"),
                            display: "collapsed",
                        };
                    }

                    if (systemPrompt) {
                        result.systemPrompt = systemPrompt;
                    }

                    if (Object.keys(result).length > 0) return result;
                } catch (err) {
                    const msg = err instanceof Error ? err.message : String(err);
                    console.error(`[hooks] BeforeAgentStart handler error: ${msg}`);
                }
            });
        }

        // ---------------------------------------------------------------
        // UserBash hook — safety parity with PreToolUse:Bash for ! / !!
        // ---------------------------------------------------------------

        if (hasUserBashHooks) {
            pi.on("user_bash", async (event) => {
                try {
                    const payload = JSON.stringify({
                        event: "UserBash",
                        command: event.command,
                        exclude_from_context: event.excludeFromContext,
                        cwd: event.cwd,
                        // Also include tool_input for compatibility with PreToolUse scripts
                        tool_input: { command: event.command },
                    });

                    const { blocked, reason } = await runEventHooks(
                        hooksConfig.UserBash!,
                        payload,
                        cwd,
                        "UserBash",
                    );

                    if (blocked) {
                        // Return a synthetic BashResult to prevent execution
                        return {
                            result: {
                                output: `[Hook] Blocked: ${reason}`,
                                exitCode: 1,
                                cancelled: false,
                                truncated: false,
                            },
                        };
                    }
                } catch (err) {
                    const msg = err instanceof Error ? err.message : String(err);
                    console.error(`[hooks] UserBash handler error: ${msg}`);
                }
            });
        }

        // ---------------------------------------------------------------
        // Session lifecycle hooks
        // ---------------------------------------------------------------

        if (hasSessionBeforeSwitchHooks) {
            pi.on("session_before_switch", async (event) => {
                try {
                    const payload = JSON.stringify({
                        event: "SessionBeforeSwitch",
                        reason: event.reason,
                        target_session_file: event.targetSessionFile,
                    });

                    const { blocked, reason } = await runEventHooks(
                        hooksConfig.SessionBeforeSwitch!,
                        payload,
                        cwd,
                        "SessionBeforeSwitch",
                    );

                    if (blocked) {
                        console.error(`[hooks] Session switch cancelled: ${reason}`);
                        return { cancel: true };
                    }
                } catch (err) {
                    const msg = err instanceof Error ? err.message : String(err);
                    console.error(`[hooks] SessionBeforeSwitch handler error: ${msg}`);
                }
            });
        }

        if (hasSessionBeforeForkHooks) {
            pi.on("session_before_fork", async (event) => {
                try {
                    const payload = JSON.stringify({
                        event: "SessionBeforeFork",
                        entry_id: event.entryId,
                    });

                    const { blocked, reason } = await runEventHooks(
                        hooksConfig.SessionBeforeFork!,
                        payload,
                        cwd,
                        "SessionBeforeFork",
                    );

                    if (blocked) {
                        console.error(`[hooks] Session fork cancelled: ${reason}`);
                        return { cancel: true };
                    }
                } catch (err) {
                    const msg = err instanceof Error ? err.message : String(err);
                    console.error(`[hooks] SessionBeforeFork handler error: ${msg}`);
                }
            });
        }

        if (hasSessionShutdownHooks) {
            pi.on("session_shutdown", async () => {
                try {
                    const payload = JSON.stringify({ event: "SessionShutdown" });
                    await runFireAndForgetHooks(
                        hooksConfig.SessionShutdown!,
                        payload,
                        cwd,
                        "SessionShutdown",
                    );
                } catch (err) {
                    const msg = err instanceof Error ? err.message : String(err);
                    console.error(`[hooks] SessionShutdown handler error: ${msg}`);
                }
            });
        }

        // ---------------------------------------------------------------
        // Second wave hooks
        // ---------------------------------------------------------------

        if (hasSessionBeforeCompactHooks) {
            pi.on("session_before_compact", async (event) => {
                try {
                    const payload = JSON.stringify({
                        event: "SessionBeforeCompact",
                        custom_instructions: event.customInstructions,
                    });

                    const { blocked, reason } = await runEventHooks(
                        hooksConfig.SessionBeforeCompact!,
                        payload,
                        cwd,
                        "SessionBeforeCompact",
                    );

                    if (blocked) {
                        console.error(`[hooks] Session compaction cancelled: ${reason}`);
                        return { cancel: true };
                    }
                } catch (err) {
                    const msg = err instanceof Error ? err.message : String(err);
                    console.error(`[hooks] SessionBeforeCompact handler error: ${msg}`);
                }
            });
        }

        if (hasSessionBeforeTreeHooks) {
            pi.on("session_before_tree", async (event) => {
                try {
                    const payload = JSON.stringify({
                        event: "SessionBeforeTree",
                        target_id: event.preparation.targetId,
                        old_leaf_id: event.preparation.oldLeafId,
                        user_wants_summary: event.preparation.userWantsSummary,
                    });

                    const { blocked, reason } = await runEventHooks(
                        hooksConfig.SessionBeforeTree!,
                        payload,
                        cwd,
                        "SessionBeforeTree",
                    );

                    if (blocked) {
                        console.error(`[hooks] Session tree navigation cancelled: ${reason}`);
                        return { cancel: true };
                    }
                } catch (err) {
                    const msg = err instanceof Error ? err.message : String(err);
                    console.error(`[hooks] SessionBeforeTree handler error: ${msg}`);
                }
            });
        }

        if (hasModelSelectHooks) {
            pi.on("model_select", async (event) => {
                try {
                    const payload = JSON.stringify({
                        event: "ModelSelect",
                        model: {
                            provider: event.model.provider,
                            id: event.model.id,
                            name: event.model.name,
                        },
                        previous_model: event.previousModel
                            ? {
                                  provider: event.previousModel.provider,
                                  id: event.previousModel.id,
                                  name: event.previousModel.name,
                              }
                            : null,
                        source: event.source,
                    });

                    await runFireAndForgetHooks(
                        hooksConfig.ModelSelect!,
                        payload,
                        cwd,
                        "ModelSelect",
                    );
                } catch (err) {
                    const msg = err instanceof Error ? err.message : String(err);
                    console.error(`[hooks] ModelSelect handler error: ${msg}`);
                }
            });
        }
    };

    return factory;
}
