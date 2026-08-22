/**
 * Replaces pi-ai's static OpenRouter catalog with OpenRouter's live
 * /api/v1/models list (see ../openrouter-models.ts).
 *
 * Registration is synchronous so the provider is in place before model
 * resolution; the network fetch is stale-while-revalidate — the cached list
 * (24h TTL) is used immediately and a refreshed catalog re-registers the
 * provider so the runtime's model snapshot picks it up mid-session.
 */
import { join } from "node:path";
import type { ExtensionFactory } from "@earendil-works/pi-coding-agent";
import { readStoredCredential } from "@earendil-works/pi-coding-agent";
import { defaultAgentDir, expandHome, loadConfig } from "../config.js";
import { fetchOpenRouterModels, registerOpenRouterProvider } from "../openrouter-models.js";

/** Only spend a request on users who can actually call OpenRouter. */
function hasOpenRouterCreds(): boolean {
    if (process.env.OPENROUTER_API_KEY) return true;
    try {
        const config = loadConfig(process.cwd());
        const agentDir = config.agentDir ? expandHome(config.agentDir) : defaultAgentDir();
        return readStoredCredential("openrouter", join(agentDir, "auth.json")) !== undefined;
    } catch {
        return false;
    }
}

export const openrouterProviderExtension: ExtensionFactory = (pi) => {
    registerOpenRouterProvider(pi);
    if (!hasOpenRouterCreds()) return;
    void fetchOpenRouterModels()
        .then(() => registerOpenRouterProvider(pi))
        .catch(() => {
            // Offline or API down — the cached/static catalog stays in place.
        });
};
