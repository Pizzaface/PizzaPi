export interface ToolDefinition {
    name: string;
    description: string;
    parameters: Record<string, unknown>;
}

export interface ToolResult {
    success: boolean;
    output: unknown;
    error?: string;
}

export interface Tool {
    definition: ToolDefinition;
    execute(args: Record<string, unknown>): Promise<ToolResult>;
}
