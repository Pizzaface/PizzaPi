/**
 * Static Ollama Cloud model catalog — baseline registered via
 * ollamaCloudProviderExtension (see extensions/ollama-cloud-provider.ts) so
 * `--provider ollama-cloud`, `pizza models`, and the web model selector see
 * a usable catalog with zero network before live discovery
 * (ollama-cloud-models.ts) refreshes it.
 *
 * This replaces the OLLAMA_CLOUD_MODELS catalog that used to be inlined into
 * the @earendil-works/pi-ai patch's dist/models.generated.js. Same data,
 * sourced from the OpenAI-compatible Ollama Cloud list endpoint
 * (https://ollama.com/v1/models) with context windows and capabilities from
 * https://ollama.com/api/show. Cost metadata is zero until Ollama publishes
 * machine-usable per-token pricing — toOllamaCloudRuntimeModel() fills that
 * in, along with the openai-completions compat flags.
 */
import type { OllamaCloudModel } from "./ollama-cloud-models.js";

const BASE_URL = "https://ollama.com/v1";

function model(
    id: string,
    name: string,
    opts: { reasoning?: boolean; input?: OllamaCloudModel["input"]; contextWindow?: number; maxTokens?: number } = {},
): OllamaCloudModel {
    return {
        id,
        name,
        provider: "ollama-cloud",
        api: "openai-completions",
        baseUrl: BASE_URL,
        reasoning: opts.reasoning ?? false,
        input: opts.input ?? ["text"],
        contextWindow: opts.contextWindow ?? 128000,
        maxTokens: opts.maxTokens ?? 16384,
    };
}

