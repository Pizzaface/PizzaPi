import { describe, test, expect, beforeAll, afterAll, afterEach } from "bun:test";
import { mkdtempSync, rmSync, readFileSync, writeFileSync, mkdirSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";

import {
    fetchOpenAIModels,
    fetchAnthropicModels,
    type DiscoveredModel,
} from "./model-discovery-providers.js";

import {
    discoverNewModels,
    readCache,
    writeCache,
    CACHE_TTL_MS,
    type DiscoveryCache,
} from "./model-discovery.js";

// ── OpenAI provider tests ────────────────────────────────────────────────────

describe("fetchOpenAIModels", () => {
    let server: ReturnType<typeof Bun.serve>;

    afterEach(() => {
        server?.stop(true);
    });

    test("parses valid response and returns model list", async () => {
        server = Bun.serve({
            port: 0,
            fetch() {
                return Response.json({
                    data: [
                        { id: "gpt-5.4", owned_by: "openai", created: 1700000000 },
                        { id: "gpt-5.3-codex", owned_by: "system", created: 1699000000 },
                    ],
                });
            },
        });

        const models = await fetchOpenAIModels(`http://localhost:${server.port}`, "test-key");
        expect(models).toHaveLength(2);
        expect(models[0]).toEqual({ id: "gpt-5.4", name: "gpt-5.4" });
        expect(models[1]).toEqual({ id: "gpt-5.3-codex", name: "gpt-5.3-codex" });
    });

    test("filters to openai/system owned models only", async () => {
        server = Bun.serve({
            port: 0,
            fetch() {
                return Response.json({
                    data: [
                        { id: "gpt-5.4", owned_by: "openai", created: 1700000000 },
                        { id: "ft:gpt-4:my-org:custom:abc123", owned_by: "user-abc", created: 1699000000 },
                        { id: "text-embedding-3-small", owned_by: "system", created: 1698000000 },
                    ],
                });
            },
        });

        const models = await fetchOpenAIModels(`http://localhost:${server.port}`, "test-key");
        expect(models).toHaveLength(2);
        expect(models.map((m) => m.id)).toEqual(["gpt-5.4", "text-embedding-3-small"]);
    });

    test("returns empty array on HTTP error", async () => {
        server = Bun.serve({
            port: 0,
            fetch() {
                return new Response("Unauthorized", { status: 401 });
            },
        });

        const models = await fetchOpenAIModels(`http://localhost:${server.port}`, "bad-key");
        expect(models).toEqual([]);
    });

    test("returns empty array on malformed JSON", async () => {
        server = Bun.serve({
            port: 0,
            fetch() {
                return new Response("not json", { headers: { "content-type": "application/json" } });
            },
        });

        const models = await fetchOpenAIModels(`http://localhost:${server.port}`, "test-key");
        expect(models).toEqual([]);
    });
});

// ── Anthropic provider tests ─────────────────────────────────────────────────

describe("fetchAnthropicModels", () => {
    let server: ReturnType<typeof Bun.serve>;

    afterEach(() => {
        server?.stop(true);
    });

    test("parses valid response with display_name", async () => {
        server = Bun.serve({
            port: 0,
            fetch() {
                return Response.json({
                    data: [
                        { id: "claude-opus-4-6", display_name: "Claude Opus 4.6", type: "model" },
                        { id: "claude-sonnet-4-6", display_name: "Claude Sonnet 4.6", type: "model" },
                    ],
                });
            },
        });

        const models = await fetchAnthropicModels(`http://localhost:${server.port}`, "test-key");
        expect(models).toHaveLength(2);
        expect(models[0]).toEqual({ id: "claude-opus-4-6", name: "Claude Opus 4.6" });
        expect(models[1]).toEqual({ id: "claude-sonnet-4-6", name: "Claude Sonnet 4.6" });
    });

    test("falls back to id when display_name is missing", async () => {
        server = Bun.serve({
            port: 0,
            fetch() {
                return Response.json({
                    data: [{ id: "claude-test-model", type: "model" }],
                });
            },
        });

        const models = await fetchAnthropicModels(`http://localhost:${server.port}`, "test-key");
        expect(models).toHaveLength(1);
        expect(models[0]).toEqual({ id: "claude-test-model", name: "claude-test-model" });
    });

    test("returns empty array on HTTP error", async () => {
        server = Bun.serve({
            port: 0,
            fetch() {
                return new Response("Forbidden", { status: 403 });
            },
        });

        const models = await fetchAnthropicModels(`http://localhost:${server.port}`, "bad-key");
        expect(models).toEqual([]);
    });
});

// ── Cache tests ──────────────────────────────────────────────────────────────

describe("cache", () => {
    let cacheDir: string;

    beforeAll(() => {
        cacheDir = mkdtempSync(join(tmpdir(), "pizzapi-discovery-test-"));
    });

    afterAll(() => {
        try { rmSync(cacheDir, { recursive: true, force: true }); } catch {}
    });

    test("readCache returns null for missing file", () => {
        const result = readCache(join(cacheDir, "nonexistent.json"));
        expect(result).toBeNull();
    });

    test("writeCache and readCache round-trip", () => {
        const cachePath = join(cacheDir, "test-cache.json");
        const cache: DiscoveryCache = {
            timestamp: Date.now(),
            providers: {
                openai: [{ id: "gpt-5.4", name: "gpt-5.4" }],
            },
        };
        writeCache(cachePath, cache);
        const loaded = readCache(cachePath);
        expect(loaded).toEqual(cache);
    });

    test("readCache returns null for expired cache", () => {
        const cachePath = join(cacheDir, "expired-cache.json");
        const cache: DiscoveryCache = {
            timestamp: Date.now() - CACHE_TTL_MS - 1000,
            providers: { openai: [] },
        };
        writeFileSync(cachePath, JSON.stringify(cache));
        const loaded = readCache(cachePath);
        expect(loaded).toBeNull();
    });

    test("readCache returns null for malformed JSON", () => {
        const cachePath = join(cacheDir, "bad-cache.json");
        writeFileSync(cachePath, "not valid json {{{");
        const loaded = readCache(cachePath);
        expect(loaded).toBeNull();
    });
});

// ── Discovery orchestration tests ────────────────────────────────────────────

describe("discoverNewModels", () => {
    let openaiServer: ReturnType<typeof Bun.serve>;
    let anthropicServer: ReturnType<typeof Bun.serve>;

    afterEach(() => {
        openaiServer?.stop(true);
        anthropicServer?.stop(true);
    });

    test("discovers new models not in registry", async () => {
        openaiServer = Bun.serve({
            port: 0,
            fetch() {
                return Response.json({
                    data: [
                        { id: "gpt-5.4", owned_by: "openai", created: 1700000000 },
                        { id: "gpt-5", owned_by: "openai", created: 1699000000 },
                    ],
                });
            },
        });

        const existingIds = new Set(["gpt-5"]);
        const result = await discoverNewModels({
            provider: "openai",
            baseUrl: `http://localhost:${openaiServer.port}`,
            apiKey: "test-key",
            existingModelIds: existingIds,
        });

        expect(result).toHaveLength(1);
        expect(result[0].id).toBe("gpt-5.4");
    });

    test("returns empty when all models already known", async () => {
        openaiServer = Bun.serve({
            port: 0,
            fetch() {
                return Response.json({
                    data: [{ id: "gpt-5", owned_by: "openai", created: 1700000000 }],
                });
            },
        });

        const existingIds = new Set(["gpt-5"]);
        const result = await discoverNewModels({
            provider: "openai",
            baseUrl: `http://localhost:${openaiServer.port}`,
            apiKey: "test-key",
            existingModelIds: existingIds,
        });

        expect(result).toHaveLength(0);
    });

    test("handles fetch failure without crashing", async () => {
        const result = await discoverNewModels({
            provider: "openai",
            baseUrl: "http://localhost:1",
            apiKey: "test-key",
            existingModelIds: new Set(),
        });

        expect(result).toEqual([]);
    });

    test("discovers anthropic models", async () => {
        anthropicServer = Bun.serve({
            port: 0,
            fetch() {
                return Response.json({
                    data: [
                        { id: "claude-new-model", display_name: "Claude New", type: "model" },
                    ],
                });
            },
        });

        const result = await discoverNewModels({
            provider: "anthropic",
            baseUrl: `http://localhost:${anthropicServer.port}`,
            apiKey: "test-key",
            existingModelIds: new Set(),
        });

        expect(result).toHaveLength(1);
        expect(result[0]).toEqual({ id: "claude-new-model", name: "Claude New" });
    });

    test("returns empty for unknown provider", async () => {
        const result = await discoverNewModels({
            provider: "unknown-provider",
            baseUrl: "http://localhost:1",
            apiKey: "test-key",
            existingModelIds: new Set(),
        });

        expect(result).toEqual([]);
    });
});
