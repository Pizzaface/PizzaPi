/**
 * `pizza models` command implementation.
 *
 * Lists available models. For providers with static metadata, the model registry
 * is used as before. For Ollama Cloud, when an API key is configured, the live
 * https://ollama.com/v1/models endpoint is fetched and enriched with /api/show
 * metadata. Results are cached for 24 hours in ~/.pizzapi.
 */
import { ModelRegistry, ModelRuntime } from "@earendil-works/pi-coding-agent";
import { join } from "path";
import { c } from "./cli-colors.js";
import { defaultAgentDir, expandHome, loadConfig } from "./config.js";
import { createLogger } from "@pizzapi/tools";
import { fetchOllamaCloudModels, type OllamaCloudModel } from "./ollama-cloud-models.js";
import { mergeModelLists, readSessionModelsCache } from "./session-models-cache.js";

const log = createLogger("models");

interface ModelListEntry {
    provider: string;
    id: string;
    name: string;
    contextWindow: number;
    reasoning: boolean;
}

export async function runModelsCommand(args: string[], cwd: string): Promise<number> {
    const showJson = args.includes("--json");

    const config = loadConfig(cwd);
    const agentDir = config.agentDir ? expandHome(config.agentDir) : defaultAgentDir();

    const runtime = await ModelRuntime.create({
        authPath: join(agentDir, "auth.json"),
        modelsPath: join(agentDir, "models.json"),
    });
    const modelRegistry = new ModelRegistry(runtime);

    const staticEntries = modelRegistry
        .getAvailable()
        .map((model): ModelListEntry => ({
            provider: model.provider,
            id: model.id,
            name: model.name,
            contextWindow: model.contextWindow,
            reasoning: model.reasoning,
        }));

    let ollamaEntries: ModelListEntry[] = [];
    if (runtime.hasConfiguredAuth("ollama-cloud") || process.env.OLLAMA_API_KEY) {
        try {
            const live = await fetchOllamaCloudModels();
            ollamaEntries = live.map(toModelListEntry);
        } catch (err) {
            log.warn(
                `Could not refresh Ollama Cloud models: ${err instanceof Error ? err.message : String(err)}`,
            );
        }
    }

    // Deduplicate: static registry wins, then live Ollama, then the last live
    // session's snapshot (extension-registered providers like claude-subscription).
    const allEntries = mergeModelLists(
        mergeModelLists(staticEntries, ollamaEntries),
        readSessionModelsCache() ?? [],
    );

    if (showJson) {
        log.info(JSON.stringify({ models: allEntries }, null, 2));
        return 0;
    }

    if (allEntries.length === 0) {
        log.info("No configured models found.");
        log.info(`Checked credentials in ${join(agentDir, "auth.json")}`);
        return 0;
    }

    const byProvider = new Map<string, ModelListEntry[]>();
    for (const model of allEntries) {
        const group = byProvider.get(model.provider) ?? [];
        group.push(model);
        byProvider.set(model.provider, group);
    }

    const modelWidth = Math.max(...allEntries.map((m) => m.id.length), "model".length);

    log.info("");
    for (const [provider, models] of byProvider) {
        log.info(c.label(provider));
        for (const model of models) {
            const noteParts: string[] = [];
            if (model.reasoning) noteParts.push(c.accent("reasoning"));
            if (model.contextWindow) noteParts.push(c.dim(`${model.contextWindow.toLocaleString()} ctx`));
            if (model.name && model.name !== model.id) noteParts.push(c.dim(model.name));
            const notes = noteParts.join(c.dim(" • "));
            log.info(`  ${c.cmd(model.id.padEnd(modelWidth))}  ${notes}`);
        }
        log.info("");
    }
    return 0;
}

function toModelListEntry(model: OllamaCloudModel): ModelListEntry {
    return {
        provider: model.provider,
        id: model.id,
        name: model.name,
        contextWindow: model.contextWindow,
        reasoning: model.reasoning,
    };
}
