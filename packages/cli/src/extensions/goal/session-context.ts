/**
 * Capture of the exact context pi last sent to the provider for a session.
 *
 * The `/goal` LLM evaluator reuses this so its judge call shares a prefix
 * with the session's own requests and reads from the provider's prompt cache
 * instead of paying full price for a fresh transcript.
 *
 * Why the prefix has to be captured rather than reconstructed: providers key
 * their cache on an exact serialized prefix — for Anthropic that is
 * `tools → system → messages`, in that order. A tools block that differs by
 * one entry (or one position) invalidates everything after it, so the numbers
 * below come from what pi actually sent, not from what we think it sent.
 */
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { Message, Tool } from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export interface CapturedSessionContext {
    /** The session's effective system prompt at capture time. */
    systemPrompt: string;
    /** Messages exactly as handed to the provider. */
    messages: Message[];
    /** Active tool definitions, in pi's own order. */
    tools: Tool[];
    /** Epoch milliseconds. */
    capturedAt: number;
}

const capturedBySessionId = new Map<string, CapturedSessionContext>();

/** Replace the captured context for a session. Only the latest is kept. */
export function captureSessionContext(sessionId: string, captured: CapturedSessionContext): void {
    capturedBySessionId.set(sessionId, captured);
}

export function getCapturedSessionContext(sessionId: string): CapturedSessionContext | undefined {
    return capturedBySessionId.get(sessionId);
}

/** Drop all captured state for a session. */
export function resetSessionContext(sessionId: string): void {
    capturedBySessionId.delete(sessionId);
}

/**
 * Reduce pi's `AgentMessage[]` to the provider-facing `Message[]`.
 *
 * The `context` event fires before pi's own `convertToLlm` step, so the array
 * it hands out can still contain custom agent messages (PizzaPi's background
 * bash execution messages, UI-only notifications) that never reach the
 * provider in that form. Dropping them approximates the conversion.
 *
 * Approximates, not reproduces: a session whose `convertToLlm` rewrites a
 * custom message into a real one (rather than dropping it) will produce a
 * prefix that differs from what pi sent, and the cache won't hit; the judge
 * call still works, it just pays full input price.
 */
export function toLlmMessages(messages: AgentMessage[]): Message[] {
    return messages.filter(
        (message): message is Message =>
            message !== null &&
            typeof message === "object" &&
            "role" in message &&
            (message.role === "user" || message.role === "assistant" || message.role === "toolResult"),
    );
}

/**
 * Snapshot the active tool definitions in pi's own ordering.
 *
 * `getAllTools()` returns every configured tool; `getActiveTools()` returns
 * the names currently in play. Filtering the former by the latter preserves
 * pi's ordering, which is what the provider serializes.
 */
export function snapshotActiveTools(pi: ExtensionAPI): Tool[] {
    if (typeof pi.getAllTools !== "function" || typeof pi.getActiveTools !== "function") return [];
    try {
        const active = new Set(pi.getActiveTools());
        return pi
            .getAllTools()
            .filter((tool) => active.has(tool.name))
            .map((tool) => ({
                name: tool.name,
                description: tool.description,
                parameters: tool.parameters,
            })) as Tool[];
    } catch {
        // Tool introspection is best-effort; without it the evaluator falls
        // back to the standalone path rather than sending a mismatched prefix.
        return [];
    }
}
