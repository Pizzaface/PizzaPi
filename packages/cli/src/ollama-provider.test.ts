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
    const models = getModels("ollama-cloud");
    const modelRecords = models as Array<any>;

    expect(modelRecords.length).toBeGreaterThan(0);
    for (const id of ["glm-5.1", "gpt-oss:20b", "kimi-k2.6", "qwen3-coder-next", "deepseek-v4-pro"]) {
      expect(modelRecords.some((m) => m.id === id)).toBe(true);
    }

    const glm = modelRecords.find((m) => m.id === "glm-5.1");
    expect(glm).toBeDefined();
    expect(glm?.provider).toBe("ollama-cloud");
    expect(glm?.baseUrl).toBe("https://ollama.com/v1");
    expect(glm?.api).toBe("openai-completions");
    expect(glm?.compat).toMatchObject({
      supportsStore: false,
      supportsDeveloperRole: false,
      supportsReasoningEffort: false,
      supportsUsageInStreaming: true,
      supportsLongCacheRetention: false,
      supportsStrictMode: false,
      maxTokensField: "max_tokens",
    });
  });

  test("pi-ai exposes Ollama Cloud models with scraped context windows", async () => {
    const { getModels } = await import("@mariozechner/pi-ai");
    const models = getModels("ollama-cloud");
    const contextById = new Map((models as Array<any>).map((model) => [model.id, model.contextWindow]));

    expect(contextById.get("deepseek-v4-pro")).toBe(1048576);
    expect(contextById.get("deepseek-v4-flash")).toBe(1048576);
    expect(contextById.get("nemotron-3-nano:30b")).toBe(1048576);
    expect(contextById.get("rnj-1:8b")).toBe(32768);
    expect(contextById.get("ministral-3:8b")).toBe(262144);
    expect(contextById.get("minimax-m2.7")).toBe(204800);
    expect(contextById.get("gemma3:12b")).toBe(32768);
    expect(contextById.get("mistral-large-3:675b")).toBe(262144);
    expect(contextById.get("devstral-small-2:24b")).toBe(262144);
  });

  test("pi-ai resolves OLLAMA_API_KEY from environment for ollama-cloud", async () => {
    const { getEnvApiKey } = await import("@mariozechner/pi-ai");
    const prev = process.env.OLLAMA_API_KEY;
    process.env.OLLAMA_API_KEY = "test-ollama-key";
    try {
      expect(getEnvApiKey("ollama-cloud")).toBe("test-ollama-key");
    } finally {
      if (prev === undefined) delete process.env.OLLAMA_API_KEY;
      else process.env.OLLAMA_API_KEY = prev;
    }
  });

  test("pi-ai requests streaming usage for Ollama Cloud so tokens are counted", async () => {
    const { complete, getModels } = await import("@mariozechner/pi-ai");
    const model = (getModels("ollama-cloud") as Array<any>).find((m) => m.id === "glm-5.1");
    expect(model).toBeDefined();

    const prevFetch = globalThis.fetch;
    const prevKey = process.env.OLLAMA_API_KEY;
    process.env.OLLAMA_API_KEY = "test-ollama-key";
    let requestPayload: any;

    globalThis.fetch = (async (_input: string | URL | Request, init?: RequestInit) => {
      requestPayload = JSON.parse(String(init?.body));
      const body = [
        `data: ${JSON.stringify({
          id: "chatcmpl-test",
          object: "chat.completion.chunk",
          choices: [{ index: 0, delta: { content: "hi" }, finish_reason: null }],
        })}`,
        `data: ${JSON.stringify({
          id: "chatcmpl-test",
          object: "chat.completion.chunk",
          choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
          usage: { prompt_tokens: 123, completion_tokens: 45, total_tokens: 168 },
        })}`,
        "data: [DONE]",
        "",
      ].join("\n\n");
      return new Response(body, { status: 200, headers: { "content-type": "text/event-stream" } });
    }) as unknown as typeof fetch;

    try {
      const response = await complete(
        model,
        { messages: [{ role: "user", content: "hello", timestamp: Date.now() }] },
        { maxRetries: 0 },
      );

      expect(requestPayload.stream_options).toEqual({ include_usage: true });
      expect(response.usage.input).toBe(123);
      expect(response.usage.output).toBe(45);
      expect(response.usage.totalTokens).toBe(168);
    } finally {
      globalThis.fetch = prevFetch;
      if (prevKey === undefined) delete process.env.OLLAMA_API_KEY;
      else process.env.OLLAMA_API_KEY = prevKey;
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
