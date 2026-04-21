/**
 * Helper for resolving the effective `deliverAs` on web-UI-originated input.
 *
 * Lives in its own file (rather than inside `connection.ts`) so that unit
 * tests can import it without also pulling in the full `connection.ts`
 * module graph — in particular `socket.io-client`, which other tests need
 * to mock before it is first imported. Co-locating the helper with the
 * socket code would silently defeat those mocks by pre-loading the real
 * `io` before they run.
 */

/**
 * Resolve the effective `deliverAs` for a user input message.
 *
 * When the web UI sends a message while it believes the agent is idle, it
 * intentionally omits `deliverAs`. If the runtime turns out to be streaming
 * by the time the message is ready to dispatch (typical after a slow MCP
 * startup where the initial prompt has already started streaming), passing
 * `undefined` into `prompt()` would throw "Agent is already processing..."
 * and the message would be silently dropped.
 *
 * If no explicit mode was supplied and the agent is currently streaming,
 * default to `"followUp"` so the message is safely queued.
 */
export function resolveInputDeliverAs(
    requested: "followUp" | "steer" | undefined,
    isAgentActive: boolean,
): "followUp" | "steer" | undefined {
    if (requested) return requested;
    if (isAgentActive) return "followUp";
    return undefined;
}
