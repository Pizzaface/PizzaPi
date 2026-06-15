/**
 * Goal evaluator implementations.
 *
 * This module defines the evaluator interface and ships a deterministic
 * keyword evaluator. The LLM evaluator is intentionally a stub: wiring a
 * side-call to a model requires provider-specific plumbing that is out of
 * scope for the initial interface design.
 */
import type {
    GoalEvaluationContext,
    GoalEvaluator,
    GoalEvaluatorFeedback,
    GoalState,
} from "./types.js";

function buildEvaluatorMessage(state: GoalState, context: GoalEvaluationContext): string {
    return [
        `Goal: ${state.condition.description}`,
        `Turns so far: ${context.turnCount}`,
        `Tokens spent so far: ${context.tokenSpend}`,
        "",
        "Latest turn:",
        context.latestTurnText,
        "",
        "Has the goal been met? Reply with exactly one of: met, not_met, uncertain.",
        "Then explain your reasoning on the next line.",
    ].join("\n");
}

/**
 * Stub LLM evaluator.
 *
 * In a full implementation this would call a cheap model through the same
 * provider abstraction used by the agent, parse the verdict, and return a
 * feedback object. For now it always reports "not_met" so the integration
 * wiring can be tested without burning API credits.
 */
export const llmGoalEvaluator: GoalEvaluator = {
    async evaluate(state, context): Promise<GoalEvaluatorFeedback> {
        const prompt = buildEvaluatorMessage(state, context);
        // TODO: replace with provider-specific model call.
        void prompt;

        return {
            turnIndex: context.turnCount,
            verdict: "not_met",
            reason: "LLM evaluator is not yet wired; defaulting to not_met.",
            timestamp: Date.now(),
        };
    },
};

/**
 * Simple deterministic evaluator: if any success keyword appears in the
 * latest turn text, the goal is met.
 */
export const keywordGoalEvaluator: GoalEvaluator = {
    async evaluate(state, context): Promise<GoalEvaluatorFeedback> {
        const keywords = state.condition.successKeywords ?? [];
        const haystack = context.latestTurnText.toLowerCase();
        const hit = keywords.find((k) => haystack.includes(k.toLowerCase()));

        return {
            turnIndex: context.turnCount,
            verdict: hit ? "met" : "not_met",
            reason: hit
                ? `Keyword "${hit}" found in the latest turn.`
                : keywords.length
                    ? `None of the success keywords (${keywords.join(", ")}) were found.`
                    : "No success keywords configured.",
            timestamp: Date.now(),
        };
    },
};

export function chooseEvaluator(kind: "llm" | "keyword"): GoalEvaluator {
    return kind === "llm" ? llmGoalEvaluator : keywordGoalEvaluator;
}

/**
 * Extract a plain-text snapshot of the latest turn for evaluation.
 *
 * This is a best-effort concatenation of assistant message text and tool
 * result text. It intentionally avoids depending on upstream message types
 * so it can be unit-tested.
 */
export function extractLatestTurnText(payload: {
    assistantText?: string;
    assistantContent?: string | Array<{ type: string; text?: string }>;
    toolResults?: Array<{ content?: Array<{ type: string; text?: string }>; text?: string }>;
}): string {
    const parts: string[] = [];
    if (payload.assistantText) {
        parts.push(payload.assistantText);
    } else if (payload.assistantContent) {
        if (typeof payload.assistantContent === "string") {
            parts.push(payload.assistantContent);
        } else {
            const joined = payload.assistantContent
                .filter((c): c is { type: string; text: string } => c.type === "text" && typeof c.text === "string")
                .map((c) => c.text)
                .join("\n");
            if (joined) parts.push(joined);
        }
    }

    for (const tool of payload.toolResults ?? []) {
        const text = tool.text;
        if (text) {
            parts.push(text);
            continue;
        }
        const joined = (tool.content ?? [])
            .filter((c): c is { type: string; text: string } => c.type === "text" && typeof c.text === "string")
            .map((c) => c.text)
            .join("\n");
        if (joined) parts.push(joined);
    }

    return parts.join("\n\n");
}