export const OLLAMA_CLOUD_FALLBACK_MODELS: OllamaCloudModel[] = [
    model("cogito-2.1:671b", "Cogito 2.1 671B", { reasoning: true, contextWindow: 163840, maxTokens: 32768 }),
    model("deepseek-v3.1:671b", "DeepSeek V3.1 671B", { reasoning: true, contextWindow: 163840, maxTokens: 32768 }),
    model("deepseek-v3.2", "DeepSeek V3.2", { reasoning: true, contextWindow: 163840, maxTokens: 32768 }),
    model("deepseek-v4-flash", "DeepSeek V4 Flash", { reasoning: true, contextWindow: 1048576, maxTokens: 32768 }),
    model("deepseek-v4-pro", "DeepSeek V4 Pro", { reasoning: true, contextWindow: 524288, maxTokens: 32768 }),
    model("devstral-2:123b", "Devstral 2 123B", { contextWindow: 262144, maxTokens: 32768 }),
    model("devstral-small-2:24b", "Devstral Small 2 24B", { input: ["text", "image"], contextWindow: 262144, maxTokens: 32768 }),
    model("gemini-3-flash-preview", "Gemini 3 Flash Preview", { reasoning: true, input: ["text", "image"], contextWindow: 1048576, maxTokens: 65536 }),
    model("gemma3:12b", "Gemma 3 12B", { input: ["text", "image"], contextWindow: 131072, maxTokens: 16384 }),
    model("gemma3:27b", "Gemma 3 27B", { input: ["text", "image"], contextWindow: 131072, maxTokens: 16384 }),
    model("gemma3:4b", "Gemma 3 4B", { input: ["text", "image"], contextWindow: 131072, maxTokens: 16384 }),
    model("gemma4:31b", "Gemma 4 31B", { reasoning: true, input: ["text", "image"], contextWindow: 262144, maxTokens: 16384 }),
    model("glm-4.6", "GLM 4.6", { reasoning: true, contextWindow: 202752, maxTokens: 65536 }),
    model("glm-4.7", "GLM 4.7", { reasoning: true, contextWindow: 202752, maxTokens: 65536 }),
    model("glm-5", "GLM 5", { reasoning: true, contextWindow: 202752, maxTokens: 131072 }),
    model("glm-5.1", "GLM 5.1", { reasoning: true, contextWindow: 202752, maxTokens: 131072 }),
    model("gpt-oss:120b", "GPT-OSS 120B", { reasoning: true, contextWindow: 131072, maxTokens: 16384 }),
    model("gpt-oss:20b", "GPT-OSS 20B", { reasoning: true, contextWindow: 131072, maxTokens: 16384 }),
    model("kimi-k2-thinking", "Kimi K2 Thinking", { reasoning: true, contextWindow: 262144, maxTokens: 32768 }),
    model("kimi-k2.5", "Kimi K2.5", { reasoning: true, input: ["text", "image"], contextWindow: 262144, maxTokens: 32768 }),
    model("kimi-k2.6", "Kimi K2.6", { reasoning: true, input: ["text", "image"], contextWindow: 262144, maxTokens: 32768 }),
    model("kimi-k2.7-code", "Kimi K2.7 Code", { reasoning: true, input: ["text", "image"], contextWindow: 262144, maxTokens: 32768 }),
    model("kimi-k2:1t", "Kimi K2 1T", { contextWindow: 262144, maxTokens: 32768 }),
    model("minimax-m2", "MiniMax M2", { contextWindow: 204800, maxTokens: 32768 }),
    model("minimax-m2.1", "MiniMax M2.1", { reasoning: true, contextWindow: 204800, maxTokens: 32768 }),
    model("minimax-m2.5", "MiniMax M2.5", { reasoning: true, contextWindow: 196608, maxTokens: 32768 }),
    model("minimax-m2.7", "MiniMax M2.7", { reasoning: true, contextWindow: 196608, maxTokens: 32768 }),
    model("minimax-m3", "MiniMax M3", { reasoning: true, input: ["text", "image"], contextWindow: 524288, maxTokens: 32768 }),
    model("ministral-3:14b", "Ministral 3 14B", { input: ["text", "image"], contextWindow: 262144, maxTokens: 16384 }),
    model("ministral-3:3b", "Ministral 3 3B", { input: ["text", "image"], contextWindow: 262144, maxTokens: 16384 }),
    model("ministral-3:8b", "Ministral 3 8B", { input: ["text", "image"], contextWindow: 262144, maxTokens: 16384 }),
    model("mistral-large-3:675b", "Mistral Large 3 675B", { input: ["text", "image"], contextWindow: 262144, maxTokens: 32768 }),
    model("nemotron-3-nano:30b", "Nemotron 3 Nano 30B", { reasoning: true, contextWindow: 262144, maxTokens: 32768 }),
    model("nemotron-3-super", "Nemotron 3 Super", { reasoning: true, contextWindow: 262144, maxTokens: 32768 }),
    model("nemotron-3-ultra", "Nemotron 3 Ultra", { reasoning: true, contextWindow: 262144, maxTokens: 32768 }),
    model("qwen3-coder-next", "Qwen 3 Coder Next", { contextWindow: 262144, maxTokens: 32768 }),
    model("qwen3-coder:480b", "Qwen 3 Coder 480B", { contextWindow: 262144, maxTokens: 32768 }),
    model("qwen3-next:80b", "Qwen 3 Next 80B", { reasoning: true, contextWindow: 262144, maxTokens: 32768 }),
    model("qwen3-vl:235b", "Qwen 3 VL 235B", { reasoning: true, input: ["text", "image"], contextWindow: 262144, maxTokens: 32768 }),
    model("qwen3-vl:235b-instruct", "Qwen 3 VL 235B Instruct", { input: ["text", "image"], contextWindow: 262144, maxTokens: 32768 }),
    model("qwen3.5:397b", "Qwen 3.5 397B", { reasoning: true, input: ["text", "image"], contextWindow: 262144, maxTokens: 32768 }),
    model("rnj-1:8b", "RNJ 1 8B", { contextWindow: 32768, maxTokens: 16384 }),
];
