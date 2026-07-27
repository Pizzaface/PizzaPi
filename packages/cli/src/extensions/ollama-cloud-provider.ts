/**
 * Registers the Ollama Cloud provider + a static fallback model catalog via
 * pi.registerProvider(), replacing the ollama-cloud hunks that used to live
 * in the @earendil-works/pi-ai patch (env-key recognition, inlined model
 * catalog, builtinProviders() factory, KnownProvider typing).
 *
 * This factory runs synchronously at extension-load time (before pi's
 * bindCore() flushes queued provider registrations), so the provider and its
 * fallback models exist with zero network before ollama-cloud-models.ts's
 * live discovery/cache refreshes them elsewhere (daemon.ts, worker.ts,
 * spawn-session.ts, initial-prompt.ts).
 */
import type { ExtensionFactory } from "@earendil-works/pi-coding-agent";
import { OLLAMA_CLOUD_FALLBACK_MODELS } from "../ollama-cloud-fallback-models.js";
import { toOllamaCloudRuntimeModel } from "../ollama-cloud-models.js";

export const ollamaCloudProviderExtension: ExtensionFactory = (pi) => {
    pi.registerProvider("ollama-cloud", {
        name: "Ollama Cloud",
        baseUrl: "https://ollama.com/v1",
        apiKey: "$OLLAMA_API_KEY",
        api: "openai-completions",
        models: OLLAMA_CLOUD_FALLBACK_MODELS.map(toOllamaCloudRuntimeModel),
    });
};
