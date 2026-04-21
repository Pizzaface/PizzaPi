import type { ExtensionFactory } from "@mariozechner/pi-coding-agent";
import { createLogger } from "@pizzapi/tools";
import { waitForRelayRegistration } from "./remote.js";
import { waitForWorkerStartupComplete } from "./worker-startup-gate.js";

const log = createLogger("worker");

/**
 * InitialPrompt extension — handles one-time model selection, initial prompt
 * injection, and agent session setup when a worker is spawned.
 *
 * Environment variables:
 *   PIZZAPI_WORKER_INITIAL_PROMPT           — initial user message to send
 *   PIZZAPI_WORKER_INITIAL_MODEL_PROVIDER   — model provider override
 *   PIZZAPI_WORKER_INITIAL_MODEL_ID         — model ID override
 *   PIZZAPI_WORKER_AGENT_NAME               — agent name (sets session name)
 *   PIZZAPI_WORKER_AGENT_TOOLS              — comma-separated allowlist of tools
 *   PIZZAPI_WORKER_AGENT_DISALLOWED_TOOLS   — comma-separated denylist of tools
 *
 * This extension is designed for runner-spawned workers created via the
 * spawn_session tool or the /agents UI command. It:
 *   1. On session_start, sets the requested model (if specified)
 *   2. Sets the session name to the agent name (if spawned as an agent)
 *   3. Applies tool restrictions from agent definition (if specified)
 *   4. Sends the initial prompt as a user message (if specified)
 *   5. Clears prompt/model env vars so restarts don't re-send
 */
