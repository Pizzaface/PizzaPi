/**
 * `/goal` extension — registers the slash command and monitors the session.
 *
 * Wiring:
 * - `pi.registerCommand("goal", …)` handles the slash command.
 * - `turn_end` updates turn/token counters, runs the evaluator, and stops if
 *   the goal is met or a budget is exhausted.
 * - `session_start` restores any persisted goal from custom entries.
 * - `session_shutdown` clears the in-memory entry for the session.
 *
 * Stop behavior uses `ctx.shutdown()` so existing `SessionShutdown` / `Stop`
 * hooks run. `ctx.abort()` is used only as an emergency brake if a turn is
 * still streaming when a hard budget is exceeded.
 */
import type { ExtensionAPI, ExtensionCommandContext, ExtensionContext, ExtensionFactory } from "@earendil-works/pi-coding-agent";
import { createLogger } from "@pizzapi/tools";
import {
    checkBudget,
    clearGoal,
    formatGoalStatus,
    getGoal,
    recordEvaluation,
    recordTurnSpend,
    resetSession,
    restoreGoal,
    setGoal,
} from "./state.js";
import { parseGoalArgs } from "./parser.js";
import { chooseEvaluator, extractLatestTurnText } from "./evaluator.js";
import type { GoalCommandResult, GoalState } from "./types.js";

const log = createLogger("goal");

function getSessionId(ctx: ExtensionContext): string {
    return process.env.PIZZAPI_SESSION_ID ?? process.env.SESSION_ID ?? ctx.sessionManager.getSessionId() ?? "unknown";
}

function formatUsageFromMessage(message: any): { tokens: number; cost: number } {
    const usage = message?.usage;
    if (!usage || typeof usage !== "object") return { tokens: 0, cost: 0 };

    const input = typeof usage.input === "number" ? usage.input : 0;
    const output = typeof usage.output === "number" ? usage.output : 0;
    const cacheRead = typeof usage.cacheRead === "number" ? usage.cacheRead : 0;
    const cacheWrite = typeof usage.cacheWrite === "number" ? usage.cacheWrite : 0;
    const total = typeof usage.totalTokens === "number"
        ? usage.totalTokens
        : input + output + cacheRead + cacheWrite;

    const cost = usage.cost?.total;
    return { tokens: Math.max(0, total), cost: typeof cost === "number" ? cost : 0 };
}

function handleGoalCommand(args: string, ctx: ExtensionCommandContext, pi: Pick<ExtensionAPI, "appendEntry">): GoalCommandResult {
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

async function evaluateAndStopIfNeeded(
    sessionId: string,
    turnIndex: number,
    latestTurnText: string,
    ctx: ExtensionContext,
    pi: Pick<ExtensionAPI, "appendEntry">,
): Promise<void> {
    const state = getGoal(sessionId);
    if (!state || state.status !== "active") return;

    const evaluator = chooseEvaluator(state.condition.evaluator);
    const feedback = await evaluator.evaluate(state, {
        latestTurnText,
        history: state.evaluations,
        turnCount: state.turnCount,
        tokenSpend: state.tokenSpend,
    });

    const updated = recordEvaluation(sessionId, feedback, pi);

    if (updated?.status === "met") {
        log.info(`Goal met after ${updated.turnCount} turns: ${updated.condition.description}`);
        ctx.shutdown();
        return;
    }

    const budgetReason = checkBudget(state);
    if (budgetReason) {
        log.info(`Goal budget exceeded (${budgetReason}) after ${state.turnCount} turns`);
        ctx.shutdown();
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
        const sessionId = getSessionId(ctx);
        const usage = formatUsageFromMessage(event.message);
        recordTurnSpend(sessionId, usage.tokens, usage.cost);

        const assistantContent = event.message?.role === "assistant"
            ? event.message.content
            : undefined;

        const latestTurnText = extractLatestTurnText({
            assistantContent,
            toolResults: event.toolResults as any[] | undefined,
        });

        await evaluateAndStopIfNeeded(sessionId, event.turnIndex, latestTurnText, ctx, pi);
    });

    pi.on("session_shutdown", () => {
        const sessionId = process.env.PIZZAPI_SESSION_ID ?? process.env.SESSION_ID ?? "unknown";
        resetSession(sessionId);
    });
};
