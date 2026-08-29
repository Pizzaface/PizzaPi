import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { clampThinkingLevel, getSupportedThinkingLevels } from "@earendil-works/pi-ai";
import { nvidiaProvider } from "@earendil-works/pi-ai/providers/nvidia";
import {
    fetchNvidiaModels,
    getCachedNvidiaModels,
    nvidiaDynamicProvider,
    registerNvidiaProvider,
    toNvidiaModel,
} from "./nvidia-models.js";

const STATIC = nvidiaProvider().getModels() as any[];
const KNOWN_ID = STATIC[0].id as string;

const homes: string[] = [];
function tempHome(): string {
    const home = mkdtempSync(join(tmpdir(), "pizzapi-nvidia-"));
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

describe("toNvidiaModel", () => {
    test("reuses pi-ai's curated metadata for a known id", () => {
        const known = STATIC.find((m) => m.id === KNOWN_ID)!;
        const model = toNvidiaModel({ id: KNOWN_ID }, STATIC as any)!;
        expect(model.name).toBe(known.name);
        expect(model.contextWindow).toBe(known.contextWindow);
        expect(model.cost).toEqual(known.cost);
        expect(model.input).toEqual(known.input);
    });

    test("synthesizes defaults for ids the package has never seen", () => {
        const model = toNvidiaModel({ id: "moonshotai/kimi-k3" }, STATIC as any)!;
        expect(model.provider).toBe("nvidia");
        expect(model.api).toBe("openai-completions");
        expect(model.baseUrl).toBe("https://integrate.api.nvidia.com/v1");
        expect(model.name).toBe("moonshotai/kimi-k3");
        expect(model.input).toEqual(["text"]);
        expect(model.contextWindow).toBe(128000);
        expect(model.maxTokens).toBe(4096);
        expect(model.cost).toEqual({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0 });
        expect((model.headers as any)["NVCF-POLL-SECONDS"]).toBe("3600");
        expect((model.compat as any).maxTokensField).toBe("max_tokens");
    });

    test("unknown ids are reasoning-capable so the thinking control is usable", () => {
        const model = toNvidiaModel({ id: "moonshotai/kimi-k3" }, STATIC as any)!;
        expect(model.reasoning).toBe(true);
        expect((model.compat as any).supportsReasoningEffort).toBe(true);
        // NVIDIA rejects "minimal" and has no xhigh/max equivalent.
        expect(getSupportedThinkingLevels(model)).toEqual(["off", "low", "medium", "high"]);
        // Levels pi can request land on values NVIDIA's API accepts.
        expect(clampThinkingLevel(model, "minimal")).toBe("low");
        expect(clampThinkingLevel(model, "xhigh")).toBe("high");
        expect(clampThinkingLevel(model, "medium")).toBe("medium");
    });

    test("NVIDIA's accepted levels win over an upstream thinkingLevelMap", () => {
        const upstream = [{ ...(STATIC.find((m) => m.reasoning) as any), thinkingLevelMap: { minimal: "minimal", max: "max" } }];
        const model = toNvidiaModel({ id: upstream[0].id }, upstream as any)!;
        expect(getSupportedThinkingLevels(model)).toEqual(["off", "low", "medium", "high"]);
    });

    test("enables reasoning effort on curated reasoning models too", () => {
        const reasoner = STATIC.find((m) => m.reasoning)!;
        expect((reasoner.compat as any).supportsReasoningEffort).toBe(false); // pi-ai's default
        const model = toNvidiaModel({ id: reasoner.id }, STATIC as any)!;
        expect((model.compat as any).supportsReasoningEffort).toBe(true);
        expect(getSupportedThinkingLevels(model)).toEqual(["off", "low", "medium", "high"]);
    });

    test("leaves non-reasoning curated models alone", () => {
        const plain = STATIC.find((m) => !m.reasoning)!;
        const model = toNvidiaModel({ id: plain.id }, STATIC as any)!;
        expect(model.reasoning).toBe(false);
        expect((model.compat as any).supportsReasoningEffort).toBe(false);
        expect(getSupportedThinkingLevels(model)).toEqual(["off"]);
    });

    test("drops non-chat endpoints and malformed entries", () => {
        for (const id of [
            "nvidia/embed-qa-4",
            "snowflake/arctic-embed-l",
            "nvidia/llama-3.2-nemoretriever-1b-vlm-embed-v1",
            "nvidia/nvclip",
            "nvidia/nemotron-4-340b-reward",
            "meta/llama-guard-4-12b",
            "nvidia/nemotron-3.5-content-safety",
            "nvidia/nemotron-parse",
            "nvidia/ai-synthetic-video-detector",
            "google/deplot",
            "microsoft/kosmos-2",
            "adept/fuyu-8b",
            "nvidia/neva-22b",
            "nvidia/vila",
        ]) {
            expect(toNvidiaModel({ id }, STATIC as any)).toBeNull();
        }
        expect(toNvidiaModel({ id: undefined }, STATIC as any)).toBeNull();
        expect(toNvidiaModel({ id: "" }, STATIC as any)).toBeNull();
    });
});

describe("fetchNvidiaModels", () => {
    test("unions the live list over the package catalog, drops non-chat, and caches", async () => {
        const home = tempHome();
        stubFetch({ data: [{ id: KNOWN_ID }, { id: "vendor/new-model" }, { id: "nvidia/embed-qa-4" }] });

        const models = await fetchNvidiaModels({ home });
        // Package models the live list omits survive; new ids are appended once.
        expect(models).toHaveLength(STATIC.length + 1);
        expect(models.filter((m) => m.id === KNOWN_ID)).toHaveLength(1);
        expect(models.at(-1)!.id).toBe("vendor/new-model");
        expect(models.some((m) => m.id === "nvidia/embed-qa-4")).toBe(false);

        const cached = JSON.parse(readFileSync(join(home, ".pizzapi", "nvidia-models-cache.json"), "utf-8"));
        expect(cached.models).toHaveLength(STATIC.length + 1);
        expect(typeof cached.fetchedAt).toBe("number");
        expect(getCachedNvidiaModels(home)).toHaveLength(STATIC.length + 1);
    });

    test("serves a fresh cache without hitting the network", async () => {
        const home = tempHome();
        stubFetch({ data: [{ id: KNOWN_ID }] });
        await fetchNvidiaModels({ home });

        globalThis.fetch = (async () => {
            throw new Error("should not fetch");
        }) as any;
        expect(await fetchNvidiaModels({ home })).toHaveLength(STATIC.length);
    });

    test("refetches when the cache is stale", async () => {
        const home = tempHome();
        mkdirSync(join(home, ".pizzapi"), { recursive: true });
        writeFileSync(
            join(home, ".pizzapi", "nvidia-models-cache.json"),
            JSON.stringify({
                models: [toNvidiaModel({ id: KNOWN_ID }, STATIC as any)],
                fetchedAt: Date.now() - 25 * 60 * 60 * 1000,
            }),
        );
        stubFetch({ data: [{ id: KNOWN_ID }, { id: "vendor/new-model" }] });

        expect(await fetchNvidiaModels({ home })).toHaveLength(STATIC.length + 1);
    });

    test("throws on API failure and on an empty catalog, leaving the cache untouched", async () => {
        const home = tempHome();
        stubFetch({ data: [{ id: KNOWN_ID }] });
        await fetchNvidiaModels({ home });

        stubFetch(null, false);
        await expect(fetchNvidiaModels({ home, force: true })).rejects.toThrow(/NVIDIA models API error/);

        stubFetch({ data: [{ id: "nvidia/embed-qa-4" }] });
        await expect(fetchNvidiaModels({ home, force: true })).rejects.toThrow(/no usable models/);

        stubFetch({ notData: true });
        await expect(fetchNvidiaModels({ home, force: true })).rejects.toThrow(/Unexpected response/);

        expect(getCachedNvidiaModels(home)).toHaveLength(STATIC.length);
    });

    test("repairs a cache written before the thinking-effort fix", () => {
        const home = tempHome();
        mkdirSync(join(home, ".pizzapi"), { recursive: true });
        const stale = {
            ...(toNvidiaModel({ id: "moonshotai/kimi-k3" }, STATIC as any) as any),
            compat: { maxTokensField: "max_tokens", supportsReasoningEffort: false },
            thinkingLevelMap: { minimal: "minimal" }, // a 400 on NVIDIA's API
        };
        writeFileSync(
            join(home, ".pizzapi", "nvidia-models-cache.json"),
            JSON.stringify({ models: [stale], fetchedAt: Date.now() }),
        );

        const repaired = getCachedNvidiaModels(home)![0];
        expect((repaired.compat as any).supportsReasoningEffort).toBe(true);
        expect(getSupportedThinkingLevels(repaired)).toEqual(["off", "low", "medium", "high"]);
    });

    test("ignores a corrupt cache", () => {
        const home = tempHome();
        mkdirSync(join(home, ".pizzapi"), { recursive: true });
        writeFileSync(join(home, ".pizzapi", "nvidia-models-cache.json"), "{not json");
        expect(getCachedNvidiaModels(home)).toBeNull();
    });
});

describe("nvidiaDynamicProvider", () => {
    test("uses the live catalog when cached and the static one otherwise", async () => {
        const home = tempHome();
        expect(nvidiaDynamicProvider(home).getModels().length).toBe(STATIC.length);

        // The static fallback still gets the reasoning-effort fix.
        const staticReasoner = nvidiaDynamicProvider(home)
            .getModels()
            .find((m) => m.reasoning)!;
        expect((staticReasoner.compat as any).supportsReasoningEffort).toBe(true);

        stubFetch({ data: [{ id: "vendor/new-model" }] });
        await fetchNvidiaModels({ home });

        expect(nvidiaDynamicProvider(home).getModels().map((m) => m.id)).toContain("vendor/new-model");
        expect(nvidiaDynamicProvider(home).getModels()).toHaveLength(STATIC.length + 1);
        // pi-ai's auth/stream behaviour is preserved
        expect(nvidiaDynamicProvider(home).auth.apiKey).toBeDefined();
    });

    test("registers through either runtime or extension API shape", () => {
        const home = tempHome();
        const native: unknown[] = [];
        registerNvidiaProvider({ registerNativeProvider: (p) => native.push(p) }, home);
        expect((native[0] as any).id).toBe("nvidia");

        const viaExtension: unknown[] = [];
        registerNvidiaProvider({ registerProvider: (p) => viaExtension.push(p) }, home);
        expect((viaExtension[0] as any).id).toBe("nvidia");

        expect(() => registerNvidiaProvider({}, home)).toThrow(/no provider registration method/);
    });
});
