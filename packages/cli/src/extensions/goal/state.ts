/**
 * Runtime state management for the `/goal` extension.
 *
 * Goals are tracked per-session in memory. Each mutation also writes a
 * `customType: "goal_state"` entry to the session file via `appendEntry` so
 * the goal survives session reload/resume.
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { MetaGoalStatus } from "@pizzapi/protocol";
import type {
    GoalBudget,
    GoalCommandResult,
    GoalCondition,
    GoalEvaluatorFeedback,
    GoalState,
    GoalStatus,
    GoalStopReason,
} from "./types.js";

export const GOAL_STATE_CUSTOM_TYPE = "goal_state";

/**
 * Custom entry type for a single evaluator API call's cost/tokens. Written
 * as a delta (not cumulative) so the usage scanner can sum it directly —
 * unlike `goal_state`, which persists a running total and would double-count
 * if summed across entries. The evaluator call is a real, separate API
 * request (not part of the normal turn), so without this the /goal LLM
 * evaluator's spend is invisible to the Usage dashboard.
 */
export const GOAL_EVALUATOR_USAGE_CUSTOM_TYPE = "goal_evaluator_usage";

/** In-memory goal state keyed by session id. */
const goalsBySessionId = new Map<string, GoalState>();

/** Pending evaluator guidance to inject into the next turn's system prompt. */
const pendingGuidanceBySessionId = new Map<string, string>();

/** Goals that have stopped are kept in memory for 24 hours, then pruned. */
const STOPPED_GOAL_RETENTION_MS = 24 * 60 * 60 * 1000;

/**
 * Only the most recent evaluations are kept. The full state is persisted to
 * the session file on every evaluation, so an unbounded history means O(n²)
 * file growth on long-running goals. Nothing reads more than the latest entry.
 */
const MAX_EVALUATIONS = 20;

function generateGoalId(): string {
    return `goal_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
}

function createGoalState(condition: GoalCondition, budget: GoalBudget): GoalState {
    return {
        id: generateGoalId(),
        version: 1,
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

/**
 * Remove stale stopped goals from the in-memory map. Active goals are never
 * pruned. Call this whenever the map is mutated (setGoal / restoreGoal) so
 * long-lived processes don't accumulate dead entries.
 */
function cleanupStaleGoals(): void {
    const cutoff = Date.now() - STOPPED_GOAL_RETENTION_MS;
    for (const [sessionId, state] of goalsBySessionId) {
        if (state.status !== "active" && state.stoppedAt !== undefined && state.stoppedAt < cutoff) {
            goalsBySessionId.delete(sessionId);
        }
    }
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
    clearPendingGuidance(sessionId);
    cleanupStaleGoals();
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

    clearPendingGuidance(sessionId);
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
    if (state.evaluations.length > MAX_EVALUATIONS) {
        state.evaluations.splice(0, state.evaluations.length - MAX_EVALUATIONS);
    }
    if (feedback.cost) state.costSpend += Math.max(0, feedback.cost);
    if (feedback.tokensUsed) state.tokenSpend += feedback.tokensUsed;

    if (feedback.cost || feedback.tokensUsed) {
        pi.appendEntry(GOAL_EVALUATOR_USAGE_CUSTOM_TYPE, {
            provider: feedback.model?.provider ?? "unknown",
            model: feedback.model?.id ?? "unknown",
            tokens: feedback.tokensUsed ?? 0,
            cost: feedback.cost ?? 0,
            timestamp: feedback.timestamp,
        });
    }

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
    pi.appendEntry(GOAL_STATE_CUSTOM_TYPE, state);
}

/**
 * Reset in-memory state. Useful on session shutdown in long-lived processes.
 */
export function resetSession(sessionId: string): void {
    goalsBySessionId.delete(sessionId);
    pendingGuidanceBySessionId.delete(sessionId);
}

/**
 * Store evaluator guidance for the next turn.
 */
export function setPendingGuidance(sessionId: string, guidance: string): void {
    pendingGuidanceBySessionId.set(sessionId, guidance);
}

/**
 * Retrieve any pending guidance for the next turn.
 */
export function getPendingGuidance(sessionId: string): string | undefined {
    return pendingGuidanceBySessionId.get(sessionId);
}

/**
 * Clear pending guidance (e.g. after applying it or cancelling the goal).
 */
export function clearPendingGuidance(sessionId: string): void {
    pendingGuidanceBySessionId.delete(sessionId);
}

/**
 * Scan session entries for the most recent persisted `goal_state` entry,
 * regardless of its lifecycle status.
 */
function findLatestGoalState(
    entries: Array<{ type?: string; customType?: string; data?: unknown }>,
): GoalState | undefined {
    let latest: GoalState | undefined;

    for (const entry of entries) {
        if (entry.type !== "custom" || entry.customType !== GOAL_STATE_CUSTOM_TYPE) continue;
        const data = entry.data as GoalState | undefined;
        if (data && data.version === 1 && (!latest || (data.createdAt ?? 0) > (latest.createdAt ?? 0))) {
            latest = data;
        }
    }

    return latest;
}

/**
 * Restore the latest persisted goal for a session, if any.
 */
export function restoreGoal(
    sessionId: string,
    entries: Array<{ type: string; customType?: string; data?: unknown }>,
): GoalState | undefined {
    const latest = findLatestGoalState(entries);

    if (!latest || latest.status === "cancelled" || latest.status === "met") {
        return undefined;
    }

    cleanupStaleGoals();
    const state = latest;
    goalsBySessionId.set(sessionId, state);
    return state;
}

/**
 * Build the serializable goal status payload forwarded to the web UI.
 */
export function toMetaGoalStatus(state: GoalState): MetaGoalStatus {
    const lastEval = state.evaluations.at(-1);
    return {
        id: state.id,
        description: state.condition.description,
        status: state.status,
        turnCount: state.turnCount,
        maxTurns: state.budget.maxTurns,
        tokenSpend: state.tokenSpend,
        maxTokens: state.budget.maxTokens,
        costSpend: state.costSpend,
        maxCost: state.budget.maxCost,
        lastReason: lastEval?.reason,
    };
}

/**
 * Scan session entries for the most recent active persisted goal.
 */
export function getActiveGoalFromEntries(
    entries: Array<{ type?: string; customType?: string; data?: unknown }>,
): GoalState | undefined {
    const latest = findLatestGoalState(entries);
    if (!latest || latest.status !== "active") return undefined;
    return latest;
}

/**
 * Single-line status for the TUI footer / status bar.
 */
export function formatCompactGoalStatus(state: GoalState): string {
    const parts = ["◎ /goal active"];

    if (state.budget.maxTurns !== undefined) {
        parts.push(`turn ${state.turnCount}/${state.budget.maxTurns}`);
    } else {
        parts.push(`turn ${state.turnCount}`);
    }

    const lastEval = state.evaluations.at(-1);
    if (lastEval?.verdict === "not_met" && lastEval.reason) {
        const reason = lastEval.reason.replace(/\s+/g, " ").trim();
        parts.push(reason.length > 60 ? `${reason.slice(0, 57)}...` : reason);
    }

    return parts.join(" · ");
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
