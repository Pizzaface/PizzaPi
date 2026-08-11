/**
 * Goal evaluator implementations.
 *
 * This module defines the evaluator interface and ships two implementations:
 *
 * - `keywordGoalEvaluator`: fast, local keyword check.
 * - `createLlmGoalEvaluator(...)`: sends a compact transcript + goal to a
 *   small, fast model (default Anthropic Haiku) and parses a yes/no decision.
 */
import type {
    AssistantMessage,
    Context,
    Model,
    SimpleStreamOptions,
} from "@earendil-works/pi-ai";
import type { ModelRegistry } from "@earendil-works/pi-coding-agent";
import type {
    GoalEvaluationContext,
    GoalEvaluator,
    GoalEvaluatorFeedback,
    GoalState,
    GoalVerdict,
} from "./types.js";

export const DEFAULT_EVALUATOR_MAX_TOKENS = 512;

/**
 * Default cadence (in completed agent runs) for the LLM evaluator when
 * neither `/goal --every` nor `config.goal.evaluateEveryNTurns` is set.
 *
 * Evaluating at every run boundary is the cheap option, not the expensive
 * one: the alternative to one small judge call is steering a whole extra
 * agent run on the session model. `--every N` still throttles it for goals
 * that are known to need many runs.
 */
export const DEFAULT_EVALUATE_EVERY_N_TURNS = 1;

function buildEvaluatorPrompt(state: GoalState, context: GoalEvaluationContext): string {
    const budgetParts: string[] = [];
    if (state.budget.maxTurns !== undefined) budgetParts.push(`turns ≤ ${state.budget.maxTurns}`);
    if (state.budget.maxTokens !== undefined) budgetParts.push(`tokens ≤ ${state.budget.maxTokens.toLocaleString()}`);
    if (state.budget.maxCost !== undefined) budgetParts.push(`cost ≤ $${state.budget.maxCost.toFixed(2)}`);

    return [
        "You are a goal evaluator. Given the session goal and conversation transcript, decide whether the goal has been met.",
        "",
        "Judge only on evidence. An assistant claiming the goal is done is not evidence — look for tool output that demonstrates it (command exit status, test results, file contents, build logs). If the transcript contains only claims, the verdict is \"no\".",
        "",
        `Goal: ${state.condition.description}`,
        budgetParts.length ? `Budget: ${budgetParts.join(", ")}` : "Budget: none",
        `Agent runs so far: ${context.turnCount}`,
        `Tokens spent so far: ${context.tokenSpend.toLocaleString()}`,
        "",
        "Conversation so far:",
        context.transcript || "(no transcript available)",
        "",
        "Latest turn:",
        context.latestTurnText || "(no turn text available)",
        "",
        'Has the goal been met? Reply with a single JSON object using this exact format:\n{"verdict": "yes" or "no", "reason": "short explanation of why the goal is or is not satisfied"}',
    ].join("\n");
}

function isYesVerdict(value: string): boolean {
    return value === "yes" || value === "met" || value === "true";
}

function isNoVerdict(value: string): boolean {
    return value === "no" || value === "not_met" || value === "not met" || value === "false";
}

/**
 * Parse a yes/no decision from the evaluator model.
 *
 * First tries to parse the response as a JSON object with `verdict` and
 * optional `reason` fields. Falls back to the legacy free-text regex logic if
 * JSON parsing fails or the JSON does not contain a usable verdict.
 *
 * Accepts "yes" / "no", "met" / "not_met" / "not met" as synonyms.
 */
export function parseLlmVerdict(raw: string): { verdict: GoalVerdict; reason: string } {
    const text = raw.trim();
    const lower = text.toLowerCase();

    // 1. Try structured JSON output first. Candidates are tried widest-first
    // so a `reason` containing braces (`"fixed the {x} handler"`) still
    // parses — a lone non-greedy match would truncate at the inner brace.
    for (const candidate of jsonCandidates(text)) {
        try {
            const parsed = JSON.parse(candidate);
            if (parsed && typeof parsed === "object" && typeof parsed.verdict === "string") {
                const verdict = parsed.verdict.toLowerCase().trim();
                if (isYesVerdict(verdict) || isNoVerdict(verdict)) {
                    const reason = typeof parsed.reason === "string" ? parsed.reason.trim() : "";
                    return {
                        verdict: isYesVerdict(verdict) ? "met" : "not_met",
                        reason,
                    };
                }
            }
        } catch {
            // Not valid JSON; try the next candidate.
        }
    }

    const firstLine = text.split("\n")[0] ?? text;

    if (isNegative(firstLine)) return { verdict: "not_met", reason: extractReason(text) };
    if (isPositive(firstLine)) return { verdict: "met", reason: extractReason(text) };

    // Fallback: scan the whole response for a clear yes/no.
    if (isNegative(lower)) return { verdict: "not_met", reason: extractReason(text) };
    if (isPositive(lower)) return { verdict: "met", reason: extractReason(text) };

    return {
        verdict: "uncertain",
        reason: `Could not parse a yes/no decision. Model said: ${text.slice(0, 200)}`,
    };
}

/**
 * Free-text negative detection. Catches "no", "not_met", and negated forms of
 * "met" such as "not met", "not been met", "not yet met", "hasn't been met" —
 * these must be checked before any positive \bmet\b match to avoid parsing
 * "the goal has not been met" as met.
 */
/**
 * Candidate JSON substrings from a model response, widest first: the span
 * from the first `{` to the last `}` (handles nested/brace-containing
 * values), then the shortest leading object (handles trailing prose that
 * itself contains braces).
 */
