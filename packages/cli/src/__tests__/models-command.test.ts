import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { _setGlobalConfigDir } from "../config/io.js";
import { runModelsCommand } from "../models-command.js";

const originalFetch = globalThis.fetch;
const originalHome = process.env.HOME;
const originalKey = process.env.OLLAMA_API_KEY;
const ENV_KEYS = [
    "PIZZAPI_HIDDEN_MODELS",
    "PIZZAPI_SESSION_PROVIDER",
    "PIZZAPI_WORKER_INITIAL_MODEL_PROVIDER",
    "PI_CODING_AGENT_DIR",
] as const;
const originalEnv = new Map(ENV_KEYS.map((key) => [key, process.env[key]]));

/**
 * Isolation notes (see daemon-list-configured-models.test.ts for the fuller
 * writeup): agentDir (auth.json/models.json) is pinned via a project-local
 * .pizzapi/config.json because Bun caches os.homedir() at process start, so
 * reassigning process.env.HOME alone does NOT redirect ModelRuntime's
 * default authPath/modelsPath. ollama-cloud-models.ts's own cache path DOES
 * honor process.env.HOME (it checks the env var explicitly), so HOME is
 * still set here, pointed at the same directory as agentDir.
 */
describe("models command", () => {
    let fetchCalls: Array<{ url: string; options?: RequestInit }> = [];
    let tmpDir: string;
    let projectDir: string;
    let home: string;
    let agentDir: string;

    async function runAndCaptureJson(cwd: string): Promise<{ code: number; models: any[] }> {
        const output: string[] = [];
        const logger = { debug: (message: string) => output.push(message), info: (message: string) => output.push(message), warn: (message: string) => output.push(message), error: (message: string) => output.push(message) };
        const code = await runModelsCommand(["--json"], cwd, logger);
        const captured = output.find((line) => line.startsWith("{")) ?? "{}";
        return { code, models: JSON.parse(captured).models ?? [] };
    }

    function mockFetch(overrides?: { modelsFails?: boolean }) {
        globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
            const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
            fetchCalls.push({ url, options: init });
            if (url === "https://ollama.com/v1/models") {
                if (overrides?.modelsFails) throw new Error("network unreachable");
                return new Response(JSON.stringify({ data: [{ id: "live-model" }] }), { status: 200, headers: { "content-type": "application/json" } });
            }
            if (url === "https://ollama.com/api/show") {
                return new Response(JSON.stringify({ capabilities: ["thinking"], model_info: { context_length: 12345 } }), { status: 200, headers: { "content-type": "application/json" } });
            }
            return new Response("not found", { status: 404 });
        }) as unknown as typeof fetch;
    }

    beforeEach(() => {
        fetchCalls = [];
        tmpDir = mkdtempSync(join(tmpdir(), "models-command-test-"));
        home = join(tmpDir, "home");
        agentDir = join(home, ".pizzapi");
        projectDir = join(tmpDir, "project");
        mkdirSync(join(projectDir, ".pizzapi"), { recursive: true });
        mkdirSync(agentDir, { recursive: true });
        writeFileSync(join(projectDir, ".pizzapi", "config.json"), JSON.stringify({ agentDir }));
        _setGlobalConfigDir(join(tmpDir, "global-unused"));
        process.env.HOME = home;
        delete process.env.OLLAMA_API_KEY;
        for (const key of ENV_KEYS) delete process.env[key];
        mockFetch();
    });

    afterEach(() => {
        globalThis.fetch = originalFetch;
        _setGlobalConfigDir(null);
        process.env.HOME = originalHome;
        if (originalKey === undefined) delete process.env.OLLAMA_API_KEY;
        else process.env.OLLAMA_API_KEY = originalKey;
        for (const key of ENV_KEYS) {
            const value = originalEnv.get(key);
            if (value === undefined) delete process.env[key];
            else process.env[key] = value;
        }
        rmSync(tmpDir, { recursive: true, force: true });
    });

    test("fetches live Ollama Cloud models when OLLAMA_API_KEY is set", async () => {
        process.env.OLLAMA_API_KEY = "test-key";
        const code = await runModelsCommand(["--json"], projectDir);
        expect(code).toBe(0);
        const ollamaCall = fetchCalls.find((c) => c.url === "https://ollama.com/v1/models");
        expect(ollamaCall).toBeDefined();
    });

    test("fetches live Ollama Cloud models for a stored credential (no env var)", async () => {
        writeFileSync(
            join(agentDir, "auth.json"),
            JSON.stringify({ "ollama-cloud": { type: "api_key", key: "stored-test-key" } }),
        );
        const code = await runModelsCommand(["--json"], projectDir);
        expect(code).toBe(0);
        const ollamaCall = fetchCalls.find((c) => c.url === "https://ollama.com/v1/models");
        expect(ollamaCall).toBeDefined();
    });

    test("does not attempt a live fetch or surface ollama-cloud models with no credentials configured", async () => {
        const { code, models } = await runAndCaptureJson(projectDir);
        expect(code).toBe(0);
        expect(fetchCalls.find((c) => c.url === "https://ollama.com/v1/models")).toBeUndefined();
        expect(models.some((m: any) => m.provider === "ollama-cloud")).toBe(false);
    });

    test("falls back to the static offline catalog when the live fetch fails", async () => {
        mockFetch({ modelsFails: true });
        process.env.OLLAMA_API_KEY = "test-key";
        const { code, models } = await runAndCaptureJson(projectDir);
        expect(code).toBe(0);
        // The live endpoint was attempted and failed, but the offline fallback
        // catalog (registered via registerOllamaCloudProvider) still shows up
        // because the provider has valid configured auth (the env var).
        expect(fetchCalls.some((c) => c.url === "https://ollama.com/v1/models")).toBe(true);
        expect(models.some((m: any) => m.provider === "ollama-cloud" && m.id === "glm-5.1")).toBe(true);
    });
});
