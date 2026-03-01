import { spawn } from "child_process";
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

/** Check if a tool name matches a hook matcher pattern (supports `|` alternation). */
export function matchesTool(matcher: string, toolName: string): boolean {
    const displayName = toolDisplayName(toolName);
    // Support | alternation: "Edit|Write" matches either
    const patterns = matcher.split("|").map((p) => p.trim());
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

/** Run a single hook script, piping JSON payload on stdin. */
export function runHook(entry: HookEntry, payload: string, cwd: string): Promise<HookResult> {
    const timeout = entry.timeout ?? 10_000;
    return new Promise((resolve) => {
        let timedOut = false;
        let settled = false;

        const proc = spawn("bash", ["-c", entry.command], {
            cwd,
            stdio: ["pipe", "pipe", "pipe"],
            env: {
                ...process.env,
                PIZZAPI_PROJECT_DIR: cwd,
            },
        });

        let stdout = "";
        let stderr = "";

        proc.stdout.on("data", (chunk: Buffer) => {
            stdout += chunk.toString();
        });
        proc.stderr.on("data", (chunk: Buffer) => {
            stderr += chunk.toString();
        });

        // Manual timeout with SIGKILL — can't be trapped by the child.
        const timer = setTimeout(() => {
            timedOut = true;
            proc.kill("SIGKILL");
        }, timeout);

        // Send the JSON payload on stdin
        proc.stdin.write(payload);
        proc.stdin.end();

        const finish = (code: number | null, signal: string | null) => {
            if (settled) return;
            settled = true;
            clearTimeout(timer);
            const killed = timedOut || !!signal || proc.killed;
            const exitCode = killed ? (code ?? 124) : (code ?? 0);
            resolve({ exitCode, stdout: stdout.trim(), stderr: stderr.trim(), killed });
        };

        // Listen to both `exit` and `close` — in Bun, `close` may not fire
        // after SIGKILL, but `exit` does. First one wins via `settled` guard.
        proc.on("exit", (code, signal) => finish(code, signal));
        proc.on("close", (code, signal) => finish(code, signal));

        proc.on("error", (err) => {
            if (settled) return;
            settled = true;
            clearTimeout(timer);
            resolve({ exitCode: 1, stdout: "", stderr: err.message, killed: false });
        });
    });
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
// Extension factory
// ---------------------------------------------------------------------------

/**
 * Hooks extension — runs shell scripts at tool lifecycle points.
 *
 * Scripts receive JSON on stdin with tool_input (and tool_response for PostToolUse).
 * Protocol:
 *   - Exit 0 + JSON { additionalContext: "..." } → injects context into agent
 *   - Exit 2 + stderr message → hard-blocks the tool call (PreToolUse only)
 *   - Exit 0 with no output → allows silently
 *   - Signal kill (timeout) → treated as non-zero exit (fail-closed for safety)
 *
 * Security: Project-local hooks (from .pizzapi/config.json) require
 * `allowProjectHooks: true` in the global ~/.pizzapi/config.json or the
 * PIZZAPI_ALLOW_PROJECT_HOOKS=1 env var. Global hooks always run.
 */
export function createHooksExtension(hooksConfig: HooksConfig | undefined, cwd: string): ExtensionFactory | null {
    if (!hooksConfig) return null;
    const hasPreHooks = (hooksConfig.PreToolUse?.length ?? 0) > 0;
    const hasPostHooks = (hooksConfig.PostToolUse?.length ?? 0) > 0;
    if (!hasPreHooks && !hasPostHooks) return null;

    // Advisory context from PreToolUse hooks is stashed here per tool-call-id
    // and injected into the tool_result so the agent sees it in the same turn
    // without blocking the tool from executing.
    const preToolContext = new Map<string, string[]>();

    const factory: ExtensionFactory = (pi) => {
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
        {
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
    };

    return factory;
}
