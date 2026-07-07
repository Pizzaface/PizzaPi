import { describe, test, expect } from "bun:test";
import { applySettingsDefaultModel, type DefaultModelSession } from "./apply-default-model.js";

function makeSession(overrides: Partial<{
    current: { provider: string; id: string } | undefined;
    defaultProvider: string | undefined;
    defaultModel: string | undefined;
    registryHas: boolean;
    hasAuth: boolean;
    messages: unknown[];
}> = {}) {
    const opts = {
        current: { provider: "openai", id: "gpt-5.5" },
        defaultProvider: "claude-subscription",
        defaultModel: "claude-fable-5",
        registryHas: true,
        hasAuth: true,
        messages: [],
        ...overrides,
    };
    const setCalls: unknown[] = [];
    const session: DefaultModelSession = {
        model: opts.current,
        settingsManager: {
            getDefaultProvider: () => opts.defaultProvider,
            getDefaultModel: () => opts.defaultModel,
        },
        modelRegistry: {
            find: (p, m) => (opts.registryHas ? { provider: p, id: m } : undefined),
            hasConfiguredAuth: () => opts.hasAuth,
        },
        agent: { state: { messages: opts.messages } },
        setModel: async (m) => { setCalls.push(m); },
    };
    return { session, setCalls };
}

describe("applySettingsDefaultModel", () => {
    test("switches to extension-registered default when it resolves post-load", async () => {
        const { session, setCalls } = makeSession();
        expect(await applySettingsDefaultModel(session)).toBe(true);
        expect(setCalls).toEqual([{ provider: "claude-subscription", id: "claude-fable-5" }]);
    });

    test("no-op when current model already matches the default", async () => {
        const { session, setCalls } = makeSession({
            current: { provider: "claude-subscription", id: "claude-fable-5" },
        });
        expect(await applySettingsDefaultModel(session)).toBe(false);
        expect(setCalls).toEqual([]);
    });

    test("no-op when no default is configured", async () => {
        const { session, setCalls } = makeSession({ defaultProvider: undefined });
        expect(await applySettingsDefaultModel(session)).toBe(false);
        expect(setCalls).toEqual([]);
    });

    test("no-op when default still doesn't resolve in the registry", async () => {
        const { session, setCalls } = makeSession({ registryHas: false });
        expect(await applySettingsDefaultModel(session)).toBe(false);
        expect(setCalls).toEqual([]);
    });

    test("no-op when default resolves but has no configured auth", async () => {
        const { session, setCalls } = makeSession({ hasAuth: false });
        expect(await applySettingsDefaultModel(session)).toBe(false);
        expect(setCalls).toEqual([]);
    });

    test("no-op for sessions with restored messages (resume keeps its model)", async () => {
        const { session, setCalls } = makeSession({ messages: [{ role: "user" }] });
        expect(await applySettingsDefaultModel(session)).toBe(false);
        expect(setCalls).toEqual([]);
    });
});
