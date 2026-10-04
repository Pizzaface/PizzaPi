/**
 * Fallback model chain for rate-limit / quota / provider-capacity errors.
 *
 * When the active model returns a hard usage-limit error or a provider
 * capacity error (e.g. Anthropic "overloaded_error"), this extension
 * automatically switches to the next configured fallback model and retries
 * the last user prompt as a steer message. It cascades through the chain
 * until one model succeeds or the chain is exhausted.
 *
 * Configuration lives in ~/.pizzapi/settings.json as an ordered list of model
 * references (`provider:modelId` or just `modelId`):
 *
 *   { "fallbackModels": ["openai-codex:gpt-5.5", "ollama-cloud:glm-5.2"] }
 */
import type { ExtensionContext, ExtensionFactory, TurnEndEventResult } from "@earendil-works/pi-coding-agent";
import type { ImageContent, Model, TextContent } from "@earendil-works/pi-ai";
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { isProviderCapacityError, isUsageLimitError } from "./remote/usage-limit-error.js";
import { findCachedOllamaCloudModel } from "../ollama-cloud-models.js";
import { buildProviderUsage, refreshAllUsage } from "./remote-provider-usage.js";
import { waitForQuotaReturn } from "./rate-limit-wait.js";

type UserContent = string | (TextContent | ImageContent)[];

interface PendingWait {
    model: Model<any> | undefined;
    generation: number;
}

interface FallbackState {
    chain: string[];
    waitForRateLimits: boolean;
    lastInput?: UserContent;
    tried: Set<string>;
    pendingWait?: PendingWait;
    lastWaitableFailure?: PendingWait;
    controller?: AbortController;
    generation: number;
    recoveryAttempts: number;
}

const sessions = new Map<string, FallbackState>();

function getSessionId(ctx: ExtensionContext): string {
    return ctx.sessionManager.getSessionId() ?? process.env.PIZZAPI_SESSION_ID ?? "unknown";
}

function settingsPath(): string {
    return join(homedir(), ".pizzapi", "settings.json");
}

function loadSettings(): Record<string, unknown> {
    try {
        const parsed = JSON.parse(readFileSync(settingsPath(), "utf-8"));
        return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
    } catch {
        return {};
    }
}

function loadFallbackModels(settings = loadSettings()): string[] {
    const models = settings.fallbackModels;
    if (Array.isArray(models)) {
        return models.filter((m): m is string => typeof m === "string" && m.trim() !== "");
    }
    return [];
}

