/**
 * Compatibility tests for @mariozechner/pi-ai and @mariozechner/pi-agent-core.
 *
 * Verifies that the APIs used by the server are still present and functional
 * after a pi package version bump. These tests act as an early warning if
 * upstream changes break our integration points.
 */
import { describe, test, expect } from "bun:test";

// ---------------------------------------------------------------------------
// 1. pi-ai exports used by server (packages/server/src/routes/api.ts)
// ---------------------------------------------------------------------------

describe("pi-ai API compatibility", () => {
    test("getModel is exported and callable", async () => {
        const { getModel } = await import("@mariozechner/pi-ai");
        expect(typeof getModel).toBe("function");
    });

    test("getProviders is exported and returns an array", async () => {
        const { getProviders } = await import("@mariozechner/pi-ai");
        expect(typeof getProviders).toBe("function");
        const providers = getProviders();
        expect(Array.isArray(providers)).toBe(true);
        expect(providers.length).toBeGreaterThan(0);
    });

    test("getModels is exported and returns models for a provider", async () => {
        const { getProviders, getModels } = await import("@mariozechner/pi-ai");
        expect(typeof getModels).toBe("function");

        const providers = getProviders();
        if (providers.length > 0) {
            const models = getModels(providers[0]);
            expect(Array.isArray(models)).toBe(true);
            // Each model should have id and name
            for (const m of models) {
                expect(typeof m.id).toBe("string");
                expect(typeof m.name).toBe("string");
            }
        }
    });

    test("Type schema builder is exported (used by tools)", async () => {
        const { Type } = await import("@mariozechner/pi-ai");
        expect(Type).toBeDefined();
        expect(typeof Type.Object).toBe("function");
        expect(typeof Type.String).toBe("function");
        expect(typeof Type.Boolean).toBe("function");
        expect(typeof Type.Optional).toBe("function");
    });

    test("getModel returns model with expected properties", async () => {
        const { getProviders, getModels, getModel } = await import("@mariozechner/pi-ai");
        const providers = getProviders();
        if (providers.length === 0) return;

        const models = getModels(providers[0]);
        if (models.length === 0) return;

        const model = getModel(providers[0], models[0].id);
        expect(model).toBeDefined();
        expect(typeof model.provider).toBe("string");
        expect(typeof model.id).toBe("string");
        expect(typeof model.name).toBe("string");
    });
});

// ---------------------------------------------------------------------------
// 2. pi-agent-core exports used by server
// ---------------------------------------------------------------------------

describe("pi-agent-core API compatibility", () => {
    test("Agent class is exported and constructable", async () => {
        const { Agent } = await import("@mariozechner/pi-agent-core");
        expect(typeof Agent).toBe("function");
        expect(Agent.prototype).toBeDefined();
    });

    test("Agent accepts initialState with systemPrompt, model, tools", async () => {
        const { Agent } = await import("@mariozechner/pi-agent-core");
        const { getProviders, getModels, getModel } = await import("@mariozechner/pi-ai");

        const providers = getProviders();
        if (providers.length === 0) return;

        const models = getModels(providers[0]);
        if (models.length === 0) return;

        const model = getModel(providers[0], models[0].id);

        // Constructing should not throw
        const agent = new Agent({
            initialState: {
                systemPrompt: "Test",
                model,
                tools: [],
            },
            getApiKey: async () => undefined,
        });

        expect(agent).toBeDefined();
        expect(typeof agent.subscribe).toBe("function");
        expect(typeof agent.prompt).toBe("function");
        expect(typeof agent.waitForIdle).toBe("function");
    });

    test("Agent subscribe returns unsubscribe function", async () => {
        const { Agent } = await import("@mariozechner/pi-agent-core");
        const { getProviders, getModels, getModel } = await import("@mariozechner/pi-ai");

        const providers = getProviders();
        if (providers.length === 0) return;

        const models = getModels(providers[0]);
        if (models.length === 0) return;

        const model = getModel(providers[0], models[0].id);

        const agent = new Agent({
            initialState: {
                systemPrompt: "Test",
                model,
                tools: [],
            },
            getApiKey: async () => undefined,
        });

        const unsubscribe = agent.subscribe(() => {});
        expect(typeof unsubscribe).toBe("function");
        unsubscribe();
    });
});
