/**
 * Custom model loading for the web server.
 *
 * Reads an optional models.json from the data directory and merges
 * custom models into the built-in pi-ai model list. This allows the
 * web UI to display newly released models without waiting for an
 * upstream pi-ai update.
 *
 * File format:
 * {
 *   "models": [
 *     { "provider": "openai", "id": "gpt-5.4", "name": "GPT-5.4" }
 *   ]
 * }
 */
import { existsSync, readFileSync } from "fs";
import { getProviders, getModels } from "@mariozechner/pi-ai";

export interface CustomModelEntry {
    provider: string;
    id: string;
    name: string;
}

interface CustomModelsFile {
    models?: Array<Record<string, unknown>>;
}

/** Load custom models from a JSON file. Returns [] on any error. */
export function loadCustomModels(filePath: string): CustomModelEntry[] {
    try {
        if (!existsSync(filePath)) return [];
        const raw = readFileSync(filePath, "utf-8");
        const data = JSON.parse(raw) as CustomModelsFile;
        if (!Array.isArray(data?.models)) return [];

        return data.models.filter(isValidEntry).map((m) => ({
            provider: m.provider as string,
            id: m.id as string,
            name: m.name as string,
        }));
    } catch {
        return [];
    }
}

function isValidEntry(m: Record<string, unknown>): boolean {
    return (
        typeof m.provider === "string" && m.provider.length > 0 &&
        typeof m.id === "string" && m.id.length > 0 &&
        typeof m.name === "string" && m.name.length > 0
    );
}

/**
 * Get all models: built-in from pi-ai + custom from file.
 * Custom models are appended only if their id doesn't already exist
 * for the same provider in the built-in list.
 */
export function getAllModels(customModelsPath: string): CustomModelEntry[] {
    const providers = getProviders();
    const builtIn: CustomModelEntry[] = providers.flatMap((p) =>
        getModels(p).map((m) => ({ provider: p, id: m.id, name: m.name })),
    );

    const existingKeys = new Set(builtIn.map((m) => `${m.provider}:${m.id}`));
    const custom = loadCustomModels(customModelsPath);
    const newModels = custom.filter((m) => !existingKeys.has(`${m.provider}:${m.id}`));

    return [...builtIn, ...newModels];
}
