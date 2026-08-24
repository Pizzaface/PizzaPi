import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSessionExtension } from "./spawn-session.js";
import type { OllamaCloudModel } from "../ollama-cloud-models.js";

// list_models must surface dynamically-discovered Ollama Cloud models (cached
// on disk, never in the static ModelRegistry) alongside the disk registry's
// static models. See ollama-cloud-models.ts for why they're separate.

const originalHome = process.env.HOME;
const originalKey = process.env.OLLAMA_API_KEY;

function createMockPi() {
    const tools = new Map<string, any>();
    return {
        tools,
        registerTool(tool: any) {
            tools.set(tool.name, tool);
        },
        on: () => {},
        registerCommand: () => {},
    };
}

function fakeDiskModel(id: string) {
    return { provider: "anthropic", id, name: id, reasoning: false, contextWindow: 200000, maxTokens: 8192 };
}

function fakeCtx(hasOllamaAuth: boolean) {
    return {
        modelRegistry: {
            getAll: () => [fakeDiskModel("claude-x")],
            getAvailable: () => [fakeDiskModel("claude-x")],
            getProviderAuthStatus: (provider: string) => ({ configured: hasOllamaAuth && provider === "ollama-cloud" }),
        },
    } as any;
}

describe("list_models tool — Ollama Cloud merge", () => {
    let tempHome: string;

    beforeEach(() => {
        tempHome = mkdtempSync(join(tmpdir(), "list-models-test-"));
        process.env.HOME = tempHome;
        delete process.env.OLLAMA_API_KEY;
        delete process.env.PIZZAPI_HIDDEN_MODELS;

        const dir = join(tempHome, ".pizzapi");
        mkdirSync(dir, { recursive: true });
        const cached: OllamaCloudModel[] = [
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
        ];
        writeFileSync(join(dir, "ollama-cloud-models-cache.json"), JSON.stringify({ models: cached, fetchedAt: Date.now() }));
    });

    afterEach(() => {
        process.env.HOME = originalHome;
        if (originalKey === undefined) delete process.env.OLLAMA_API_KEY;
        else process.env.OLLAMA_API_KEY = originalKey;
        delete process.env.PIZZAPI_HIDDEN_MODELS;
        try {
            rmSync(tempHome, { recursive: true, force: true });
        } catch {
            // ignore
        }
    });

    test("includes cached Ollama Cloud models when credentials are configured", async () => {
        const pi = createMockPi();
        spawnSessionExtension(pi as any);
        const tool = pi.tools.get("list_models");

        const result = await tool.execute("call-1", {}, undefined, undefined, fakeCtx(true));
        const ids = (result.details.models as any[]).map((m) => `${m.provider}/${m.id}`);

        expect(ids).toContain("ollama-cloud/glm-5.2");
        expect(ids).toContain("anthropic/claude-x");
    });

    test("omits Ollama Cloud models when no credentials are configured", async () => {
        const pi = createMockPi();
        spawnSessionExtension(pi as any);
        const tool = pi.tools.get("list_models");

        const result = await tool.execute("call-1", {}, undefined, undefined, fakeCtx(false));
        const ids = (result.details.models as any[]).map((m) => `${m.provider}/${m.id}`);

        expect(ids).not.toContain("ollama-cloud/glm-5.2");
        expect(ids).toContain("anthropic/claude-x");
    });
});

// ── spawn_session tool — autoClose plumbing ────────────────────────────────
// Completed children must self-terminate (auto-close) instead of idling on
// the runner forever. Default is true; explicit false opts out.

describe("spawn_session tool — autoClose", () => {
    const saved = {
        RELAY: process.env.PIZZAPI_RELAY_URL,
        KEY: process.env.PIZZAPI_API_KEY,
        SESSION: process.env.PIZZAPI_SESSION_ID,
        fetch: globalThis.fetch,
    };

    afterEach(() => {
        if (saved.RELAY !== undefined) process.env.PIZZAPI_RELAY_URL = saved.RELAY; else delete process.env.PIZZAPI_RELAY_URL;
        if (saved.KEY !== undefined) process.env.PIZZAPI_API_KEY = saved.KEY; else delete process.env.PIZZAPI_API_KEY;
        if (saved.SESSION !== undefined) process.env.PIZZAPI_SESSION_ID = saved.SESSION; else delete process.env.PIZZAPI_SESSION_ID;
        globalThis.fetch = saved.fetch;
    });

    function setup() {
        process.env.PIZZAPI_RELAY_URL = "http://relay.test";
        process.env.PIZZAPI_API_KEY = "test-key";
        process.env.PIZZAPI_SESSION_ID = "parent-session";

        const bodies: any[] = [];
        globalThis.fetch = (async (_url: any, init: any) => {
            bodies.push(JSON.parse(init.body));
            return new Response(JSON.stringify({ ok: true, sessionId: "child-1" }), { status: 200 });
        }) as any;

        const pi = createMockPi();
        spawnSessionExtension(pi as any);
        return { tool: pi.tools.get("spawn_session"), bodies };
    }

    test("defaults autoClose to true in the spawn request body", async () => {
        const { tool, bodies } = setup();
        await tool.execute("call-1", { prompt: "do things", runnerId: "r1" });
        expect(bodies[0].autoClose).toBe(true);
    });

    test("passes autoClose: false through when explicitly disabled", async () => {
        const { tool, bodies } = setup();
        await tool.execute("call-1", { prompt: "stay up", runnerId: "r1", autoClose: false });
        expect(bodies[0].autoClose).toBe(false);
    });
});
