/**
 * `/goal` extension — registers the slash command and manages per-session
 * goal state, including the automatic evaluator stop hook after each turn.
 *
 * Wiring:
 * - `pi.registerCommand("goal", …)` handles the slash command.
 * - `session_start` restores any persisted goal from custom entries.
 * - `turn_end` records turn spend, checks budgets, and runs the configured
 *   evaluator (keyword or LLM). When the goal is met or a budget is exhausted,
 *   it logs a status message and calls `ctx.shutdown()` to trigger the normal
 *   stop/session-shutdown hooks.
 * - `before_agent_start` injects evaluator feedback as system-prompt guidance
 *   for the next turn when the goal has not yet been met.
 * - `session_shutdown` clears the in-memory entry for the session.
 */
import type {
    AssistantMessage,
    ToolResultMessage,
} from "@earendil-works/pi-ai";
import { completeSimple } from "@earendil-works/pi-ai";
import type {
    BeforeAgentStartEvent,
    ExtensionAPI,
    ExtensionCommandContext,
    ExtensionContext,
    ExtensionFactory,
    TurnEndEvent,
} from "@earendil-works/pi-coding-agent";
import { createLogger } from "@pizzapi/tools";
import { loadConfig } from "../../config/io.js";
import {
    checkBudget,
    clearGoal,
    clearPendingGuidance,
    formatGoalStatus,
    getGoal,
    getPendingGuidance,
    recordEvaluation,
    recordTurnSpend,
    resetSession,
    restoreGoal,
    setGoal,
    setPendingGuidance,
} from "./state.js";
import { parseGoalArgs } from "./parser.js";
import {
    createLlmGoalEvaluator,
    keywordGoalEvaluator,
    resolveEvaluatorModel,
} from "./evaluator.js";
import { buildTranscript, extractLatestTurnText } from "./transcript.js";
import type {
    GoalCommandResult,
    GoalEvaluationContext,
    GoalState,
} from "./types.js";

const log = createLogger("goal");

function getSessionId(ctx: ExtensionContext): string {
    return process.env.PIZZAPI_SESSION_ID ?? process.env.SESSION_ID ?? ctx.sessionManager.getSessionId() ?? "unknown";
}

function handleGoalCommand(
    args: string,
    ctx: ExtensionCommandContext,
    pi: Pick<ExtensionAPI, "appendEntry">,
): GoalCommandResult {
    const sessionId = getSessionId(ctx);

    try {
        const parsed = parseGoalArgs(args);

        if (parsed.statusOnly) {
            const state = getGoal(sessionId);
            if (!state) {
                return { success: true, message: "No active goal. Use /goal \"<condition>\" to set one." };
            }
            return { success: true, message: formatGoalStatus(state), state };
        }

        if (parsed.clear) {
            return clearGoal(sessionId, pi);
        }

        const state = setGoal(sessionId, parsed.condition, parsed.budget, pi);
        return {
            success: true,
            message: `Goal set: ${state.condition.description}`,
            state,
        };
    } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        return { success: false, message: `Invalid /goal command: ${msg}` };
    }
}

function isAssistantMessage(message: unknown): message is AssistantMessage {
    return (
        typeof message === "object" &&
        message !== null &&
        "role" in message &&
        message.role === "assistant"
    );
}

function getAssistantUsage(message: unknown): { tokens: number; cost: number } {
    if (!isAssistantMessage(message)) return { tokens: 0, cost: 0 };
    return {
        tokens: message.usage?.totalTokens ?? 0,
        cost: message.usage?.cost?.total ?? 0,
    };
}

function buildEvaluationContext(
    state: GoalState,
    event: TurnEndEvent,
    ctx: ExtensionContext,
): GoalEvaluationContext {
    const latestTurnText = extractLatestTurnText({
        assistantContent: isAssistantMessage(event.message)
            ? event.message.content
            : undefined,
        toolResults: event.toolResults as ToolResultMessage[],
    });
    const transcript = buildTranscript(ctx.sessionManager.getEntries() as any[]);

    return {
        latestTurnText,
        transcript,
        history: state.evaluations,
        turnCount: state.turnCount,
        tokenSpend: state.tokenSpend,
    };
}