function loadWaitForRateLimits(settings = loadSettings()): boolean {
    return settings.waitForRateLimits === true;
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

function cancelWait(state: FallbackState, reason?: string): void {
    state.generation++;
    state.pendingWait = undefined;
    state.lastWaitableFailure = undefined;
    state.controller?.abort(reason);
    state.controller = undefined;
}

function captureInput(state: FallbackState, text: string, images?: ImageContent[]): void {
    cancelWait(state, "new input");
    state.lastInput = images?.length ? [{ type: "text", text }, ...images] : text;
    state.tried.clear();
    state.recoveryAttempts = 0;
}

type QuotaWaitResult = Awaited<ReturnType<typeof waitForQuotaReturn>>;

function quotaNotReadyReason(result: Exclude<QuotaWaitResult, { state: "available" }>): string {
    if (result.state === "limited") return `quota is still exhausted until ${result.resetAt}`;
    return result.reason === "unsupported_provider"
        ? "quota endpoint did not confirm an exhausted subscription window"
        : result.reason;
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
    // turn_end fires while the session is still streaming; without
    // triggerTurn:false pi steers the notice into the agent as a new message,
    // which re-hits the rate limit and loops forever.
    const notify = (content: string) =>
        pi.sendMessage({ customType: "fallback_status", content, display: true }, { triggerTurn: false });

    pi.on("session_start", (_event, ctx) => {
        const settings = loadSettings();
        const sessionId = getSessionId(ctx);
        sessions.set(sessionId, {
            chain: loadFallbackModels(settings),
            waitForRateLimits: loadWaitForRateLimits(settings),
            tried: new Set(),
            generation: 0,
            recoveryAttempts: 0,
        });
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
        if (!state) return;

        const msg = event.message;
        if (!msg || msg.role !== "assistant") return;

        if (msg.stopReason !== "error") {
            // Any non-error turn means we're past the current prompt; reset
            // the tried set so future rate limits start fresh.
            state.tried.clear();
            state.pendingWait = undefined;
            state.recoveryAttempts = 0;
            return;
        }

        const errorMessage = msg.errorMessage ?? "";
        if (!isUsageLimitError(errorMessage) && !isProviderCapacityError(errorMessage)) return;

        const currentModel = ctx.model;
        const currentKey = currentModel ? modelKey(currentModel) : undefined;
        if (currentKey) state.tried.add(currentKey);

        const selected = state.chain.length > 0 ? selectFallback(state, currentKey, ctx.modelRegistry) : undefined;
        if (!selected) {
            if (isUsageLimitError(errorMessage)) {
                if (state.waitForRateLimits) {
                    const result = await runQuotaWait(state, { model: currentModel, generation: state.generation }, ctx.signal);
                    if (result) return result;
                    return;
                }
                state.lastWaitableFailure = { model: currentModel, generation: state.generation };
            }
            notify("All configured fallback models are unavailable or also rate-limited. Returning control to you.");
            return;
        }

        const ok = await pi.setModel(selected.model);
        if (!ok) {
            notify(`Could not switch to fallback model ${selected.ref}. Returning control to you.`);
            return;
        }

        notify(`${currentModel ? modelKey(currentModel) : "Primary model"} hit a provider limit. Retrying with ${selected.ref}.`);

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

    async function runQuotaWait(state: FallbackState, pending: PendingWait, signal?: AbortSignal): Promise<TurnEndEventResult | undefined> {
        if (state.recoveryAttempts >= 3) {
            notify("Rate-limit wait stopped after 3 recovery attempts for this input. Returning control to you.");
            return undefined;
        }
        cancelWait(state, "replaced wait");
        const activePending = { model: pending.model, generation: state.generation };
        state.recoveryAttempts++;
        const controller = new AbortController();
        state.controller = controller;
        state.pendingWait = activePending;
        notify("All fallbacks are exhausted; waiting for the current model quota to recover. Use /rate-limit-wait cancel to stop.");
        const onAbort = () => controller.abort("turn aborted");
        if (signal?.aborted) onAbort();
        else signal?.addEventListener("abort", onAbort, { once: true });
        try {
            const result = await waitForQuotaReturn(activePending.model, refreshAllUsage, buildProviderUsage, controller.signal);
            if (controller.signal.aborted || state.generation !== activePending.generation) return undefined;
            state.pendingWait = undefined;
            state.controller = undefined;
            if (result.state !== "available") {
                notify(`Rate-limit wait stopped: ${quotaNotReadyReason(result)}`);
                return undefined;
            }
            notify("Quota recovered; continuing once on the current model.");
            return {
                entries: [{
                    type: "custom_message",
                    customType: "fallback_status",
                    content: "The current model quota has recovered. Continue from the prior rate-limit failure without replaying completed tool side effects.",
                    display: false,
                }],
                continue: true,
            };
        } catch (err) {
            if (!controller.signal.aborted) throw err;
            notify("Rate-limit wait cancelled.");
            return undefined;
        } finally {
            signal?.removeEventListener("abort", onAbort);
            if (state.controller === controller && state.pendingWait === activePending) {
                state.pendingWait = undefined;
                state.controller = undefined;
            }
        }
    }

    pi.on("model_select", (_event, ctx) => {
        const state = sessions.get(getSessionId(ctx));
        if (state) cancelWait(state, "model changed");
    });

    async function continueAfterCommandWait(state: FallbackState, pending: PendingWait): Promise<void> {
        const activePending = pending;
        const controller = state.controller ?? new AbortController();
        state.controller = controller;
        try {
            const result = await waitForQuotaReturn(activePending.model, refreshAllUsage, buildProviderUsage, controller.signal);
            if (controller.signal.aborted || state.generation !== activePending.generation) return;
            state.pendingWait = undefined;
            state.controller = undefined;
            if (result.state !== "available") {
                notify(`Rate-limit wait stopped: ${quotaNotReadyReason(result)}`);
                return;
            }
            notify("Quota recovered; asking the agent to continue once.");
            pi.sendUserMessage(
                "The current model quota has recovered. Continue from the prior rate-limit failure without replaying completed tool side effects.",
                { deliverAs: "steer" },
            );
        } catch (err) {
            if (!controller.signal.aborted) throw err;
            notify("Rate-limit wait cancelled.");
        } finally {
            if (state.controller === controller && state.pendingWait === activePending) {
                state.pendingWait = undefined;
                state.controller = undefined;
            }
        }
    }

    pi.registerCommand("rate-limit-wait", {
        description: "Control waiting for subscription rate limits to recover",
        handler: async (args, ctx) => {
            const sessionId = getSessionId(ctx);
            const state = sessions.get(sessionId);
            const command = args.trim().toLowerCase();
            if (!state) return;

            if (command === "on") {
                state.waitForRateLimits = true;
                notify("Rate-limit wait enabled for this session.");
                if (!state.pendingWait && state.lastWaitableFailure) {
                    const pending = state.lastWaitableFailure;
                    state.lastWaitableFailure = undefined;
                    state.controller = new AbortController();
                    state.pendingWait = pending;
                    void continueAfterCommandWait(state, pending).catch((err) => {
                        notify(`Rate-limit wait failed: ${err instanceof Error ? err.message : String(err)}`);
                    });
                }
                return;
            }
            if (command === "off") {
                state.waitForRateLimits = false;
                cancelWait(state, "disabled");
                notify("Rate-limit wait disabled for this session.");
                return;
            }
            if (command === "cancel") {
                cancelWait(state, "cancelled");
                notify("Rate-limit wait cancelled.");
                return;
            }
            if (command === "status" || command === "") {
                const status = state.pendingWait
                    ? "waiting"
                    : state.waitForRateLimits
                      ? "enabled"
                      : "disabled";
                notify(`Rate-limit wait is ${status}.`);
                return;
            }
            notify("Usage: /rate-limit-wait on|off|cancel|status");
        },
    });

    pi.on("session_shutdown", (_event, ctx) => {
        const state = sessions.get(getSessionId(ctx));
        if (state) cancelWait(state, "session shutdown");
        sessions.delete(getSessionId(ctx));
    });
};
