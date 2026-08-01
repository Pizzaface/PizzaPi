/**
 * `/goal` extension — registers the slash command and manages per-session
 * goal state, including the automatic evaluator stop hook after each turn.
 *
 * Wiring:
 * - `pi.registerCommand("goal", …)` handles the slash command.
 * - `session_start` restores any persisted goal from custom entries.
 * - `turn_end` records turn spend, checks budgets, and runs the configured
 *   evaluator (keyword or LLM). A `not_met` verdict auto-continues the loop by
 *   sending a follow-up user message, so the agent keeps working toward the
 *   goal without the user prompting each turn. When the goal is met or a
 *   budget is exhausted, it logs a status message and returns control to the
 *   user.
 * - `before_agent_start` injects evaluator feedback as system-prompt guidance
 *   for the next turn when the goal has not yet been met.
 * - `session_shutdown` clears the in-memory entry for the session.
 */
import type { MetaGoalStatus } from "@pizzapi/protocol";
import type {
    AssistantMessage,
    ToolResultMessage,
} from "@earendil-works/pi-ai";
import { completeSimple } from "@earendil-works/pi-ai/compat";
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
    persist,
    clearPendingGuidance,
    formatGoalStatus,
    getActiveGoalFromEntries,
    getGoal,
    getPendingGuidance,
    recordEvaluation,
    recordTurnSpend,
    resetSession,
    restoreGoal,
    setGoal,
    setPendingGuidance,
    toMetaGoalStatus,
    formatCompactGoalStatus,
} from "./state.js";
import { parseGoalArgs } from "./parser.js";
import {
    createLlmGoalEvaluator,
    DEFAULT_EVALUATE_EVERY_N_TURNS,
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
    // Prefer the live session manager over environment variables to avoid
    // cross-session state pollution when multiple sessions run in the same
    // process (e.g. spawned sub-agents or resumed sessions).
    return ctx.sessionManager.getSessionId() ?? process.env.PIZZAPI_SESSION_ID ?? process.env.SESSION_ID ?? "unknown";
}

function emitGoalStatusChanged(
    pi: Pick<ExtensionAPI, "sendMessage" | "appendEntry" | "events">,
    payload: MetaGoalStatus | null,
): void {
    const events = (pi as any).events;
    if (events && typeof events.emit === "function") {
        events.emit("goal:state_changed", payload);
    }
}

