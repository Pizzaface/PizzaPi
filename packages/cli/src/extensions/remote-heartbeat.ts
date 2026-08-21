/**
 * Heartbeat construction and lifecycle for the remote extension.
 */

import type { RelayContext } from "./remote-types.js";
import { emitSessionMetadataUpdate, readQueuedFollowUps } from "./remote/chunked-delivery.js";

interface TokenTotals { input: number; output: number; cacheRead: number; cacheWrite: number; cost: number }

// Per-relay-context cache of cumulative totals, additionally pinned to the
// session manager instance so a session switch (or two sessions sharing the
// process) with an identical entry count/leafId can never serve another
// session's totals. contextTokens is deliberately NOT cached: compaction can
// change context size without changing the entry-count/leaf cache key.
const tokenUsageCaches = new WeakMap<object, { manager: unknown; key: string; value: TokenTotals }>();

export function buildTokenUsage(rctx: RelayContext): { input: number; output: number; cacheRead: number; cacheWrite: number; cost: number; contextTokens: number | null } {
    if (!rctx.latestCtx) {
        tokenUsageCaches.delete(rctx);
        return { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, contextTokens: null };
    }
    const manager = rctx.latestCtx.sessionManager;
    const entries = manager.getEntries();
    const leafId = manager.getLeafId?.() ?? null;
    const cacheKey = `${entries.length}:${leafId ?? "null"}`;

    const contextTokens = rctx.latestCtx.getContextUsage?.()?.tokens ?? null;

    const cached = tokenUsageCaches.get(rctx);
    if (cached && cached.manager === manager && cached.key === cacheKey) {
        return { ...cached.value, contextTokens };
    }

    let input = 0, output = 0, cacheRead = 0, cacheWrite = 0, cost = 0;
    for (const entry of entries) {
        if (entry.type === "message" && entry.message.role === "assistant") {
            input += entry.message.usage.input;
            output += entry.message.usage.output;
            cacheRead += entry.message.usage.cacheRead;
            cacheWrite += entry.message.usage.cacheWrite;
            cost += Math.max(0, entry.message.usage.cost.total);
        }
    }
    const totals: TokenTotals = { input, output, cacheRead, cacheWrite, cost };
    tokenUsageCaches.set(rctx, { manager, key: cacheKey, value: totals });
    return { ...totals, contextTokens };
}

export function buildHeartbeat(rctx: RelayContext) {
    return {
        type: "heartbeat",
        active: rctx.isAgentActive,
        isCompacting: rctx.isCompacting,
        ts: Date.now(),
        model: rctx.latestCtx?.model
            ? { provider: rctx.latestCtx.model.provider, id: rctx.latestCtx.model.id, name: rctx.latestCtx.model.name, reasoning: rctx.latestCtx.model.reasoning, contextWindow: rctx.latestCtx.model.contextWindow }
            : null,
        sessionName: rctx.getCurrentSessionName(),
        uptime: rctx.sessionStartedAt !== null ? Date.now() - rctx.sessionStartedAt : null,
        cwd: rctx.latestCtx?.cwd ?? null,
        queuedMessages: readQueuedFollowUps(rctx),
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
        // Emit metadata-only update when messages haven't changed, or a full
        // session_active when they have.  This avoids re-serializing 10-50 MB
        // of message history every 10 s during idle/thinking sessions.
        emitSessionMetadataUpdate(rctx);
    }, 10_000);
}

export function stopHeartbeat() {
    if (heartbeatTimer !== null) {
        clearInterval(heartbeatTimer);
        heartbeatTimer = null;
    }
}