async function runGoalStopCheck(
    event: TurnEndEvent,
    ctx: ExtensionContext,
    pi: Pick<ExtensionAPI, "appendEntry" | "sendMessage">,
): Promise<void> {
    const sessionId = getSessionId(ctx);
    let state = getGoal(sessionId);
    if (!state || state.status !== "active") return;

    const usage = getAssistantUsage(event.message);
    recordTurnSpend(sessionId, usage.tokens, usage.cost);

    const budgetReason = checkBudget(state);
    if (budgetReason) {
        pi.sendMessage({
            customType: "goal_status",
            content: `Goal budget reached: ${budgetReason}. Stopping session.`,
            display: true,
        });
        ctx.shutdown();
        return;
    }

    const evalContext = buildEvaluationContext(state, event, ctx);

    let evaluator;
    if (state.condition.evaluator === "keyword") {
        evaluator = keywordGoalEvaluator;
    } else {
        try {
            const config = loadConfig(ctx.cwd);
            const resolved = await resolveEvaluatorModel(ctx.modelRegistry, config.goal?.evaluatorModel);
            if (!resolved) {
                const reason = "No configured evaluator model with auth is available; skipping LLM evaluation.";
                log.warn(reason);
                evaluator = {
                    evaluate: async () => ({
                        turnIndex: state!.turnCount,
                        verdict: "uncertain" as const,
                        reason,
                        timestamp: Date.now(),
                    }),
                };
            } else {
                evaluator = createLlmGoalEvaluator({
                    completeSimple,
                    model: resolved.model,
                    apiKey: resolved.apiKey,
                    maxTokens: config.goal?.evaluatorMaxTokens,
                    signal: ctx.signal,
                });
            }
        } catch (err) {
            const reason = `Failed to resolve goal evaluator model: ${err instanceof Error ? err.message : String(err)}`;
            log.error(reason);
            evaluator = {
                evaluate: async () => ({
                    turnIndex: state!.turnCount,
                    verdict: "uncertain" as const,
                    reason,
                    timestamp: Date.now(),
                }),
            };
        }
    }

    try {
        const feedback = await evaluator.evaluate(state, evalContext);
        state = recordEvaluation(sessionId, feedback, pi) ?? state;
    } catch (err) {
        const reason = err instanceof Error ? err.message : String(err);
        log.error("Goal evaluation failed", err);
        state = recordEvaluation(sessionId, {
            turnIndex: state.turnCount,
            verdict: "uncertain",
            reason,
            timestamp: Date.now(),
        }, pi) ?? state;
    }

    if (state.status !== "active") {
        if (state.stopReason === "goal_met") {
            pi.sendMessage({
                customType: "goal_status",
                content: `Goal met: ${state.condition.description}`,
                display: true,
            });
        } else {
            pi.sendMessage({
                customType: "goal_status",
                content: `Goal stopped: ${state.stopReason}.`,
                display: true,
            });
        }
        ctx.shutdown();
        return;
    }

    const lastEval = state.evaluations.at(-1);
    if (lastEval && lastEval.verdict === "not_met") {
        setPendingGuidance(sessionId, lastEval.reason);
    }
}

export const goalExtension: ExtensionFactory = (pi) => {
    pi.registerCommand("goal", {
        description: "Set a success condition and optional budget for the session",
        handler: async (args, ctx) => {
            const result = handleGoalCommand(args, ctx, pi);
            pi.sendMessage({
                customType: "goal_status",
                content: result.message,
                display: true,
            });
        },
    });

    pi.on("session_start", (_event, ctx) => {
        const sessionId = getSessionId(ctx);
        const entries = ctx.sessionManager.getEntries();
        restoreGoal(sessionId, entries as any[]);
    });

    pi.on("turn_end", async (event, ctx) => {
        await runGoalStopCheck(event, ctx, pi);
    });

    pi.on("before_agent_start", async (event, ctx) => {
        const sessionId = getSessionId(ctx);
        const guidance = getPendingGuidance(sessionId);
        if (!guidance) return undefined;

        clearPendingGuidance(sessionId);
        const systemPrompt = `${event.systemPrompt}\n\n[Goal guidance] The goal has not been met yet. ${guidance}`;
        return { systemPrompt };
    });

    pi.on("session_shutdown", () => {
        const sessionId = process.env.PIZZAPI_SESSION_ID ?? process.env.SESSION_ID ?? "unknown";
        resetSession(sessionId);
    });
};
