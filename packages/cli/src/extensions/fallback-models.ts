/**
 * Fallback model chain for rate-limit / quota errors.
 *
 * When the active model returns a hard usage-limit error, this extension
 * automatically switches to the next configured fallback model and retries
 * the last user prompt as a steer message. It cascades through the chain
 * until one model succeeds or the chain is exhausted.
 *
 * Configuration lives in ~/.pizzapi/settings.json as an ordered list of model
 * references (`provider:modelId` or just `modelId`):
 *
 *   { "fallbackModels": ["openai-codex:gpt-5.5", "ollama-cloud:glm-5.2"] }
 */
import type { ExtensionAPI, ExtensionContext, ExtensionFactory } from "@earendil-works/pi-coding-agent";
import type { ImageContent, Model, TextContent } from "@earendil-works/pi-ai";
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { isUsageLimitError } from "./remote/usage-limit-error.js";
import { findCachedOllamaCloudModel } from "../ollama-cloud-models.js";

type UserContent = string | (TextContent | ImageContent)[];

interface FallbackState {
    chain: string[];
    lastInput?: UserContent;
    tried: Set<string>;
}

const sessions = new Map<string, FallbackState>();

function getSessionId(ctx: ExtensionContext): string {
    return ctx.sessionManager.getSessionId() ?? process.env.PIZZAPI_SESSION_ID ?? "unknown";
}

function loadFallbackModels(): string[] {
    try {
        const settings = JSON.parse(readFileSync(join(homedir(), ".pizzapi", "settings.json"), "utf-8"));
        const models = settings?.fallbackModels;
        if (Array.isArray(models)) {
            return models.filter((m): m is string => typeof m === "string" && m.trim() !== "");
        }
    } catch {
        // settings.json missing or malformed — no fallbacks
    }
    return [];
}

function parseModelRef(ref: string): { provider?: string; id: string } {
    const idx = ref.indexOf(":");
    if (idx > 0) {
        return { provider: ref.slice(0, idx), id: ref.slice(idx + 1) };
    }
    return { id: ref };
}

function modelKey(m: { provider: string; id: string }): string {
    return `${m.provider}:${m.id}`;
}

function resolveModel(registry: ExtensionContext["modelRegistry"], ref: string): Model<any> | undefined {
    const { provider, id } = parseModelRef(ref);
    if (provider) {
        return registry.find(provider, id) ?? findCachedOllamaCloudModel(provider, id);
    }
    // No provider: search all registered providers for the model id.
    for (const m of registry.getAll()) {
        if (m.id === id) return m;
    }
    return findCachedOllamaCloudModel("ollama-cloud", id);
}

function resolveModelKey(registry: ExtensionContext["modelRegistry"], ref: string): string | undefined {
    const model = resolveModel(registry, ref);
    return model ? modelKey(model) : undefined;
}

function captureInput(state: FallbackState, text: string, images?: ImageContent[]): void {
    state.lastInput = images?.length ? [{ type: "text", text }, ...images] : text;
    state.tried.clear();
}

/**
 * Walk the fallback chain until we find an authenticated model we can switch
 * to, or exhaust the chain. Returns the selected model and its reference
 * string, or undefined when nothing is available.
 */
function selectFallback(
    state: FallbackState,
    currentKey: string | undefined,
    registry: ExtensionContext["modelRegistry"],
): { model: Model<any>; ref: string } | undefined {
    // Find where the current model appears in the resolved chain, if at all.
    let currentIdx = -1;
    for (let i = 0; i < state.chain.length; i++) {
        if (resolveModelKey(registry, state.chain[i]) === currentKey) {
            currentIdx = i;
            break;
        }
    }
    const start = currentIdx >= 0 ? currentIdx + 1 : 0;

    for (let i = start; i < state.chain.length; i++) {
        const ref = state.chain[i];
        const model = resolveModel(registry, ref);
        if (!model) continue;
        const key = modelKey(model);
        if (state.tried.has(key)) continue;
        state.tried.add(key);
        if (!registry.hasConfiguredAuth(model)) continue;
        return { model, ref };
    }
    return undefined;
}

export const fallbackModelsExtension: ExtensionFactory = (pi) => {
    pi.on("session_start", (_event, ctx) => {
        const sessionId = getSessionId(ctx);
        sessions.set(sessionId, { chain: loadFallbackModels(), tried: new Set() });
    });

    pi.on("input", (event, ctx) => {
        const sessionId = getSessionId(ctx);
        const state = sessions.get(sessionId);
        if (!state) return;
        captureInput(state, event.text, event.images);
    });

    pi.on("turn_end", async (event, ctx) => {
        const sessionId = getSessionId(ctx);
        const state = sessions.get(sessionId);
        if (!state || state.chain.length === 0) return;

        const msg = event.message;
        if (!msg || msg.role !== "assistant") return;

        if (msg.stopReason !== "error") {
            // Any non-error turn means we're past the current prompt; reset
            // the tried set so future rate limits start fresh.
            state.tried.clear();
            return;
        }

        if (!isUsageLimitError(msg.errorMessage ?? "")) return;

        const currentModel = ctx.model;
        const currentKey = currentModel ? modelKey(currentModel) : undefined;
        if (currentKey) state.tried.add(currentKey);

        const selected = selectFallback(state, currentKey, ctx.modelRegistry);
        if (!selected) {
            pi.sendMessage({
                customType: "fallback_status",
                content: "All configured fallback models are unavailable or also rate-limited. Returning control to you.",
                display: true,
            });
            return;
        }

        const ok = await pi.setModel(selected.model);
        if (!ok) {
            pi.sendMessage({
                customType: "fallback_status",
                content: `Could not switch to fallback model ${selected.ref}. Returning control to you.`,
                display: true,
            });
            return;
        }

        pi.sendMessage({
            customType: "fallback_status",
            content: `${currentModel ? modelKey(currentModel) : "Primary model"} hit a rate limit. Retrying with ${selected.ref}.`,
            display: true,
        });

        if (state.lastInput) {
            pi.sendUserMessage(state.lastInput, { deliverAs: "steer" });
        } else {
            // No captured input (e.g. resumed session or untracked source).
            // Ask the agent to retry generically rather than silently giving up.
            pi.sendUserMessage(
                "The previous request failed due to a provider rate limit. Please retry the last request.",
                { deliverAs: "steer" },
            );
        }
    });

    pi.on("session_shutdown", (_event, ctx) => {
        sessions.delete(getSessionId(ctx));
    });
};
