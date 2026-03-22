/**
 * Heartbeat construction and lifecycle for the remote extension.
 */

import type { RelayContext } from "./remote-types.js";

export function buildTokenUsage(rctx: RelayContext): { input: number; output: number; cacheRead: number; cacheWrite: number; cost: number } {
    if (!rctx.latestCtx) return { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0 };
    let input = 0, output = 0, cacheRead = 0, cacheWrite = 0, cost = 0;
    for (const entry of rctx.latestCtx.sessionManager.getEntries()) {
        if (entry.type === "message" && entry.message.role === "assistant") {
            input += entry.message.usage.input;
            output += entry.message.usage.output;
            cacheRead += entry.message.usage.cacheRead;
            cacheWrite += entry.message.usage.cacheWrite;
            cost += entry.message.usage.cost.total;
        }
    }
    return { input, output, cacheRead, cacheWrite, cost };
}

export function buildHeartbeat(rctx: RelayContext) {
    return {
        type: "heartbeat",
        active: rctx.isAgentActive,
        ts: Date.now(),
        model: rctx.latestCtx?.model
            ? { provider: rctx.latestCtx.model.provider, id: rctx.latestCtx.model.id, name: rctx.latestCtx.model.name, reasoning: rctx.latestCtx.model.reasoning }
            : null,
        sessionName: rctx.getCurrentSessionName(),
        uptime: rctx.sessionStartedAt !== null ? Date.now() - rctx.sessionStartedAt : null,
        cwd: rctx.latestCtx?.cwd ?? null,
    };
}

// ── Timer state (module-level, one heartbeat per process) ─────────────────────
let heartbeatTimer: ReturnType<typeof setInterval> | null = null;

export function startHeartbeat(rctx: RelayContext) {
    stopHeartbeat();
    // Send an immediate heartbeat so the viewer has state right away.
    rctx.forwardEvent(buildHeartbeat(rctx));
    heartbeatTimer = setInterval(() => {
        rctx.forwardEvent(buildHeartbeat(rctx));
    }, 10_000);
}

export function stopHeartbeat() {
    if (heartbeatTimer !== null) {
        clearInterval(heartbeatTimer);
        heartbeatTimer = null;
    }
}