function jsonCandidates(text: string): string[] {
    const start = text.indexOf("{");
    if (start === -1) return [];

    const candidates: string[] = [];
    const lastEnd = text.lastIndexOf("}");
    if (lastEnd > start) candidates.push(text.slice(start, lastEnd + 1));

    const shortest = text.slice(start).match(/\{[\s\S]*?\}/);
    if (shortest && shortest[0] !== candidates[0]) candidates.push(shortest[0]);

    return candidates;
}

function isNegative(text: string): boolean {
    return (
        /\bno\b/i.test(text) ||
        /\bnot_met\b/i.test(text) ||
        /\b(?:not|never)\b[\s\S]{0,30}?\bmet\b/i.test(text) ||
        /n't\b[\s\S]{0,30}?\bmet\b/i.test(text)
    );
}

function isPositive(text: string): boolean {
    return /\byes\b/i.test(text) || /\bmet\b/i.test(text);
}

function extractReason(text: string): string {
    const withoutDecision = text.replace(/^Decision:.*$/im, "").trim();
    const reason = withoutDecision.replace(/^Reason:\s*/im, "").trim();
    return reason || withoutDecision || text;
}

export function extractAssistantText(message: AssistantMessage): string {
    return message.content
        .filter((c): c is { type: "text"; text: string } => c.type === "text" && typeof c.text === "string")
        .map((c) => c.text)
        .join("\n")
        .trim();
}

export interface LlmEvaluatorDeps {
    /** Function that performs a simple model completion. */
    completeSimple: (model: Model<any>, context: Context, options?: SimpleStreamOptions) => Promise<AssistantMessage>;
    /** The small model to call. */
    model: Model<any>;
    /** Optional API key override. */
    apiKey?: string;
    /** Maximum output tokens for the evaluator call. */
    maxTokens?: number;
    /** Optional abort signal for the model call. */
    signal?: AbortSignal;
}

/**
 * Create an LLM-based goal evaluator backed by a small, fast model.
 */
export function createLlmGoalEvaluator(deps: LlmEvaluatorDeps): GoalEvaluator {
    return {
        async evaluate(state, context): Promise<GoalEvaluatorFeedback> {
            const prompt = buildEvaluatorPrompt(state, context);
            const messages: Context["messages"] = [
                {
                    role: "user",
                    content: prompt,
                    timestamp: Date.now(),
                },
            ];
            const modelContext: Context = { messages };
            const options: SimpleStreamOptions = {
                maxTokens: deps.maxTokens ?? DEFAULT_EVALUATOR_MAX_TOKENS,
            };
            if (deps.apiKey) options.apiKey = deps.apiKey;
            if (deps.signal) options.signal = deps.signal;

            try {
                const response = await deps.completeSimple(deps.model, modelContext, options);
                const text = response.errorMessage
                    ? `Model error: ${response.errorMessage}`
                    : extractAssistantText(response);
                const parsed = parseLlmVerdict(text);

                return {
                    turnIndex: context.turnCount,
                    verdict: parsed.verdict,
                    reason: parsed.reason,
                    tokensUsed: response.usage?.totalTokens,
                    cost: response.usage?.cost?.total,
                    model: { provider: deps.model.provider, id: deps.model.id },
                    timestamp: Date.now(),
                };
            } catch (err) {
                return {
                    turnIndex: context.turnCount,
                    verdict: "uncertain",
                    reason: `Evaluator model call failed: ${err instanceof Error ? err.message : String(err)}`,
                    timestamp: Date.now(),
                };
            }
        },
    };
}

/**
 * Resolve a small, fast model to use for goal evaluation.
 *
 * If a model is configured (as `provider:modelId` or just `modelId`), it is
 * tried first. Otherwise the registry is searched for the cheapest available
 * text model that has configured auth. This avoids hardcoding Anthropic IDs
 * and works with any provider the user has set up.
 *
 * The session's own model is deliberately NOT preferred. The evaluator sends
 * a standalone prompt that shares no prefix with the session context, so
 * there is no prompt cache to hit — defaulting to the session model just
 * bills a 60k-char transcript against (potentially) the most expensive model
 * available. Set `config.goal.evaluatorModel` to pin a specific judge.
 */
export async function resolveEvaluatorModel(
    registry: ModelRegistry,
    configured?: string,
): Promise<{ model: Model<any>; apiKey?: string } | undefined> {
    let candidates: Model<any>[] = [];

    if (configured) {
        const [providerPart, idPart] = configured.includes(":") ? configured.split(":") : [undefined, configured];
        candidates = registry.getAll().filter((m) => {
            if (providerPart && m.provider !== providerPart) return false;
            return m.id === idPart;
        });
        // A configured-but-unusable model shouldn't silently disable the
        // evaluator; fall back to the cheapest authenticated text model.
        candidates = candidates.concat(findSmallFastModels(registry));
    } else {
        candidates = findSmallFastModels(registry);
    }

    for (const model of candidates) {
        if (!registry.hasConfiguredAuth(model)) continue;
        const auth = await registry.getApiKeyAndHeaders(model);
        if (!auth.ok) continue;
        return { model, apiKey: auth.apiKey };
    }

    return undefined;
}

function findSmallFastModels(registry: ModelRegistry): Model<any>[] {
    return registry
        .getAll()
        .filter((m) => m.input.includes("text") && !m.reasoning)
        .sort((a, b) => {
            const aCost = a.cost.input + a.cost.output;
            const bCost = b.cost.input + b.cost.output;
            if (aCost !== bCost) return aCost - bCost;
            return a.contextWindow - b.contextWindow;
        });
}

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

