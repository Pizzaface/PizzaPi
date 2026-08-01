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
