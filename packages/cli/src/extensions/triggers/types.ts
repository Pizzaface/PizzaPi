// ============================================================================
// types.ts — Core types for the conversation trigger system
// ============================================================================

/** A conversation trigger fired by a child session. */
export interface ConversationTrigger {
    type: string;
    sourceSessionId: string;
    sourceSessionName?: string;
    targetSessionId: string;
    payload: Record<string, unknown>;
    deliverAs: "steer" | "followUp";
    expectsResponse: boolean;
    triggerId: string;
    timeoutMs?: number;
    ts: string;
}

/** Renders a trigger into text for injection and optionally parses responses. */
export interface TriggerRenderer {
    type: string;
    render(trigger: ConversationTrigger): string;
    parseResponse?(responseText: string, trigger: ConversationTrigger): unknown;
}

/** Pending trigger awaiting a response from the target session. */
export interface PendingTrigger {
    trigger: ConversationTrigger;
    deliveredAt: number;
    timeoutTimer?: ReturnType<typeof setTimeout>;
}