function broadcastGoalStatus(
    sessionId: string,
    state: GoalState | undefined,
    ctx: ExtensionContext,
    pi: Pick<ExtensionAPI, "sendMessage" | "appendEntry" | "events">,
): void {
    if (state?.status === "active") {
        ctx.ui.setStatus("goal", formatCompactGoalStatus(state));
        emitGoalStatusChanged(pi, toMetaGoalStatus(state));
    } else {
        ctx.ui.setStatus("goal", undefined);
        emitGoalStatusChanged(pi, null);
    }
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
            kickoff: true,
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
        cost: Math.max(0, message.usage?.cost?.total ?? 0),
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

/**
 * How often (in turns) to invoke the LLM evaluator for this goal. The
 * keyword evaluator is free/local and always runs every turn (rate 1).
 * Resolution order: per-goal `--every` override, then
 * `config.goal.evaluateEveryNTurns`, then the built-in default. Config load
 * failures fall back to the default rather than surfacing an error here —
 * evaluator-model resolution (below) is where config problems get reported.
 */
function resolveEvaluateRate(state: GoalState, ctx: ExtensionContext): number {
    if (state.condition.evaluator === "keyword") return 1;
    if (state.condition.evaluateEveryNTurns !== undefined) {
        return Math.max(1, state.condition.evaluateEveryNTurns);
    }
    try {
        const configured = loadConfig(ctx.cwd).goal?.evaluateEveryNTurns;
        return configured !== undefined ? Math.max(1, configured) : DEFAULT_EVALUATE_EVERY_N_TURNS;
    } catch {
        return DEFAULT_EVALUATE_EVERY_N_TURNS;
    }
}

function stopForBudget(
    sessionId: string,
    state: GoalState,
    budgetReason: NonNullable<ReturnType<typeof checkBudget>>,
    pi: Pick<ExtensionAPI, "appendEntry" | "sendMessage">,
): void {
    clearPendingGuidance(sessionId);
    persist(state, pi);
    pi.sendMessage({
        customType: "goal_status",
        content: `Goal budget reached: ${budgetReason}. The goal is now inactive; you may continue the session.`,
        display: true,
    });
}

async function runGoalStopCheck(
    event: TurnEndEvent,
    ctx: ExtensionContext,
    pi: Pick<ExtensionAPI, "appendEntry" | "sendMessage" | "sendUserMessage">,
): Promise<void> {
    const sessionId = getSessionId(ctx);
    let state = getGoal(sessionId);
    if (!state || state.status !== "active") return;

    const usage = getAssistantUsage(event.message);
    state = recordTurnSpend(sessionId, usage.tokens, usage.cost) ?? state;

    // The LLM evaluator is a billed API call, so it's throttled to every
    // `evaluateRate` turns instead of every turn. The first turn always
    // evaluates so instantly-satisfied goals resolve right away; skipped
    // turns still enforce budgets and keep the agent looping, they just
    // don't spend a judge call.
    const evaluateRate = resolveEvaluateRate(state, ctx);
    if (state.turnCount > 1 && state.turnCount % evaluateRate !== 0) {
        const budgetReason = checkBudget(state);
        if (budgetReason) {
            stopForBudget(sessionId, state, budgetReason, pi);
            return;
        }
        const guidance = getPendingGuidance(sessionId);
        pi.sendUserMessage(
            guidance
                ? `[Goal not met] ${guidance}\nContinue working toward the goal: ${state.condition.description}`
                : `Work toward this goal until it is met: ${state.condition.description}`,
            { deliverAs: "steer" },
        );
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
        clearPendingGuidance(sessionId);
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
        // Never shutdown when the goal is met. The agent finishes the current
        // turn and returns control to the user.
        return;
    }

    // The goal is still unmet — enforce budgets before continuing the loop.
    // Checking budgets AFTER evaluation means a goal met on the final
    // budgeted turn reports "met" above instead of "budget reached".
    const budgetReason = checkBudget(state);
    if (budgetReason) {
        // Do not shutdown the session; budget exhaustion only deactivates the
        // goal and lets the agent return control to the user naturally.
        stopForBudget(sessionId, state, budgetReason, pi);
        return;
    }

    const lastEval = state.evaluations.at(-1);
    if (lastEval && lastEval.verdict === "not_met") {
        setPendingGuidance(sessionId, lastEval.reason);
        // Goal loop: a "not met" verdict starts another turn instead of
        // returning control to the user (parity with Claude Code /goal).
        // "uncertain" verdicts do NOT auto-continue, so a broken evaluator
        // can't spin the session forever. Delivered as "steer" so the goal
        // notification is never stuck behind the follow-up queue.
        pi.sendUserMessage(
            `[Goal not met] ${lastEval.reason}\nContinue working toward the goal: ${state.condition.description}`,
            { deliverAs: "steer" },
        );
    } else {
        clearPendingGuidance(sessionId);
    }
}

export const goalExtension: ExtensionFactory = (pi) => {
    pi.registerCommand("goal", {
        description: "Set a success condition and optional budget for the session",
        getArgumentCompletions: (prefix: string) => {
            const options = [
                { value: "status", label: "status", description: "Show the active goal and budget" },
                { value: "clear", label: "clear", description: "Clear the active goal" },
            ];
            const p = prefix.trim().toLowerCase();
            const filtered = p ? options.filter((o) => o.value.startsWith(p)) : options;
            return filtered.length ? filtered : null;
        },
        handler: async (args, ctx) => {
            const result = handleGoalCommand(args, ctx, pi);
            pi.sendMessage({
                customType: "goal_status",
                content: result.message,
                display: true,
            });
            broadcastGoalStatus(getSessionId(ctx), getGoal(getSessionId(ctx)), ctx, pi);
            if (result.kickoff && result.state) {
                // Setting a goal starts a turn immediately, with the condition
                // itself as the directive (parity with Claude Code /goal).
                pi.sendUserMessage(
                    `Work toward this goal until it is met: ${result.state.condition.description}`,
                    { deliverAs: "steer" },
                );
            }
        },
    });

    pi.on("session_start", (_event, ctx) => {
        const sessionId = getSessionId(ctx);
        const entries = ctx.sessionManager.getEntries();
        restoreGoal(sessionId, entries as any[]);
        broadcastGoalStatus(sessionId, getGoal(sessionId), ctx, pi);
    });

    pi.on("turn_end", async (event, ctx) => {
        await runGoalStopCheck(event, ctx, pi);
        broadcastGoalStatus(getSessionId(ctx), getGoal(getSessionId(ctx)), ctx, pi);
    });

    pi.on("before_agent_start", async (event, ctx) => {
        const sessionId = getSessionId(ctx);
        const guidance = getPendingGuidance(sessionId);
        if (!guidance) return undefined;

        const systemPrompt = `${event.systemPrompt}\n\n[Goal guidance] The goal has not been met yet. ${guidance}`;
        return { systemPrompt };
    });

    pi.on("session_shutdown", (_event, ctx) => {
        const sessionId = getSessionId(ctx);
        resetSession(sessionId);
        emitGoalStatusChanged(pi, null);
    });
};
