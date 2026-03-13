import type { ExtensionFactory } from "@mariozechner/pi-coding-agent";

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

    // Nothing to do if no initial prompt and no agent was set.
    if (!initialPrompt && !agentName) return;

    // Clear prompt/model env vars immediately so restarts don't re-trigger.
    // Agent name is NOT cleared — it should persist across restarts.
    delete process.env.PIZZAPI_WORKER_INITIAL_PROMPT;
    delete process.env.PIZZAPI_WORKER_INITIAL_MODEL_PROVIDER;
    delete process.env.PIZZAPI_WORKER_INITIAL_MODEL_ID;

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
                        console.log(`pizzapi worker: initial model set to ${initialModelProvider}/${initialModelId}`);
                    } else {
                        console.warn(
                            `pizzapi worker: model ${initialModelProvider}/${initialModelId} selected but no valid credentials found — using default`,
                        );
                    }
                } catch (err) {
                    console.warn(
                        `pizzapi worker: failed to set initial model ${initialModelProvider}/${initialModelId}: ${err instanceof Error ? err.message : String(err)}`,
                    );
                }
            } else {
                console.warn(
                    `pizzapi worker: requested model ${initialModelProvider}/${initialModelId} not found in registry`,
                );
            }
        }

        // Set session name to agent name (if spawned as an agent).
        if (agentName) {
            try {
                pi.setSessionName(`🤖 ${agentName}`);
                console.log(`pizzapi worker: session name set to agent "${agentName}"`);
            } catch (err) {
                console.warn(
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
                const allowed = agentTools.split(",").map(t => t.trim()).filter(Boolean);
                if (allowed.length > 0) {
                    pi.setActiveTools(allowed);
                    console.log(`pizzapi worker: agent tool allowlist applied: ${allowed.join(", ")}`);
                }
            } catch (err) {
                console.warn(
                    `pizzapi worker: failed to apply agent tool allowlist: ${err instanceof Error ? err.message : String(err)}`,
                );
            }
        }
        if (agentDisallowedTools) {
            try {
                const denied = new Set(agentDisallowedTools.split(",").map(t => t.trim().toLowerCase()).filter(Boolean));
                const current = pi.getActiveTools();
                const filtered = current.filter(t => !denied.has(t.toLowerCase()));
                if (filtered.length < current.length) {
                    pi.setActiveTools(filtered);
                    console.log(`pizzapi worker: agent tool denylist applied, removed: ${[...denied].join(", ")}`);
                }
            } catch (err) {
                console.warn(
                    `pizzapi worker: failed to apply agent tool denylist: ${err instanceof Error ? err.message : String(err)}`,
                );
            }
        }

        // Send the initial prompt as a user message.
        // Use a small delay to ensure the relay connection is established and
        // the session is fully initialized before sending the prompt.
        if (initialPrompt) {
            setTimeout(() => {
                console.log(`pizzapi worker: sending initial prompt (${initialPrompt.length} chars)`);
                pi.sendUserMessage(initialPrompt);
            }, 1000);
        }
    });
};
