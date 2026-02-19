import type { Provider, ProviderConfig } from "./types.js";

export type ProviderType = "openai" | "anthropic" | "google";

export function createProvider(type: ProviderType, config: ProviderConfig): Provider {
    switch (type) {
        case "openai":
            return createOpenAIProvider(config);
        case "anthropic":
            return createAnthropicProvider(config);
        case "google":
            return createGoogleProvider(config);
        default:
            throw new Error(`Unknown provider type: ${type}`);
    }
}

function createOpenAIProvider(_config: ProviderConfig): Provider {
    return {
        name: "openai",
        async complete(_options) {
            // TODO: implement OpenAI completions
            throw new Error("Not implemented");
        },
        async *stream(_options) {
            // TODO: implement OpenAI streaming
            throw new Error("Not implemented");
        },
    };
}

function createAnthropicProvider(_config: ProviderConfig): Provider {
    return {
        name: "anthropic",
        async complete(_options) {
            // TODO: implement Anthropic completions
            throw new Error("Not implemented");
        },
        async *stream(_options) {
            // TODO: implement Anthropic streaming
            throw new Error("Not implemented");
        },
    };
}

function createGoogleProvider(_config: ProviderConfig): Provider {
    return {
        name: "google",
        async complete(_options) {
            // TODO: implement Google completions
            throw new Error("Not implemented");
        },
        async *stream(_options) {
            // TODO: implement Google streaming
            throw new Error("Not implemented");
        },
    };
}
