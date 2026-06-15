/**
 * Runtime state management for the `/goal` extension.
 *
 * Goals are tracked per-session in memory. Each mutation also writes a
 * `customType: "goal_state"` entry to the session file via `appendEntry` so
 * the goal survives session reload/resume.
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type {
    GoalBudget,
    GoalCommandResult,
    GoalCondition,
    GoalEvaluatorFeedback,
    GoalState,
    GoalStatus,
    GoalStopReason,
    PersistedGoalState,
} from "./types.js";

export const GOAL_STATE_CUSTOM_TYPE = "goal_state";

/** In-memory goal state keyed by session id. */
const goalsBySessionId = new Map<string, GoalState>();

function generateGoalId(): string {
    return `goal_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
}

function createGoalState(condition: GoalCondition, budget: GoalBudget): GoalState {
    return {
        id: generateGoalId(),
        condition,
        budget,
        status: "active",
        turnCount: 0,
        tokenSpend: 0,
        costSpend: 0,
        evaluations: [],
        createdAt: Date.now(),
    };
}

function toPersisted(state: GoalState): PersistedGoalState {
    return {
        version: 1,
        id: state.id,
        condition: state.condition,
        budget: state.budget,
        status: state.status,
        turnCount: state.turnCount,
        tokenSpend: state.tokenSpend,
        costSpend: state.costSpend,
        evaluations: state.evaluations,
        createdAt: state.createdAt,
        stoppedAt: state.stoppedAt,
        stopReason: state.stopReason,
    };
}

export function fromPersisted(persisted: PersistedGoalState): GoalState {
    return {
        ...persisted,
        lastEvaluatedText: undefined,
    };
}

/**
 * Set or replace the active goal for a session.
 */
export function setGoal(
    sessionId: string,
    condition: GoalCondition,
    budget: GoalBudget,
    pi: Pick<ExtensionAPI, "appendEntry">,
): GoalState {
    const state = createGoalState(condition, budget);
    goalsBySessionId.set(sessionId, state);
    persist(state, pi);
    return state;
}

/**
 * Cancel the active goal for a session.
 */
export function clearGoal(
    sessionId: string,
    pi: Pick<ExtensionAPI, "appendEntry">,
): GoalCommandResult {
    const existing = goalsBySessionId.get(sessionId);
    if (!existing || existing.status !== "active") {
        return { success: true, message: "No active goal to clear." };
    }

    existing.status = "cancelled";
    existing.stoppedAt = Date.now();
    existing.stopReason = "cancelled";
    persist(existing, pi);
    return { success: true, message: "Goal cancelled." };
}

/**
 * Retrieve the active (or most recent) goal for a session.
 */
export function getGoal(sessionId: string): GoalState | undefined {
    return goalsBySessionId.get(sessionId);
}

/**
 * Increment counters for a completed turn.
 */
export function recordTurnSpend(
    sessionId: string,
    turnTokens: number,
    turnCost: number,
): GoalState | undefined {
    const state = goalsBySessionId.get(sessionId);
    if (!state || state.status !== "active") return undefined;

    state.turnCount += 1;
    state.tokenSpend += Math.max(0, turnTokens);
    state.costSpend += Math.max(0, turnCost);
    return state;
}

/**
 * Append an evaluator feedback entry.
 */
export function recordEvaluation(
    sessionId: string,
    feedback: GoalEvaluatorFeedback,
    pi: Pick<ExtensionAPI, "appendEntry">,
): GoalState | undefined {
    const state = goalsBySessionId.get(sessionId);
    if (!state || state.status !== "active") return undefined;

    state.evaluations.push(feedback);
    if (feedback.cost) state.costSpend += feedback.cost;
    if (feedback.tokensUsed) state.tokenSpend += feedback.tokensUsed;

    if (feedback.verdict === "met" && state.status === "active") {
        markStopped(state, "goal_met");
    }

    persist(state, pi);
    return state;
}

/**
 * Check budget guardrails. Returns a stop reason if a limit is exceeded.
 */
export function checkBudget(state: GoalState): GoalStopReason | undefined {
    if (state.status !== "active") return undefined;

    if (state.budget.maxTurns !== undefined && state.turnCount >= state.budget.maxTurns) {
        markStopped(state, "max_turns");
        return "max_turns";
    }

    if (state.budget.maxTokens !== undefined && state.tokenSpend >= state.budget.maxTokens) {
        markStopped(state, "max_tokens");
        return "max_tokens";
    }

    if (state.budget.maxCost !== undefined && state.costSpend >= state.budget.maxCost) {
        markStopped(state, "max_cost");
        return "max_cost";
    }

    return undefined;
}

function markStopped(state: GoalState, reason: GoalStopReason): void {
    state.status = mapStopReasonToStatus(reason);
    state.stoppedAt = Date.now();
    state.stopReason = reason;
}

function mapStopReasonToStatus(reason: GoalStopReason): GoalStatus {
    if (reason === "goal_met") return "met";
    if (reason === "cancelled") return "cancelled";
    return "failed";
}

/**
 * Persist the current state to the session file.
 */
export function persist(state: GoalState, pi: Pick<ExtensionAPI, "appendEntry">): void {
    pi.appendEntry(GOAL_STATE_CUSTOM_TYPE, toPersisted(state));
}

/**
 * Reset in-memory state. Useful on session shutdown in long-lived processes.
 */
export function resetSession(sessionId: string): void {
    goalsBySessionId.delete(sessionId);
}

/**
 * Restore the latest persisted goal for a session, if any.
 */
export function restoreGoal(
    sessionId: string,
    entries: Array<{ type: string; customType?: string; data?: unknown }>,
): GoalState | undefined {
    let latest: PersistedGoalState | undefined;

    for (const entry of entries) {
        if (entry.type !== "custom" || entry.customType !== GOAL_STATE_CUSTOM_TYPE) continue;
        const data = entry.data as PersistedGoalState | undefined;
        if (data && data.version === 1 && (!latest || (data.createdAt ?? 0) > (latest.createdAt ?? 0))) {
            latest = data;
        }
    }

    if (!latest || latest.status === "cancelled" || latest.status === "met") {
        return undefined;
    }

    const state = fromPersisted(latest);
    goalsBySessionId.set(sessionId, state);
    return state;
}

/**
 * Human-readable summary of a goal.
 */
export function formatGoalStatus(state: GoalState): string {
    const budgetParts: string[] = [];
    if (state.budget.maxTurns !== undefined) budgetParts.push(`turns ≤ ${state.budget.maxTurns}`);
    if (state.budget.maxTokens !== undefined) budgetParts.push(`tokens ≤ ${state.budget.maxTokens.toLocaleString()}`);
    if (state.budget.maxCost !== undefined) budgetParts.push(`cost ≤ $${state.budget.maxCost.toFixed(2)}`);

    return [
        `Goal: ${state.condition.description}`,
        `Status: ${state.status}`,
        `Turns: ${state.turnCount}`,
        `Tokens: ${state.tokenSpend.toLocaleString()}`,
        `Cost: $${state.costSpend.toFixed(4)}`,
        budgetParts.length ? `Budget: ${budgetParts.join(", ")}` : "Budget: none",
        state.stopReason ? `Stopped: ${state.stopReason}` : undefined,
    ]
        .filter(Boolean)
        .join("\n");
}
