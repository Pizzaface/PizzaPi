import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runModelsCommand } from "../models-command.js";

const originalFetch = globalThis.fetch;
const originalHome = process.env.HOME;

describe("models command", () => {
    let fetchCalls: Array<{ url: string; options?: RequestInit }> = [];
    let tempHome: string;

    beforeEach(() => {
        fetchCalls = [];
        tempHome = mkdtempSync(join(tmpdir(), "models-command-test-"));
        process.env.HOME = tempHome;
        globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
            const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
            fetchCalls.push({ url, options: init });
            if (url === "https://ollama.com/v1/models") {
                return new Response(JSON.stringify({ data: [{ id: "live-model" }] }), { status: 200, headers: { "content-type": "application/json" } });
            }
            if (url === "https://ollama.com/api/show") {
                return new Response(JSON.stringify({ capabilities: ["thinking"], model_info: { context_length: 12345 } }), { status: 200, headers: { "content-type": "application/json" } });
            }
            return new Response("not found", { status: 404 });
        }) as unknown as typeof fetch;
    });

    afterEach(() => {
        globalThis.fetch = originalFetch;
        process.env.HOME = originalHome;
        delete process.env.OLLAMA_API_KEY;
        try {
            rmSync(tempHome, { recursive: true, force: true });
        } catch {
            // ignore
        }
    });

    test("fetches live Ollama Cloud models when OLLAMA_API_KEY is set", async () => {
        process.env.OLLAMA_API_KEY = "test-key";
        const code = await runModelsCommand(["--json"], process.cwd());
        expect(code).toBe(0);
        const ollamaCall = fetchCalls.find((c) => c.url === "https://ollama.com/v1/models");
        expect(ollamaCall).toBeDefined();
    });
});
