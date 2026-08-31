import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { applySettingsDefaultModel, flushPendingExtensionProviders, type DefaultModelSession } from "./apply-default-model.js";

function makeSession(overrides: Partial<{
    current: { provider: string; id: string } | undefined;
    defaultProvider: string | undefined;
    defaultModel: string | undefined;
    registryHas: boolean;
    hasAuth: boolean;
    messages: unknown[];
    legacyRegistry: boolean;
}> = {}) {
    const opts = {
        current: { provider: "openai", id: "gpt-5.5" },
        defaultProvider: "claude-subscription",
        defaultModel: "claude-fable-5",
        registryHas: true,
        hasAuth: true,
        messages: [],
        legacyRegistry: false,
        ...overrides,
    };
    const setCalls: unknown[] = [];
    // pi ≥0.84 exposes modelRuntime; pre-0.84 exposed modelRegistry. Support both.
    const registry = opts.legacyRegistry
        ? {
              find: (p: string, m: string) => (opts.registryHas ? { provider: p, id: m } : undefined),
              hasConfiguredAuth: () => opts.hasAuth,
          }
        : undefined;
    const runtime = opts.legacyRegistry
        ? undefined
        : {
              getModel: (p: string, m: string) => (opts.registryHas ? { provider: p, id: m } : undefined),
              hasConfiguredAuth: () => opts.hasAuth,
          };
    const session: DefaultModelSession = {
        model: opts.current,
        settingsManager: {
            getDefaultProvider: () => opts.defaultProvider,
            getDefaultModel: () => opts.defaultModel,
        },
        modelRuntime: runtime,
        modelRegistry: registry,
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

    describe("dynamic Ollama Cloud fallback", () => {
        const originalHome = process.env.HOME;
        let tempHome: string;

        beforeEach(() => {
            tempHome = mkdtempSync(join(tmpdir(), "apply-default-ollama-"));
            process.env.HOME = tempHome;
            const dir = join(tempHome, ".pizzapi");
            mkdirSync(dir, { recursive: true });
            writeFileSync(
                join(dir, "ollama-cloud-models-cache.json"),
                JSON.stringify({
                    models: [
                        {
                            id: "glm-5.2",
                            name: "glm-5.2",
                            provider: "ollama-cloud",
                            api: "openai-completions",
                            baseUrl: "https://ollama.com/v1",
                            reasoning: true,
                            input: ["text"],
                            contextWindow: 1000000,
                            maxTokens: 32768,
                        },
                    ],
                    fetchedAt: Date.now(),
                }),
            );
        });

        afterEach(() => {
            process.env.HOME = originalHome;
            try { rmSync(tempHome, { recursive: true, force: true }); } catch { /* ignore */ }
        });

        test("resolves an ollama-cloud default from the cache when registry misses", async () => {
            const { session, setCalls } = makeSession({
                defaultProvider: "ollama-cloud",
                defaultModel: "glm-5.2",
                registryHas: false,
                hasAuth: true,
            });
            expect(await applySettingsDefaultModel(session)).toBe(true);
            expect(setCalls).toHaveLength(1);
            expect((setCalls[0] as any).id).toBe("glm-5.2");
            expect((setCalls[0] as any).provider).toBe("ollama-cloud");
        });
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

    test("works against the legacy modelRegistry shape (pi <0.84)", async () => {
        const { session, setCalls } = makeSession({ legacyRegistry: true });
        expect(await applySettingsDefaultModel(session)).toBe(true);
        expect(setCalls).toEqual([{ provider: "claude-subscription", id: "claude-fable-5" }]);
    });

    test("no-op when neither registry accessor is present (instead of throwing)", async () => {
        const { session, setCalls } = makeSession();
        delete (session as any).modelRuntime;
        delete (session as any).modelRegistry;
        expect(await applySettingsDefaultModel(session)).toBe(false);
        expect(setCalls).toEqual([]);
    });
});

describe("flushPendingExtensionProviders", () => {
    function makeTargets(pending: { name: string; config: unknown; extensionPath: string }[], nativePending: { provider: unknown; extensionPath: string }[] = [], failFor: string[] = []) {
        const runtime = {
            pendingProviderRegistrations: pending,
            pendingNativeProviderRegistrations: nativePending,
        };
        const registered: string[] = [];
        const warnings: string[] = [];
        return {
            runtime,
            registered,
            warnings,
            targets: {
                loader: { getExtensions: () => ({ runtime }) },
                modelRuntime: {
                    registerProvider(name: string) {
                        if (failFor.includes(name)) throw new Error(`boom ${name}`);
                        registered.push(name);
                    },
                    registerNativeProvider(provider: unknown) {
                        registered.push(`native:${(provider as { name: string }).name}`);
                    },
                },
                warn: (m: string) => { warnings.push(m); },
            },
        };
    }

    test("registers queued providers into the runtime and clears the queues", () => {
        const { targets, runtime, registered } = makeTargets(
            [{ name: "claude-subscription", config: {}, extensionPath: "/ext/a" }],
            [{ provider: { name: "native-x" }, extensionPath: "/ext/b" }],
        );
        const count = flushPendingExtensionProviders(targets);
        expect(count).toBe(2);
        expect(registered).toEqual(["claude-subscription", "native:native-x"]);
        expect(runtime.pendingProviderRegistrations).toEqual([]);
        expect(runtime.pendingNativeProviderRegistrations).toEqual([]);
    });

    test("a failing registration warns but does not block the rest", () => {
        const { targets, registered, warnings } = makeTargets(
            [
                { name: "bad", config: {}, extensionPath: "/ext/bad" },
                { name: "good", config: {}, extensionPath: "/ext/good" },
            ],
            [],
            ["bad"],
        );
        const count = flushPendingExtensionProviders(targets);
        expect(count).toBe(1);
        expect(registered).toEqual(["good"]);
        expect(warnings.length).toBe(1);
        expect(warnings[0]).toContain("/ext/bad");
    });

    test("no-op when queues are empty", () => {
        const { targets } = makeTargets([]);
        expect(flushPendingExtensionProviders(targets)).toBe(0);
    });
});
