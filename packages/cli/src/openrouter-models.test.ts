import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
    fetchOpenRouterModels,
    getCachedOpenRouterModels,
    openrouterDynamicProvider,
    registerOpenRouterProvider,
    toOpenRouterModel,
} from "./openrouter-models.js";

const API_ENTRY = {
    id: "anthropic/claude-sonnet-4.5",
    name: "Anthropic: Claude Sonnet 4.5",
    context_length: 1000000,
    architecture: { input_modalities: ["text", "image", "file"] },
    pricing: { prompt: "0.000003", completion: "0.000015", input_cache_read: "0.0000003", input_cache_write: "0.00000375" },
    top_provider: { context_length: 1000000, max_completion_tokens: 64000 },
    supported_parameters: ["tools", "reasoning", "temperature"],
};

const homes: string[] = [];
function tempHome(): string {
    const home = mkdtempSync(join(tmpdir(), "pizzapi-openrouter-"));
    homes.push(home);
    return home;
}

const realFetch = globalThis.fetch;
afterEach(() => {
    globalThis.fetch = realFetch;
    for (const home of homes.splice(0)) rmSync(home, { recursive: true, force: true });
});

function stubFetch(body: unknown, ok = true): void {
    globalThis.fetch = (async () =>
        ({ ok, status: ok ? 200 : 500, statusText: ok ? "OK" : "Server Error", json: async () => body }) as any) as any;
}

describe("toOpenRouterModel", () => {
    test("maps the live API entry into a pi model", () => {
        const model = toOpenRouterModel(API_ENTRY)!;
        expect(model.id).toBe("anthropic/claude-sonnet-4.5");
        expect(model.provider).toBe("openrouter");
        expect(model.api).toBe("openai-completions");
        expect(model.baseUrl).toBe("https://openrouter.ai/api/v1");
        expect(model.reasoning).toBe(true);
        expect(model.input).toEqual(["text", "image"]);
        expect(model.contextWindow).toBe(1000000);
        expect(model.maxTokens).toBe(64000);
        // per-token strings become per-million-token costs
        expect(model.cost).toEqual({ input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 });
        expect((model.compat as any).thinkingFormat).toBe("openrouter");
    });

    test("drops models without tool calling", () => {
        expect(toOpenRouterModel({ ...API_ENTRY, supported_parameters: ["temperature"] })).toBeNull();
        expect(toOpenRouterModel({ ...API_ENTRY, id: undefined })).toBeNull();
    });

    test("falls back when optional fields are missing", () => {
        const model = toOpenRouterModel({ id: "vendor/model", supported_parameters: ["tools"] })!;
        expect(model.name).toBe("vendor/model");
        expect(model.reasoning).toBe(false);
        expect(model.input).toEqual(["text"]);
        expect(model.contextWindow).toBe(128000);
        expect(model.maxTokens).toBe(32768);
        expect(model.cost).toEqual({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0 });
    });
});

describe("fetchOpenRouterModels", () => {
    test("fetches, filters, and caches", async () => {
        const home = tempHome();
        stubFetch({ data: [API_ENTRY, { ...API_ENTRY, id: "no/tools", supported_parameters: [] }] });

        const models = await fetchOpenRouterModels({ home });
        expect(models.map((m) => m.id)).toEqual(["anthropic/claude-sonnet-4.5"]);

        const cached = JSON.parse(readFileSync(join(home, ".pizzapi", "openrouter-models-cache.json"), "utf-8"));
        expect(cached.models).toHaveLength(1);
        expect(typeof cached.fetchedAt).toBe("number");
        expect(getCachedOpenRouterModels(home)).toHaveLength(1);
    });

    test("serves a fresh cache without hitting the network", async () => {
        const home = tempHome();
        stubFetch({ data: [API_ENTRY] });
        await fetchOpenRouterModels({ home });

        globalThis.fetch = (async () => {
            throw new Error("should not fetch");
        }) as any;
        expect(await fetchOpenRouterModels({ home })).toHaveLength(1);
    });

    test("refetches when the cache is stale", async () => {
        const home = tempHome();
        mkdirSync(join(home, ".pizzapi"), { recursive: true });
        writeFileSync(
            join(home, ".pizzapi", "openrouter-models-cache.json"),
            JSON.stringify({ models: [toOpenRouterModel(API_ENTRY)], fetchedAt: Date.now() - 25 * 60 * 60 * 1000 }),
        );
        stubFetch({ data: [API_ENTRY, { ...API_ENTRY, id: "vendor/new" }] });

        expect(await fetchOpenRouterModels({ home })).toHaveLength(2);
    });

    test("throws on API failure and on an empty catalog, leaving the cache untouched", async () => {
        const home = tempHome();
        stubFetch({ data: [API_ENTRY] });
        await fetchOpenRouterModels({ home });

        stubFetch(null, false);
        await expect(fetchOpenRouterModels({ home, force: true })).rejects.toThrow(/OpenRouter models API error/);

        stubFetch({ data: [] });
        await expect(fetchOpenRouterModels({ home, force: true })).rejects.toThrow(/no usable models/);
        expect(getCachedOpenRouterModels(home)).toHaveLength(1);
    });

    test("ignores a corrupt cache", () => {
        const home = tempHome();
        mkdirSync(join(home, ".pizzapi"), { recursive: true });
        writeFileSync(join(home, ".pizzapi", "openrouter-models-cache.json"), "{not json");
        expect(getCachedOpenRouterModels(home)).toBeNull();
    });
});

describe("openrouterDynamicProvider", () => {
    test("uses the live catalog when cached and the static one otherwise", async () => {
        const home = tempHome();
        const staticModels = openrouterDynamicProvider(home).getModels();
        expect(staticModels.length).toBeGreaterThan(0);

        stubFetch({ data: [API_ENTRY] });
        await fetchOpenRouterModels({ home });

        const live = openrouterDynamicProvider(home).getModels();
        expect(live.map((m) => m.id)).toEqual(["anthropic/claude-sonnet-4.5"]);
        // pi-ai's auth/stream behaviour is preserved
        expect(openrouterDynamicProvider(home).auth.apiKey).toBeDefined();
    });

    test("registers through either runtime or extension API shape", () => {
        const home = tempHome();
        const native: unknown[] = [];
        registerOpenRouterProvider({ registerNativeProvider: (p) => native.push(p) }, home);
        expect((native[0] as any).id).toBe("openrouter");

        const viaExtension: unknown[] = [];
        registerOpenRouterProvider({ registerProvider: (p) => viaExtension.push(p) }, home);
        expect((viaExtension[0] as any).id).toBe("openrouter");

        expect(() => registerOpenRouterProvider({}, home)).toThrow(/no provider registration method/);
    });
});

describe("sentinel pricing", () => {
    test("OpenRouter's -1 'price varies per request' sentinel becomes 0, not a negative rate", () => {
        const model = toOpenRouterModel({
            ...API_ENTRY,
            id: "openrouter/auto",
            pricing: { prompt: "-1", completion: "-1" },
        } as any);
        expect(model?.cost).toEqual({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0 });
    });
});
