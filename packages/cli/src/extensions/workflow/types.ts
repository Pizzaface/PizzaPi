/**
 * Shared types for the dynamic workflow runtime.
 *
 * A "workflow" is a JS script that orchestrates subagents via `agent()` and
 * `pipeline()` primitives. `WorkflowDetails` is the streaming payload the
 * `run_workflow` tool emits on every state change — the web UI (dish 002)
 * renders it directly, so keep it JSON-serializable.
 */

export type WorkflowAgentStatus = "pending" | "running" | "done" | "error";

export interface WorkflowAgentInfo {
    id: string;
    label?: string;
    prompt: string;
    status: WorkflowAgentStatus;
    model?: string;
    tokens?: number;
    result?: string;
    error?: string;
}

/** One `agent()` call or one `pipeline()` call. */
export interface WorkflowPhase {
    label: string;
    agents: WorkflowAgentInfo[];
}

export interface WorkflowDetails {
    name?: string;
    status: "running" | "done" | "error";
    phases: WorkflowPhase[];
    totalAgents: number;
    totalTokens: number;
    error?: string;
    result?: unknown;
}

export interface WorkflowMeta {
    name: string;
    description?: string;
}
