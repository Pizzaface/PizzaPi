import { spawn } from "child_process";
import type { ExtensionFactory } from "@mariozechner/pi-coding-agent";
import type { HooksConfig, HookMatcher, HookEntry } from "../config.js";

/**
 * Result of running a hook script. Mirrors the Claude Code hook JSON protocol:
 * - Exit 0 + JSON with additionalContext → inject context (soft nudge)
 * - Exit 2 + stderr → hard-block the tool call
 * - Exit 0 with no output → allow silently
 */
interface HookResult {
    exitCode: number;
    stdout: string;
    stderr: string;
}

/** Parsed output from a hook that returned JSON on stdout. */
interface HookOutput {
    /** Text to inject into the agent's context window. */
    additionalContext?: string;
    /** For PreToolUse: "allow" | "deny" | "ask". Default: "allow". */
    permissionDecision?: "allow" | "deny" | "ask";
    /** For PostToolUse: "block" to signal a problem. */
    decision?: "block";
}

/** Map tool names from pi to hook-friendly names. */
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

/** Run a single hook script, piping JSON payload on stdin. */
export function runHook(entry: HookEntry, payload: string, cwd: string): Promise<HookResult> {
    const timeout = entry.timeout ?? 10_000;
    return new Promise((resolve) => {
        const proc = spawn("bash", ["-c", entry.command], {
            cwd,
            stdio: ["pipe", "pipe", "pipe"],
            env: {
                ...process.env,
                PIZZAPI_PROJECT_DIR: cwd,
            },
            timeout,
        });

        let stdout = "";
        let stderr = "";

        proc.stdout.on("data", (chunk: Buffer) => {
            stdout += chunk.toString();
        });
        proc.stderr.on("data", (chunk: Buffer) => {
            stderr += chunk.toString();
        });

        // Send the JSON payload on stdin
        proc.stdin.write(payload);
        proc.stdin.end();

        proc.on("close", (code) => {
            resolve({ exitCode: code ?? 0, stdout: stdout.trim(), stderr: stderr.trim() });
        });

        proc.on("error", (err) => {
            resolve({ exitCode: 1, stdout: "", stderr: err.message });
        });
    });
}

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

/**
 * Hooks extension — runs shell scripts at tool lifecycle points.
 *
 * Scripts receive JSON on stdin with tool_input (and tool_response for PostToolUse).
 * Protocol:
 *   - Exit 0 + JSON { additionalContext: "..." } → injects context into agent
 *   - Exit 2 + stderr message → hard-blocks the tool call (PreToolUse only)
 *   - Exit 0 with no output → allows silently
 */
export function createHooksExtension(hooksConfig: HooksConfig | undefined, cwd: string): ExtensionFactory | null {
    if (!hooksConfig) return null;
    const hasPreHooks = (hooksConfig.PreToolUse?.length ?? 0) > 0;
    const hasPostHooks = (hooksConfig.PostToolUse?.length ?? 0) > 0;
    if (!hasPreHooks && !hasPostHooks) return null;

    // Store context messages to inject on the next before_agent_start
    const pendingContext: string[] = [];

    const factory: ExtensionFactory = (pi) => {
        // Inject accumulated hook context before each agent turn
        pi.on("before_agent_start", (event) => {
            if (pendingContext.length === 0) return;
            const combined = pendingContext.splice(0).join("\n\n");
            return {
                message: {
                    customType: "hook-context",
                    content: combined,
                    display: false,
                },
            };
        });

        // PreToolUse: fire before tool executes, can block
        if (hasPreHooks) {
            pi.on("tool_call", async (event) => {
                const hooks = getMatchingHooks(hooksConfig.PreToolUse, event.toolName);
                if (hooks.length === 0) return;

                const payload = JSON.stringify({
                    tool_name: event.toolName,
                    tool_input: event.input,
                });

                for (const hook of hooks) {
                    const result = await runHook(hook, payload, cwd);

                    // Exit 2 = hard block
                    if (result.exitCode === 2) {
                        const reason = result.stderr || "Blocked by hook";
                        return { block: true, reason };
                    }

                    // Exit 0 with JSON output = inject context
                    if (result.exitCode === 0 && result.stdout) {
                        const output = parseHookOutput(result.stdout);
                        if (output?.permissionDecision === "deny") {
                            return { block: true, reason: output.additionalContext || "Denied by hook" };
                        }
                        if (output?.additionalContext) {
                            pendingContext.push(output.additionalContext);
                        }
                    }
                }
            });
        }

        // PostToolUse: fire after tool executes, can inject context
        if (hasPostHooks) {
            pi.on("tool_result", async (event) => {
                const hooks = getMatchingHooks(hooksConfig.PostToolUse, event.toolName);
                if (hooks.length === 0) return;

                // Build the tool response text from content array
                const responseText = event.content
                    ?.map((c: any) => (c.type === "text" ? c.text : ""))
                    .filter(Boolean)
                    .join("\n");

                const payload = JSON.stringify({
                    tool_name: event.toolName,
                    tool_input: event.input,
                    tool_response: responseText ?? "",
                });

                const contextParts: string[] = [];

                for (const hook of hooks) {
                    const result = await runHook(hook, payload, cwd);

                    if (result.exitCode === 0 && result.stdout) {
                        const output = parseHookOutput(result.stdout);
                        if (output?.additionalContext) {
                            contextParts.push(output.additionalContext);
                        }
                    }
                    // PostToolUse hooks can't block (tool already ran), but we
                    // could append error info from stderr if needed.
                }

                // Append all hook context to the tool result so the agent sees it
                // immediately, not on the next turn.
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
            });
        }
    };

    return factory;
}
