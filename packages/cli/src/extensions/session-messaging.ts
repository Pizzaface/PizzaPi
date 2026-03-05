/**
 * Session Messaging extension — NO-OP stub.
 *
 * The raw inter-agent messaging tools (send_message, wait_for_message,
 * check_messages, get_session_id, session_status, emit, set_delivery_mode)
 * have been removed from the agent-facing tool surface. Agents now use
 * `spawn_and_wait` and `fan_out` exclusively — the infrastructure handles
 * all communication automatically.
 *
 * The underlying message bus (session-message-bus.ts) and relay socket
 * handlers (remote.ts) remain fully operational for internal use by
 * spawn_and_wait, fan_out, and the completion hook system.
 *
 * UI rendering for these tools is preserved in tool-rendering.tsx for
 * backward compatibility with existing session history.
 */
import type { ExtensionFactory } from "@mariozechner/pi-coding-agent";

export const sessionMessagingExtension: ExtensionFactory = (_pi) => {
    // No tools registered — all inter-agent communication is now handled
    // automatically by spawn_and_wait / fan_out via the message bus.
};
