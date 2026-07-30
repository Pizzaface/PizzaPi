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
 *
 * Extensions only load inside live sessions. Bare ModelRuntime consumers
 * (models-command.ts, daemon.ts's listConfiguredModels) never run this
 * factory, so they call the same registerOllamaCloudProvider() helper
 * directly — see ollama-cloud-models.ts for the shared config + registrar.
 */
import type { ExtensionFactory } from "@earendil-works/pi-coding-agent";
import { registerOllamaCloudProvider } from "../ollama-cloud-models.js";

export const ollamaCloudProviderExtension: ExtensionFactory = (pi) => {
    registerOllamaCloudProvider(pi);
};
