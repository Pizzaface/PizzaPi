export interface Message {
    role: "system" | "user" | "assistant";
    content: string;
}

export interface CompletionOptions {
    model: string;
    messages: Message[];
    temperature?: number;
    maxTokens?: number;
    stream?: boolean;
}

export interface ProviderConfig {
    apiKey: string;
    baseUrl?: string;
}

export interface Provider {
    name: string;
    complete(options: CompletionOptions): Promise<string>;
    stream(options: CompletionOptions): AsyncIterable<string>;
}
