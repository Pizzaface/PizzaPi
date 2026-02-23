import type { ExtensionFactory } from "@mariozechner/pi-coding-agent";

/**
 * InitialPrompt extension — handles one-time model selection and initial prompt
 * injection when a worker session is spawned with PIZZAPI_WORKER_INITIAL_PROMPT
 * and optional PIZZAPI_WORKER_INITIAL_MODEL_PROVIDER / PIZZAPI_WORKER_INITIAL_MODEL_ID
 * environment variables.
 *
 * This extension is designed for runner-spawned workers created via the
 * spawn_session tool. It:
 *   1. On session_start, sets the requested model (if specified)
 *   2. Sends the initial prompt as a user message
 *   3. Clears the env vars so restarts don't re-send the prompt
 */
export const initialPromptExtension: ExtensionFactory = (pi) => {
    const initialPrompt = process.env.PIZZAPI_WORKER_INITIAL_PROMPT?.trim();
    const initialModelProvider = process.env.PIZZAPI_WORKER_INITIAL_MODEL_PROVIDER?.trim();
    const initialModelId = process.env.PIZZAPI_WORKER_INITIAL_MODEL_ID?.trim();

    // Nothing to do if no initial prompt was set.
    if (!initialPrompt) return;

    // Clear env vars immediately so restarts don't re-trigger.
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

        // Send the initial prompt as a user message.
        // Use a small delay to ensure the relay connection is established and
        // the session is fully initialized before sending the prompt.
        setTimeout(() => {
            console.log(`pizzapi worker: sending initial prompt (${initialPrompt.length} chars)`);
            pi.sendUserMessage(initialPrompt);
        }, 1000);
    });
};
