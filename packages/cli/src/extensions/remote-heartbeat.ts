/**
 * Heartbeat construction and lifecycle for the remote extension.
 */

import type { RelayContext } from "./remote-types.js";
import { getAuthSource } from "./remote-auth-source.js";
import { buildProviderUsage, refreshAllUsage } from "./remote-provider-usage.js";
import { getCurrentTodoList } from "./update-todo.js";
import { isPlanModeEnabled } from "./plan-mode-toggle.js";

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
    const thinkingLevel = rctx.getCurrentThinkingLevel();
    const authSource = getAuthSource(rctx.latestCtx);

    return {
        type: "heartbeat",
        active: rctx.isAgentActive,
        isCompacting: rctx.isCompacting,
        model: rctx.latestCtx?.model
            ? { provider: rctx.latestCtx.model.provider, id: rctx.latestCtx.model.id, name: rctx.latestCtx.model.name, reasoning: rctx.latestCtx.model.reasoning }
            : null,
        authSource,
        sessionName: rctx.getCurrentSessionName(),
        thinkingLevel: thinkingLevel ?? null,
        tokenUsage: buildTokenUsage(rctx),
        cwd: rctx.latestCtx?.cwd ?? null,
        uptime: rctx.sessionStartedAt !== null ? Date.now() - rctx.sessionStartedAt : null,
        ts: Date.now(),
        providerUsage: buildProviderUsage(),
        todoList: getCurrentTodoList(),
        pendingQuestion: rctx.pendingAskUserQuestion
            ? {
                  toolCallId: rctx.pendingAskUserQuestion.toolCallId,
                  questions: rctx.pendingAskUserQuestion.questions,
                  display: rctx.pendingAskUserQuestion.display,
              }
            : null,
        pendingPlan: rctx.pendingPlanMode
            ? {
                  toolCallId: rctx.pendingPlanMode.toolCallId,
                  title: rctx.pendingPlanMode.title,
                  description: rctx.pendingPlanMode.description,
                  steps: rctx.pendingPlanMode.steps,
              }
            : null,
        retryState: rctx.lastRetryableError
            ? {
                  errorMessage: rctx.lastRetryableError.errorMessage,
                  detectedAt: rctx.lastRetryableError.detectedAt,
              }
            : null,
        pendingPluginTrust: rctx.pendingPluginTrust
            ? {
                  promptId: rctx.pendingPluginTrust.promptId,
                  pluginNames: rctx.pendingPluginTrust.pluginNames,
                  pluginSummaries: rctx.pendingPluginTrust.pluginSummaries,
              }
            : null,
        mcpStartupReport: rctx.lastMcpStartupReport,
        planModeEnabled: isPlanModeEnabled(),
    };
}

// ── Timer state (module-level, one heartbeat per process) ─────────────────────
let heartbeatTimer: ReturnType<typeof setInterval> | null = null;

export function startHeartbeat(rctx: RelayContext) {
    stopHeartbeat();
    // Send an immediate heartbeat so the viewer has state right away.
    rctx.forwardEvent(buildHeartbeat(rctx));
    heartbeatTimer = setInterval(() => {
        void refreshAllUsage();
        rctx.forwardEvent(buildHeartbeat(rctx));
    }, 10_000);
}

export function stopHeartbeat() {
    if (heartbeatTimer !== null) {
        clearInterval(heartbeatTimer);
        heartbeatTimer = null;
    }
}
