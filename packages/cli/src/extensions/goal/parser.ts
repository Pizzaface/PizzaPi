/**
 * Argument parser for the `/goal` slash command.
 *
 * Examples:
 *   /goal "the tests pass" --max-turns 20 --max-cost 5
 *   /goal fix the Dockerfile --evaluator keyword --keyword "build succeeded"
 *   /goal status
 *   /goal clear
 */
import type { GoalBudget, GoalCommandArgs, GoalCondition, GoalEvaluatorKind } from "./types.js";

const KNOWN_FLAGS = new Set([
    "--max-turns",
    "--max-tokens",
    "--max-cost",
    "--evaluator",
    "--keyword",
    "--every",
    "--min-turns",
]);

function isFlag(token: string): boolean {
    return token.startsWith("--");
}

/**
 * Budget values must be > 0. A zero budget is already exhausted the moment
 * the goal starts, so `/goal "x" --max-turns 0` would set a goal that
 * immediately reports "budget reached" — always a typo, never intent.
 */
function parsePositiveNumber(value: string, label: string): number {
    const parsed = Number(value);
    if (!Number.isFinite(parsed) || parsed <= 0) {
        throw new Error(`${label} must be a positive number, got "${value}"`);
    }
    return parsed;
}

function parsePositiveInt(value: string, label: string): number {
    const parsed = Number(value);
    if (!Number.isInteger(parsed) || parsed < 1) {
        throw new Error(`${label} must be a positive integer, got "${value}"`);
    }
    return parsed;
}

/**
 * Tokenize a `/goal` command line. Supports double-quoted strings and bare
 * words. Does not implement full shell quoting; it is enough for slash-command
 * ergonomics.
 */
export function tokenizeGoalArgs(input: string): string[] {
    const tokens: string[] = [];
    let current = "";
    let inQuotes = false;

    for (const ch of input) {
        if (ch === '"') {
            inQuotes = !inQuotes;
            continue;
        }
        if (ch === " " && !inQuotes) {
            if (current.length > 0) {
                tokens.push(current);
                current = "";
            }
            continue;
        }
        current += ch;
    }
    if (current.length > 0) tokens.push(current);
    return tokens;
}

export function parseGoalArgs(input: string): GoalCommandArgs {
    const tokens = tokenizeGoalArgs(input.trim());

    if (tokens.length === 0) {
        return { rawCondition: "", condition: { description: "", evaluator: "keyword" }, budget: {}, clear: false, statusOnly: true };
    }

    const CLEAR_ALIASES = new Set(["clear", "stop", "off", "cancel", "reset", "none"]);
    const first = tokens[0]!;
    if (CLEAR_ALIASES.has(first)) {
        return { rawCondition: first, condition: { description: first, evaluator: "keyword" }, budget: {}, clear: true, statusOnly: false };
    }
    if (first === "status") {
        return { rawCondition: "status", condition: { description: "status", evaluator: "keyword" }, budget: {}, clear: false, statusOnly: true };
    }

    const budget: GoalBudget = {};
    const successKeywords: string[] = [];
    let evaluator: GoalEvaluatorKind = "llm";
    let evaluateEveryNTurns: number | undefined;
    let minTurnsBeforeEvaluate: number | undefined;
    let conditionParts: string[] = [];

    let i = 0;
    while (i < tokens.length) {
        const token = tokens[i]!;

        if (isFlag(token)) {
            if (!KNOWN_FLAGS.has(token)) {
                // Unknown "--flags" are condition text, not errors — conditions
                // like "fix the --dry-run handling" must not throw.
                conditionParts.push(token);
                i += 1;
                continue;
            }
            const next = tokens[i + 1];
            if (next === undefined || isFlag(next)) {
                throw new Error(`${token} requires a value`);
            }
            i += 1;

            switch (token) {
                case "--max-turns":
                    budget.maxTurns = parsePositiveNumber(next, "--max-turns");
                    break;
                case "--max-tokens":
                    budget.maxTokens = parsePositiveNumber(next, "--max-tokens");
                    break;
                case "--max-cost":
                    budget.maxCost = parsePositiveNumber(next, "--max-cost");
                    break;
                case "--evaluator":
                    if (next !== "llm" && next !== "keyword") {
                        throw new Error('--evaluator must be "llm" or "keyword"');
                    }
                    evaluator = next;
                    break;
                case "--keyword":
                    successKeywords.push(next);
                    break;
                case "--every":
                    // How often (in completed agent runs) to invoke the LLM
                    // evaluator. It's a billed API call; --every N throttles it
                    // for goals known to need many runs. No effect on the
                    // free/local keyword evaluator.
                    evaluateEveryNTurns = parsePositiveInt(next, "--every");
                    break;
                case "--min-turns":
                    // Minimum completed agent runs before the evaluator may
                    // run. Prevents premature judgment while the agent is still
                    // getting started.
                    minTurnsBeforeEvaluate = parsePositiveInt(next, "--min-turns");
                    break;
            }
        } else {
            conditionParts.push(token);
        }

        i += 1;
    }

    const rawCondition = conditionParts.join(" ").trim();
    if (!rawCondition) {
        throw new Error("A goal condition is required. Example: /goal \"the tests pass\"");
    }

    // A keyword evaluator with no keywords can never be met — with the goal
    // loop auto-continuing on not_met, that would run forever. Reject early.
    if (evaluator === "keyword" && successKeywords.length === 0) {
        throw new Error('--evaluator keyword requires at least one --keyword. Example: /goal "build passes" --evaluator keyword --keyword "build succeeded"');
    }

    const condition: GoalCondition = {
        description: rawCondition,
        evaluator,
        successKeywords: successKeywords.length > 0 ? successKeywords : undefined,
        evaluateEveryNTurns,
        minTurnsBeforeEvaluate,
    };

    return { rawCondition, condition, budget, clear: false, statusOnly: false };
}
