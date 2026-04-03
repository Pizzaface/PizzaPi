import type { ExtensionFactory } from "@mariozechner/pi-coding-agent";
import type { HooksConfig } from "../../config.js";
import { normalizeToolInput } from "./matcher.js";
import { runHook, parseHookOutput } from "./runner.js";
import { getMatchingHooks, runEventHooks, runFireAndForgetHooks } from "./events.js";
import { createLogger } from "@pizzapi/tools";

const log = createLogger("hooks");

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
                            // Apply updatedInput — mutate event.input in place
                            // so the tool executes with the rewritten arguments
                            // (e.g. RTK command rewrite: ls → rtk ls).
                            if (output?.updatedInput) {
                                const input = event.input as Record<string, unknown>;
                                for (const [key, value] of Object.entries(output.updatedInput)) {
                                    input[key] = value;
                                }
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
                    log.error(`PreToolUse handler error: ${msg}`);
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
                    log.error(`PostToolUse handler error: ${msg}`);
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
                        log.error(`Input blocked: ${reason}`);
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
                    log.error(`Input handler error: ${msg}`);
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
                        log.error("BeforeAgentStart hook failed (non-fatal)");
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
                    log.error(`BeforeAgentStart handler error: ${msg}`);
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
                    log.error(`UserBash handler error: ${msg}`);
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
                        log.error(`Session switch cancelled: ${reason}`);
                        return { cancel: true };
                    }
                } catch (err) {
                    const msg = err instanceof Error ? err.message : String(err);
                    log.error(`SessionBeforeSwitch handler error: ${msg}`);
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
                        log.error(`Session fork cancelled: ${reason}`);
                        return { cancel: true };
                    }
                } catch (err) {
                    const msg = err instanceof Error ? err.message : String(err);
                    log.error(`SessionBeforeFork handler error: ${msg}`);
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
                    log.error(`SessionShutdown handler error: ${msg}`);
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
                        log.error(`Session compaction cancelled: ${reason}`);
                        return { cancel: true };
                    }
                } catch (err) {
                    const msg = err instanceof Error ? err.message : String(err);
                    log.error(`SessionBeforeCompact handler error: ${msg}`);
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
                        log.error(`Session tree navigation cancelled: ${reason}`);
                        return { cancel: true };
                    }
                } catch (err) {
                    const msg = err instanceof Error ? err.message : String(err);
                    log.error(`SessionBeforeTree handler error: ${msg}`);
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
                    log.error(`ModelSelect handler error: ${msg}`);
                }
            });
        }
    };

    return factory;
}
