import type { Message, Provider } from "@pizzapi/providers";
import type { Tool } from "./tools.js";

export interface AgentConfig {
    provider: Provider;
    model: string;
    systemPrompt?: string;
    tools?: Tool[];
    maxTurns?: number;
}

export interface ConversationTurn {
    role: "user" | "assistant" | "tool";
    content: string;
    toolCall?: {
        name: string;
        args: Record<string, unknown>;
    };
    toolResult?: {
        name: string;
        result: unknown;
    };
}

export interface AgentState {
    history: ConversationTurn[];
    messages: Message[];
    turnCount: number;
    isRunning: boolean;
}
