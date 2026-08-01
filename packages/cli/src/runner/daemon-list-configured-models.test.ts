import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { _setGlobalConfigDir } from "../config.js";
import { listConfiguredModels } from "./daemon.js";

/**
 * listConfiguredModels() (used by the daemon's `list_models` socket event and
 * context-window lookups) builds a bare ModelRuntime with no extension
 * loading. Regression coverage for the P1 fix: without an explicit
 * registerOllamaCloudProvider() call, this runtime never learns
 * "ollama-cloud" is a provider at all, so env/stored credentials go
 * unrecognized and the offline fallback catalog never surfaces.
 *
 * Isolation notes:
 *  - agentDir (auth.json/models.json) is pinned via a project-local
 *    .pizzapi/config.json rather than the HOME env var, because Bun caches
 *    os.homedir() at process start (see _setGlobalConfigDir's doc comment in
 *    config/io.ts and its use in config-show.test.ts).
 *  - ollama-cloud-models.ts's own cache path DOES honor process.env.HOME
 *    (it checks the env var explicitly rather than relying on os.homedir()),
 *    so HOME is still set here and points at the same directory as agentDir.
 */
describe("daemon listConfiguredModels — ollama-cloud discovery", () => {
    const originalHome = process.env.HOME;
    const originalKey = process.env.OLLAMA_API_KEY;
    let tmpDir: string;
    let projectDir: string;
    let home: string;
    let agentDir: string;

    beforeEach(() => {
        tmpDir = mkdtempSync(join(tmpdir(), "daemon-list-models-test-"));
        home = join(tmpDir, "home");
        agentDir = join(home, ".pizzapi");
        projectDir = join(tmpDir, "project");
        mkdirSync(join(projectDir, ".pizzapi"), { recursive: true });
        mkdirSync(agentDir, { recursive: true });
        writeFileSync(join(projectDir, ".pizzapi", "config.json"), JSON.stringify({ agentDir }));
        _setGlobalConfigDir(join(tmpDir, "global-unused"));
        process.env.HOME = home;
        delete process.env.OLLAMA_API_KEY;
    });

    afterEach(() => {
        _setGlobalConfigDir(null);
        process.env.HOME = originalHome;
        if (originalKey === undefined) delete process.env.OLLAMA_API_KEY;
        else process.env.OLLAMA_API_KEY = originalKey;
        rmSync(tmpDir, { recursive: true, force: true });
    });

    test("surfaces the offline fallback catalog when OLLAMA_API_KEY is set", async () => {
        process.env.OLLAMA_API_KEY = "test-env-key";
        const models = await listConfiguredModels(projectDir);
        expect(models.some((m) => m.provider === "ollama-cloud" && m.id === "glm-5.1")).toBe(true);
    });

    test("surfaces the offline fallback catalog for a stored credential (no env var)", async () => {
        writeFileSync(
            join(agentDir, "auth.json"),
            JSON.stringify({ "ollama-cloud": { type: "api_key", key: "stored-test-key" } }),
        );
        const models = await listConfiguredModels(projectDir);
        expect(models.some((m) => m.provider === "ollama-cloud" && m.id === "glm-5.1")).toBe(true);
    });

    test("does not surface ollama-cloud models with no credentials configured", async () => {
        const models = await listConfiguredModels(projectDir);
        expect(models.some((m) => m.provider === "ollama-cloud")).toBe(false);
    });

    test("merges cached live-discovered models once credentials are configured", async () => {
        writeFileSync(
            join(agentDir, "ollama-cloud-models-cache.json"),
            JSON.stringify({
                fetchedAt: Date.now(),
                models: [
                    {
                        id: "cached-only-model",
                        name: "cached-only-model",
                        provider: "ollama-cloud",
                        api: "openai-completions",
                        baseUrl: "https://ollama.com/v1",
                        reasoning: false,
                        input: ["text"],
                        contextWindow: 32768,
                        maxTokens: 8192,
                    },
                ],
            }),
        );
        process.env.OLLAMA_API_KEY = "test-env-key";
        const models = await listConfiguredModels(projectDir);
        expect(models.some((m) => m.provider === "ollama-cloud" && m.id === "cached-only-model")).toBe(true);
    });
});
