/**
 * TypeScript interfaces and state model for the `/goal` extension.
 *
 * These types are intentionally decoupled from upstream pi-coding-agent event
 * types so they can be unit-tested without booting a full agent session.
 */

export type GoalEvaluatorKind = "llm" | "keyword";

export type GoalStatus = "active" | "met" | "failed" | "cancelled";

export type GoalStopReason =
    | "goal_met"
    | "max_turns"
    | "max_tokens"
    | "max_cost"
    | "cancelled"
    | "evaluation_error";

export type GoalVerdict = "met" | "not_met" | "uncertain";

/**
 * The user-declared success condition for the session.
 */
export interface GoalCondition {
    /** Natural-language description of what success looks like. */
    description: string;

    /** Which evaluator engine to use. */
    evaluator: GoalEvaluatorKind;

    /**
     * Optional keywords checked by the keyword evaluator.
     * A match is treated as "met" if any keyword appears in the last
     * assistant message or in tool results from the just-completed turn.
     */
    successKeywords?: string[];
}

/**
 * Budget guardrails. All fields are optional; unset means "no limit".
 */
export interface GoalBudget {
    /** Maximum number of agent turns allowed while pursuing the goal. */
    maxTurns?: number;

    /** Maximum cumulative context/total tokens to spend. */
    maxTokens?: number;

    /** Maximum USD cost to spend (in dollars, e.g. 1.50). */
    maxCost?: number;
}

/**
 * A single evaluator report.
 */
export interface GoalEvaluatorFeedback {
    /** Turn index the evaluation was performed on. */
    turnIndex: number;

    /** Evaluator conclusion. */
    verdict: GoalVerdict;

    /** Human-readable explanation for the verdict. */
    reason: string;

    /** Tokens consumed by the evaluator itself (for cost tracking). */
    tokensUsed?: number;

    /** Cost of the evaluator call in USD. */
    cost?: number;

    /** Model used for the evaluation, if an LLM evaluator ran. */
    model?: { provider: string; id: string };

    /** Epoch milliseconds. */
    timestamp: number;
}

/**
 * Live, per-session goal state.
 */
export interface GoalState {
    /** Stable id so persisted entries can reference the same goal. */
    id: string;

    condition: GoalCondition;

    budget: GoalBudget;

    /** Current lifecycle status of the goal. */
    status: GoalStatus;

    /** Number of completed agent turns since the goal was set. */
    turnCount: number;

    /** Cumulative token spend since the goal was set. */
    tokenSpend: number;

    /** Cumulative cost spend since the goal was set (USD). */
    costSpend: number;

    /** History of evaluator reports. */
    evaluations: GoalEvaluatorFeedback[];

    /** When the goal was created. */
    createdAt: number;

    /** When the goal stopped, if it has stopped. */
    stoppedAt?: number;

    /** Why the goal stopped, if it has stopped. */
    stopReason?: GoalStopReason;

    /** Latest message/tool text snapshot used for evaluation. */
    lastEvaluatedText?: string;
}

/**
 * Serializable subset of GoalState persisted in the session file.
 */
export interface PersistedGoalState {
    version: 1;
    id: string;
    condition: GoalCondition;
    budget: GoalBudget;
    status: GoalStatus;
    turnCount: number;
    tokenSpend: number;
    costSpend: number;
    evaluations: GoalEvaluatorFeedback[];
    createdAt: number;
    stoppedAt?: number;
    stopReason?: GoalStopReason;
}

/**
 * Result of running the stop check.
 */
export interface GoalStopCheck {
    shouldStop: boolean;
    reason?: GoalStopReason;
    message: string;
}

/**
 * Context passed to evaluators.
 */
export interface GoalEvaluationContext {
    /** Plain-text summary of the latest assistant message and tool results. */
    latestTurnText: string;

    /** All prior evaluator feedback for this goal. */
    history: GoalEvaluatorFeedback[];

    /** Current cumulative turn count. */
    turnCount: number;

    /** Cumulative token spend so far. */
    tokenSpend: number;
}

/**
 * Pluggable goal evaluator.
 */
export interface GoalEvaluator {
    evaluate(state: GoalState, context: GoalEvaluationContext): Promise<GoalEvaluatorFeedback>;
}

/**
 * Parsed `/goal` command arguments.
 */
export interface GoalCommandArgs {
    /** Raw condition text as typed by the user. */
    rawCondition: string;

    condition: GoalCondition;
    budget: GoalBudget;

    /** True when the user wants to clear the active goal. */
    clear: boolean;

    /** True when the user wants a status print instead of setting a goal. */
    statusOnly: boolean;
}

/**
 * Outcome returned to the slash command handler.
 */
export interface GoalCommandResult {
    success: boolean;
    message: string;
    state?: GoalState;
}
