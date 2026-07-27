/**
 * Worker-side hidden-model awareness.
 *
 * The runner daemon seeds PIZZAPI_HIDDEN_MODELS (JSON array of
 * "provider/modelId" keys) at spawn time from the owning user's preferences.
 * The relay pushes `hidden_models_update` when the user edits the list
 * mid-session; `setHiddenModelKeys` refreshes the env var so every consumer
 * (list_models tool, model switching, cycling, subagents) reads a fresh list.
 *
 * This is a user preference / hard-block by name — not a security boundary.
 * The authoritative copy lives server-side (user_hidden_model table).
 */

/** Parse the current hidden-model key set from the environment. */
export function getHiddenModelKeys(): Set<string> {
    try {
        const raw = process.env.PIZZAPI_HIDDEN_MODELS;
        if (!raw) return new Set();
        const parsed = JSON.parse(raw);
        if (!Array.isArray(parsed)) return new Set();
        return new Set(parsed.filter((x): x is string => typeof x === "string"));
    } catch {
        return new Set();
    }
}

/** Replace the hidden-model list (called from the relay push handler). */
export function setHiddenModelKeys(keys: unknown): void {
    const list = Array.isArray(keys) ? keys.filter((x): x is string => typeof x === "string") : [];
    process.env.PIZZAPI_HIDDEN_MODELS = JSON.stringify(list);
}

/** True when provider/id is on the hidden list. */
export function isModelHidden(provider: string | symbol, id: string): boolean {
    return getHiddenModelKeys().has(`${String(provider)}/${id}`);
}
