/**
 * `/goal` extension — registers the slash command and manages per-session
 * goal state.
 *
 * Wiring:
 * - `pi.registerCommand("goal", …)` handles the slash command: set a goal,
 *   show status, or clear the active goal.
 * - `session_start` restores any persisted goal from custom entries.
 * - `session_shutdown` clears the in-memory entry for the session.
 *
 * The automatic evaluator hook (turn-end budget checks and goal satisfaction)
 * is intentionally not wired yet; only command parsing and state storage are
 * implemented in this step.
 */
import type { ExtensionAPI, ExtensionCommandContext, ExtensionContext, ExtensionFactory } from "@earendil-works/pi-coding-agent";
import { createLogger } from "@pizzapi/tools";
import {
    clearGoal,
    formatGoalStatus,
    getGoal,
    resetSession,
    restoreGoal,
    setGoal,
} from "./state.js";
import { parseGoalArgs } from "./parser.js";
import type { GoalCommandResult, GoalState } from "./types.js";

const log = createLogger("goal");

function getSessionId(ctx: ExtensionContext): string {
    return process.env.PIZZAPI_SESSION_ID ?? process.env.SESSION_ID ?? ctx.sessionManager.getSessionId() ?? "unknown";
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

    pi.on("session_shutdown", () => {
        const sessionId = process.env.PIZZAPI_SESSION_ID ?? process.env.SESSION_ID ?? "unknown";
        resetSession(sessionId);
    });
};
