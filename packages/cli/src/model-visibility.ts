import { loadGlobalConfig, saveGlobalConfig } from "./config/io.js";

export interface ModelRef {
    provider: string;
    id: string;
}

export function modelKey(model: ModelRef): string {
    return `${model.provider.trim()}/${model.id.trim()}`;
}

export function normalizeHiddenModels(value: unknown): string[] {
    if (!Array.isArray(value)) return [];
    return [...new Set(value
        .filter((item): item is string => typeof item === "string")
        .map((item) => item.split("/").map((part) => part.trim()).join("/"))
        .filter((item) => item.includes("/") && !item.startsWith("/") && !item.endsWith("/")))]
        .sort();
}

export function getHiddenModels(): string[] {
    return normalizeHiddenModels(loadGlobalConfig().hiddenModels);
}

export function setHiddenModels(value: unknown): string[] {
    const hiddenModels = normalizeHiddenModels(value);
    saveGlobalConfig({ hiddenModels });
    return hiddenModels;
}

export function isModelHidden(model: ModelRef, hiddenModels = getHiddenModels()): boolean {
    return hiddenModels.includes(modelKey(model));
}

export function filterVisibleModels<T extends ModelRef>(models: T[], hiddenModels = getHiddenModels()): T[] {
    const hidden = new Set(hiddenModels);
    return models.filter((model) => !hidden.has(modelKey(model)));
}
