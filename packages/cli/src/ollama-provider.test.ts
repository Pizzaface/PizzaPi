import { describe, test, expect } from "bun:test";
import { dirname, resolve, join } from "path";
import { fileURLToPath } from "url";
import { mkdtempSync, writeFileSync } from "fs";
import { tmpdir } from "os";

function piCodingAgentPath(subpath: string): string {
  const pkgMainUrl = import.meta.resolve("@mariozechner/pi-coding-agent");
  const pkgMain = fileURLToPath(pkgMainUrl);
  const pkgRoot = resolve(dirname(pkgMain), "..");
  return resolve(pkgRoot, subpath);
}

describe("Ollama built-in provider", () => {
  test("pi-ai exposes bundled Ollama Cloud models with cloud base URL", async () => {
    const { getModels } = await import("@mariozechner/pi-ai");
    const models = (getModels as (provider: string) => Array<any>)("ollama-cloud");

    expect(models.length).toBeGreaterThan(0);
    for (const id of ["glm-5.1", "gpt-oss:20b", "kimi-k2.6", "qwen3-coder-next", "deepseek-v4-pro"]) {
      expect(models.some((m) => m.id === id)).toBe(true);
    }

    const glm = models.find((m) => m.id === "glm-5.1");
    expect(glm).toBeDefined();
    expect(glm?.provider).toBe("ollama-cloud");
    expect(glm?.baseUrl).toBe("https://ollama.com/v1");
    expect(glm?.api).toBe("openai-completions");
  });

  test("pi-ai resolves OLLAMA_API_KEY from environment for ollama-cloud", async () => {
    const { getEnvApiKey } = await import("@mariozechner/pi-ai");
    const prev = process.env.OLLAMA_API_KEY;
    process.env.OLLAMA_API_KEY = "test-ollama-key";
    try {
      expect((getEnvApiKey as (provider: string) => string | undefined)("ollama-cloud")).toBe("test-ollama-key");
    } finally {
      if (prev === undefined) delete process.env.OLLAMA_API_KEY;
      else process.env.OLLAMA_API_KEY = prev;
    }
  });

  test("coding-agent treats Ollama Cloud as a built-in API-key login provider", async () => {
    const { defaultModelPerProvider } = await import(piCodingAgentPath("dist/core/model-resolver.js"));
    const { getApiKeyProviderDisplayName, isApiKeyLoginProvider } = await import(
      piCodingAgentPath("dist/modes/interactive/interactive-mode.js")
    );

    expect(defaultModelPerProvider["ollama-cloud"]).toBe("glm-5.1");
    expect(getApiKeyProviderDisplayName("ollama-cloud")).toBe("Ollama Cloud");
    expect(isApiKeyLoginProvider("ollama-cloud", new Set())).toBe(true);
  });

  test("custom local ollama models remain separate from built-in cloud auth", async () => {
    const { AuthStorage, ModelRegistry } = await import("@mariozechner/pi-coding-agent");

    const dir = mkdtempSync(join(tmpdir(), "ollama-cloud-registry-"));
    const modelsPath = join(dir, "models.json");
    writeFileSync(
      modelsPath,
      JSON.stringify({
        providers: {
          ollama: {
            baseUrl: "http://localhost:11434/v1",
            api: "openai-completions",
            apiKey: "ollama",
            models: [{ id: "llama3.1:8b" }],
          },
        },
      }),
    );

    const prev = process.env.OLLAMA_API_KEY;
    process.env.OLLAMA_API_KEY = "test-ollama-key";
    try {
      const registry = ModelRegistry.create(AuthStorage.inMemory(), modelsPath);
      const available = registry.getAvailable();

      expect(available.some((m: any) => m.provider === "ollama-cloud" && m.id === "glm-5.1")).toBe(true);
      expect(available.some((m: any) => m.provider === "ollama" && m.id === "llama3.1:8b")).toBe(true);
      expect(registry.find("ollama", "llama3.1:8b")?.baseUrl).toBe("http://localhost:11434/v1");
    } finally {
      if (prev === undefined) delete process.env.OLLAMA_API_KEY;
      else process.env.OLLAMA_API_KEY = prev;
    }
  });
});
