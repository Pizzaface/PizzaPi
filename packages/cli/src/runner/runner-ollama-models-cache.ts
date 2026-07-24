/**
 * Runner-side Ollama Cloud model refresh loop.
 *
 * The daemon's model list surfaces Ollama Cloud models from the on-disk cache
 * (see ollama-cloud-models.ts). That cache is normally warmed by live sessions,
 * so a runner that hasn't started a session recently can serve a stale list and
 * miss newer models (e.g. glm-5.2). This loop keeps the cache fresh on the
 * runner itself, independent of session activity, refreshing every 12 hours.
 */
import { join } from "node:path";
import { readStoredCredential } from "@earendil-works/pi-coding-agent";
import { loadConfig, defaultAgentDir, expandHome } from "../config.js";
import { fetchOllamaCloudModels } from "../ollama-cloud-models.js";
import { logInfo, logWarn } from "./logger.js";

const OLLAMA_MODELS_REFRESH_INTERVAL = 12 * 60 * 60 * 1000;

let _timer: ReturnType<typeof setInterval> | null = null;

function hasOllamaCreds(): boolean {
    if (process.env.OLLAMA_API_KEY) return true;
    try {
        const config = loadConfig(process.cwd());
        const agentDir = config.agentDir ? expandHome(config.agentDir) : defaultAgentDir();
        return readStoredCredential("ollama-cloud", join(agentDir, "auth.json"))?.type === "api_key";
    } catch {
        return false;
    }
}

async function refresh(force: boolean): Promise<void> {
    if (!hasOllamaCreds()) return;
    try {
        const models = await fetchOllamaCloudModels({ force });
        logInfo(`ollama-cloud models refreshed (${models.length})`);
    } catch (err: any) {
        logWarn(`failed to refresh ollama-cloud models: ${err?.message ?? String(err)}`);
    }
}

export function startOllamaModelsRefreshLoop(): void {
    if (_timer !== null) return;
    // Warm the cache on boot without forcing (respects the 24h TTL), then force
    // a fresh fetch every 12h so the runner never serves a >12h-stale list.
    void refresh(false);
    _timer = setInterval(() => {
        void refresh(true);
    }, OLLAMA_MODELS_REFRESH_INTERVAL);
}

export function stopOllamaModelsRefreshLoop(): void {
    if (_timer !== null) {
        clearInterval(_timer);
        _timer = null;
    }
}