export const initialPromptExtension: ExtensionFactory = (pi) => {
    const initialPrompt = process.env.PIZZAPI_WORKER_INITIAL_PROMPT?.trim();
    const initialModelProvider = process.env.PIZZAPI_WORKER_INITIAL_MODEL_PROVIDER?.trim();
    const initialModelId = process.env.PIZZAPI_WORKER_INITIAL_MODEL_ID?.trim();
    const agentName = process.env.PIZZAPI_WORKER_AGENT_NAME?.trim();
    const agentTools = process.env.PIZZAPI_WORKER_AGENT_TOOLS?.trim();
    const agentDisallowedTools = process.env.PIZZAPI_WORKER_AGENT_DISALLOWED_TOOLS?.trim();
    const resumePath = process.env.PIZZAPI_WORKER_RESUME_PATH?.trim();

    // Nothing to do if no initial prompt, initial model, agent, or resume path was set.
    if (!initialPrompt && !agentName && !resumePath && !(initialModelProvider && initialModelId)) return;

    // Clear prompt/model/resume env vars immediately so restarts don't re-trigger.
    // Agent name is NOT cleared — it should persist across restarts.
    delete process.env.PIZZAPI_WORKER_INITIAL_PROMPT;
    delete process.env.PIZZAPI_WORKER_INITIAL_MODEL_PROVIDER;
    delete process.env.PIZZAPI_WORKER_INITIAL_MODEL_ID;
    delete process.env.PIZZAPI_WORKER_RESUME_PATH;

    let fired = false;

    pi.on("session_start", async (_event, ctx) => {
        if (fired) return;
        fired = true;

        // Set the model first if requested.
        if (initialModelProvider && initialModelId) {
            const model = ctx.modelRegistry.find(initialModelProvider, initialModelId);
            if (model) {
                try {
                    const ok = await pi.setModel(model);
                    if (ok) {
                        log.info(`pizzapi worker: initial model set to ${initialModelProvider}/${initialModelId}`);
                    } else {
                        log.warn(
                            `pizzapi worker: model ${initialModelProvider}/${initialModelId} selected but no valid credentials found — using default`,
                        );
                    }
                } catch (err) {
                    log.warn(
                        `pizzapi worker: failed to set initial model ${initialModelProvider}/${initialModelId}: ${err instanceof Error ? err.message : String(err)}`,
                    );
                }
            } else {
                log.warn(
                    `pizzapi worker: requested model ${initialModelProvider}/${initialModelId} not found in registry`,
                );
            }
        }

        // Set session name to agent name (if spawned as an agent).
        if (agentName) {
            try {
                pi.setSessionName(`🤖 ${agentName}`);
                log.info(`pizzapi worker: session name set to agent "${agentName}"`);
            } catch (err) {
                log.warn(
                    `pizzapi worker: failed to set agent session name: ${err instanceof Error ? err.message : String(err)}`,
                );
            }
        }

        // Apply tool restrictions from agent definition (if specified).
        // `tools` is an allowlist — only the listed tools are enabled.
        // `disallowedTools` is a denylist — listed tools are removed from the active set.
        // Both can be specified: allowlist is applied first, then denylist filters the result.
        if (agentTools) {
            try {
                const requested = agentTools.split(",").map(t => t.trim()).filter(Boolean);
                // Resolve names case-insensitively against the set of all known tools
                // so frontmatter values like "Read, Bash" map to "read", "bash".
                // Also map Claude Code tool aliases (Glob→find, Grep→grep, etc.)
                // so agent files written for Claude Code work correctly.
                const claudeToPi: Record<string, string> = {
                    read: "read_file",
                    write: "write_file",
                    edit: "write_file",
                    multiedit: "write_file",
                    bash: "bash",
                    glob: "search",
                    grep: "search",
                    ls: "search",
                    find: "search",
                };
                const allTools = pi.getAllTools();
                const toolIndex = new Map(allTools.map(t => [t.name.toLowerCase(), t.name]));
                const allowed = requested
                    .map(r => {
                        // Try direct case-insensitive match first
                        const direct = toolIndex.get(r.toLowerCase());
                        if (direct) return direct;
                        // Fall back to Claude alias mapping (case-insensitive)
                        const mapped = claudeToPi[r.toLowerCase()];
                        if (mapped) return toolIndex.get(mapped.toLowerCase());
                        return undefined;
                    })
                    .filter((t): t is string => t !== undefined);
                // Deduplicate (e.g. Edit + MultiEdit both resolve to "edit")
                const uniqueAllowed = [...new Set(allowed)];
                // Fail-closed: if an allowlist was specified, apply it even if
                // no tools resolved — an empty set is safer than full access.
                pi.setActiveTools(uniqueAllowed);
                if (uniqueAllowed.length > 0) {
                    log.info(`pizzapi worker: agent tool allowlist applied: ${uniqueAllowed.join(", ")}`);
                } else {
                    log.warn(`pizzapi worker: agent tool allowlist matched no known tools (requested: ${requested.join(", ")}). All tools disabled for safety.`);
                }
            } catch (err) {
                log.warn(
                    `failed to apply agent tool allowlist: ${err instanceof Error ? err.message : String(err)}`,
                );
            }
        }
        if (agentDisallowedTools) {
            try {
                // Map Claude aliases to pi names for the denylist too
                const claudeToPiDeny: Record<string, string> = {
                    read: "read_file", write: "write_file", edit: "write_file",
                    multiedit: "write_file", bash: "bash", glob: "search", grep: "search",
                    ls: "search", find: "search",
                };
                const rawDenied = agentDisallowedTools.split(",").map(t => t.trim()).filter(Boolean);
                const denied = new Set(rawDenied.flatMap(t => {
                    const lower = t.toLowerCase();
                    const mapped = claudeToPiDeny[lower];
                    // Include both the original (lowercased) and the mapped name
                    return mapped && mapped !== lower ? [lower, mapped] : [lower];
                }));
                const current = pi.getActiveTools();
                const filtered = current.filter(t => !denied.has(t.toLowerCase()));
                if (filtered.length < current.length) {
                    pi.setActiveTools(filtered);
                    log.info(`pizzapi worker: agent tool denylist applied, removed: ${[...denied].join(", ")}`);
                }
            } catch (err) {
                log.warn(
                    `pizzapi worker: failed to apply agent tool denylist: ${err instanceof Error ? err.message : String(err)}`,
                );
            }
        }

        // Resume an existing session file if requested.
        // This loads the previous conversation into this new worker session.
        if (resumePath) {
            try {
                if (typeof (pi as any).switchSession === "function") {
                    const result = await (pi as any).switchSession(resumePath);
                    if (result?.cancelled) {
                        log.warn(`pizzapi worker: resume of ${resumePath} was cancelled`);
                    } else {
                        log.info(`pizzapi worker: resumed session from ${resumePath}`);
                    }
                } else {
                    log.warn("pizzapi worker: switchSession not available — cannot resume");
                }
            } catch (err) {
                log.warn(`pizzapi worker: failed to resume session from ${resumePath}: ${err instanceof Error ? err.message : String(err)}`);
            }
        }

        // Send the initial prompt as a user message.
        //
        // We must wait for BOTH:
        //  1. The relay to register — so that triggers emitted during the first
        //     turn (AskUserQuestion, plan_mode, session_complete) are routed to
        //     the parent session. Falls back after 10s if relay never connects.
        //  2. Worker startup to finish — so that MCP tools, plugins, and hooks
        //     are fully loaded before the first agent turn begins.
        //
        // Without (2), slow MCP startup + an initial prompt races with any
        // user input the web UI buffers during boot: the initial prompt can
        // start streaming before the startup gate releases, then the buffered
        // user message hits an already-streaming agent with no deliverAs and
        // is silently dropped. See fix/mcp-startup-session-limbo for context.
        if (initialPrompt) {
            void (async () => {
                try {
                    await Promise.all([
                        waitForRelayRegistration(10_000),
                        waitForWorkerStartupComplete(),
                    ]);
                    log.info(`pizzapi worker: sending initial prompt (${initialPrompt.length} chars)`);
                    pi.sendUserMessage(initialPrompt);
                } catch (err) {
                    log.warn(
                        `pizzapi worker: failed to dispatch initial prompt: ${err instanceof Error ? err.message : String(err)}`,
                    );
                }
            })();
        }
    });
};
