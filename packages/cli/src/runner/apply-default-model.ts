/**
 * Re-apply the settings default model after extension providers registered.
 *
 * pi's createAgentSession resolves the initial model via findInitialModel
 * BEFORE extension factories flush their pi.registerProvider() calls into the
 * ModelRegistry (the flush happens later in the AgentSession constructor).
 * So a settings.json default pointing at an extension-registered provider
 * (e.g. minimalcc-pi's claude-subscription) never resolves and findInitialModel
 * silently falls back to the first built-in provider default (openai/gpt-5.5).
 *
 * By the time createAgentSession returns, the registry is complete — so the
 * worker calls this to re-resolve the default. Explicit spawn models
 * (PIZZAPI_WORKER_INITIAL_MODEL_*) and resumed sessions set their own model
 * later during bindExtensions session_start, so they still win over this.
 */
import { findCachedOllamaCloudModel } from "../ollama-cloud-models.js";

interface PendingProviderRuntime {
    pendingProviderRegistrations: Array<{ name: string; config: unknown; extensionPath: string }>;
    pendingNativeProviderRegistrations: Array<{ provider: unknown; extensionPath: string }>;
}

export interface ProviderFlushTargets {
    loader: { getExtensions(): { runtime: PendingProviderRuntime } };
    modelRuntime: {
        registerProvider(name: string, config: unknown): void;
        registerNativeProvider(provider: unknown): void;
    };
    warn: (message: string) => void;
}

/**
 * Flush provider registrations queued by extension factories into the
 * ModelRuntime — mirrors pi 0.82's createAgentSessionServices(), which the
 * worker bypasses by building its own loader + ModelRuntime. Without this,
 * extension providers (e.g. claude-subscription) are invisible to
 * findInitialModel and new sessions fall back to the first built-in provider
 * default (openai-codex/gpt-5.5). Returns the number of providers registered.
 */
export function flushPendingExtensionProviders({ loader, modelRuntime, warn }: ProviderFlushTargets): number {
    const runtime = loader.getExtensions().runtime;
    let registered = 0;
    for (const { name, config, extensionPath } of runtime.pendingProviderRegistrations) {
        try {
            modelRuntime.registerProvider(name, config);
            registered++;
        } catch (e) {
            warn(`extension "${extensionPath}" provider registration failed: ${e instanceof Error ? e.message : String(e)}`);
        }
    }
    runtime.pendingProviderRegistrations = [];
    for (const { provider, extensionPath } of runtime.pendingNativeProviderRegistrations) {
        try {
            modelRuntime.registerNativeProvider(provider);
            registered++;
        } catch (e) {
            warn(`extension "${extensionPath}" native provider registration failed: ${e instanceof Error ? e.message : String(e)}`);
        }
    }
    runtime.pendingNativeProviderRegistrations = [];
    return registered;
}

interface ModelRef {
    provider: string;
    id: string;
}

/** pi ≥0.84: AgentSession.modelRuntime getter (ModelRuntime API). */
interface ModelRuntimeLike {
    getModel(provider: string, modelId: string): unknown;
    hasConfiguredAuth(provider: string): boolean;
}

/** pi <0.84 legacy: AgentSession.modelRegistry getter (ModelRegistry API). */
interface ModelRegistryLike {
    find(provider: string, modelId: string): unknown;
    hasConfiguredAuth(model: unknown): boolean;
}

export interface DefaultModelSession {
    model?: ModelRef;
    settingsManager: {
        getDefaultProvider(): string | undefined;
        getDefaultModel(): string | undefined;
    };
    /** At least one of the two must be present. Prefer modelRuntime (current pi). */
    modelRuntime?: ModelRuntimeLike;
    modelRegistry?: ModelRegistryLike;
    agent: { state: { messages: unknown[] } };
    setModel(model: unknown): Promise<void>;
}

function resolveFromRegistry(
    session: DefaultModelSession,
    provider: string,
    modelId: string,
): unknown {
    if (session.modelRuntime) {
        return session.modelRuntime.getModel(provider, modelId);
    }
    return session.modelRegistry?.find(provider, modelId);
}

function hasAuthFor(session: DefaultModelSession, resolved: unknown): boolean {
    if (session.modelRuntime) {
        return session.modelRuntime.hasConfiguredAuth((resolved as ModelRef).provider);
    }
    return session.modelRegistry?.hasConfiguredAuth(resolved) ?? false;
}

/** Returns true when the session's model was switched to the settings default. */
export async function applySettingsDefaultModel(session: DefaultModelSession): Promise<boolean> {
    // A session with messages restored its own model — leave it alone.
    if (session.agent.state.messages.length > 0) return false;
    const provider = session.settingsManager.getDefaultProvider();
    const modelId = session.settingsManager.getDefaultModel();
    if (!provider || !modelId) return false;
    const current = session.model;
    if (current?.provider === provider && current?.id === modelId) return false;
    // Ollama Cloud models are discovered dynamically and aren't in the static
    // registry — fall back to the cached catalog so a settings default pointing
    // at e.g. ollama-cloud/glm-5.3 still gets applied.
    const resolved =
        resolveFromRegistry(session, provider, modelId) ??
        findCachedOllamaCloudModel(provider, modelId);
    if (!resolved || !hasAuthFor(session, resolved)) return false;
    await session.setModel(resolved);
    return true;
}
