/**
 * Worker-side subagent/workflow default model preference.
 *
 * The relay pushes `subagent_model_update` ("provider/id" or null) when the
 * session registers and whenever the user edits the setting in the web UI.
 * Stored in an env var (like PIZZAPI_HIDDEN_MODELS) so every consumer —
 * including subagent engine code that has no session context — reads a fresh
 * value.
 */

/** Current configured default ("provider/id"), or null for auto-select. */
export function getSubagentDefaultModelKey(): string | null {
    const raw = process.env.PIZZAPI_SUBAGENT_MODEL?.trim();
    return raw || null;
}

/** Replace the default (called from the relay push handler). */
export function setSubagentDefaultModelKey(model: unknown): void {
    if (typeof model === "string" && model.trim()) {
        process.env.PIZZAPI_SUBAGENT_MODEL = model.trim();
    } else {
        delete process.env.PIZZAPI_SUBAGENT_MODEL;
    }
}
