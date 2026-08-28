/**
 * Replaces pi-ai's static NVIDIA catalog with build.nvidia.com's live
 * /v1/models list (see ../nvidia-models.ts).
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
import { fetchNvidiaModels, registerNvidiaProvider } from "../nvidia-models.js";

/** Only spend a request on users who can actually call NVIDIA. */
function hasNvidiaCreds(): boolean {
    if (process.env.NVIDIA_API_KEY) return true;
    try {
        const config = loadConfig(process.cwd());
        const agentDir = config.agentDir ? expandHome(config.agentDir) : defaultAgentDir();
        return readStoredCredential("nvidia", join(agentDir, "auth.json")) !== undefined;
    } catch {
        return false;
    }
}

export const nvidiaProviderExtension: ExtensionFactory = (pi) => {
    registerNvidiaProvider(pi);
    if (!hasNvidiaCreds()) return;
    void fetchNvidiaModels()
        .then(() => registerNvidiaProvider(pi))
        .catch(() => {
            // Offline or API down — the cached/static catalog stays in place.
        });
};
