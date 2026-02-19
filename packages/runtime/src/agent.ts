import type { AgentConfig, AgentState, ConversationTurn } from "./types.js";

export class Agent {
    private config: AgentConfig;
    private state: AgentState;

    constructor(config: AgentConfig) {
        this.config = config;
        this.state = {
            history: [],
            messages: [],
            turnCount: 0,
            isRunning: false,
        };

        if (config.systemPrompt) {
            this.state.messages.push({
                role: "system",
                content: config.systemPrompt,
            });
        }
    }

    async run(input: string): Promise<string> {
        this.state.isRunning = true;
        this.state.messages.push({ role: "user", content: input });
        this.state.history.push({ role: "user", content: input });

        try {
            const response = await this.config.provider.complete({
                model: this.config.model,
                messages: this.state.messages,
            });

            this.state.messages.push({ role: "assistant", content: response });
            this.state.history.push({ role: "assistant", content: response });
            this.state.turnCount++;

            return response;
        } finally {
            this.state.isRunning = false;
        }
    }

    getState(): Readonly<AgentState> {
        return this.state;
    }

    reset(): void {
        const systemMessages = this.state.messages.filter((m) => m.role === "system");
        this.state = {
            history: [],
            messages: systemMessages,
            turnCount: 0,
            isRunning: false,
        };
    }
}
