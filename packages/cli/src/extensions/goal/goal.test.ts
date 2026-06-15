/**
 * Unit tests for the `/goal` parser and state module.
 */
import { describe, expect, test } from "bun:test";
import { parseGoalArgs, tokenizeGoalArgs } from "./parser.js";
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
import { keywordGoalEvaluator } from "./evaluator.js";
import type { GoalState } from "./types.js";

function fakeAppendEntry(_customType: string, _data: unknown): void {
    /* no-op for tests */
}

function makeGoal(): GoalState {
    return setGoal(
        "session-1",
        { description: "the tests pass", evaluator: "keyword", successKeywords: ["tests pass"] },
        { maxTurns: 3, maxTokens: 1000 },
        { appendEntry: fakeAppendEntry },
    );
}

describe("tokenizeGoalArgs", () => {
    test("splits bare words", () => {
        expect(tokenizeGoalArgs("foo bar baz")).toEqual(["foo", "bar", "baz"]);
    });

    test("honors double quotes", () => {
        expect(tokenizeGoalArgs('foo "bar baz" qux')).toEqual(["foo", "bar baz", "qux"]);
    });

    test("trims extra spaces", () => {
        expect(tokenizeGoalArgs("  foo   bar  ")).toEqual(["foo", "bar"]);
    });
});

describe("parseGoalArgs", () => {
    test("parses a plain condition", () => {
        const parsed = parseGoalArgs("the tests pass");
        expect(parsed.rawCondition).toBe("the tests pass");
        expect(parsed.condition.evaluator).toBe("llm");
        expect(parsed.budget).toEqual({});
    });

    test("parses budgets and keywords", () => {
        const parsed = parseGoalArgs('"the tests pass" --max-turns 10 --max-tokens 50000 --evaluator keyword --keyword "tests pass"');
        expect(parsed.rawCondition).toBe("the tests pass");
        expect(parsed.condition.evaluator).toBe("keyword");
        expect(parsed.condition.successKeywords).toEqual(["tests pass"]);
        expect(parsed.budget).toEqual({ maxTurns: 10, maxTokens: 50000 });
    });

    test("treats bare /goal as status", () => {
        const parsed = parseGoalArgs("");
        expect(parsed.statusOnly).toBe(true);
    });

    test("treats /goal status as status", () => {
        const parsed = parseGoalArgs("status");
        expect(parsed.statusOnly).toBe(true);
    });

    test.each([["clear"], ["stop"], ["off"], ["cancel"], ["reset"], ["none"]])("treats /goal %s as clear", (alias) => {
        const parsed = parseGoalArgs(alias);
        expect(parsed.clear).toBe(true);
        expect(parsed.statusOnly).toBe(false);
    });

    test("rejects unknown flags", () => {
        expect(() => parseGoalArgs("foo --unknown bar")).toThrow("Unknown flag: --unknown");
    });

    test("rejects missing condition", () => {
        expect(() => parseGoalArgs("--max-turns 5")).toThrow("A goal condition is required");
    });
});

describe("goal state", () => {
    test("setGoal stores active state", () => {
        resetSession("session-1");
        const state = makeGoal();
        expect(state.condition.description).toBe("the tests pass");
        expect(state.status).toBe("active");
        expect(getGoal("session-1")?.id).toBe(state.id);
    });

    test("recordTurnSpend increments counters", () => {
        resetSession("session-1");
        makeGoal();
        const updated = recordTurnSpend("session-1", 123, 0.001);
        expect(updated?.turnCount).toBe(1);
        expect(updated?.tokenSpend).toBe(123);
        expect(updated?.costSpend).toBe(0.001);
    });

    test("keyword evaluator marks goal met", async () => {
        resetSession("session-1");
        makeGoal();
        recordTurnSpend("session-1", 10, 0);
        const feedback = await keywordGoalEvaluator.evaluate(getGoal("session-1")!, {
            latestTurnText: "All tests pass!",
            history: [],
            turnCount: 1,
            tokenSpend: 10,
        });
        expect(feedback.verdict).toBe("met");
        const state = recordEvaluation("session-1", feedback, { appendEntry: fakeAppendEntry });
        expect(state?.status).toBe("met");
        expect(state?.stopReason).toBe("goal_met");
    });

    test("max turns budget stops the goal", () => {
        resetSession("session-1");
        makeGoal();
        recordTurnSpend("session-1", 1, 0);
        recordTurnSpend("session-1", 1, 0);
        const state = recordTurnSpend("session-1", 1, 0);
        expect(state?.turnCount).toBe(3);
        expect(checkBudget(state!)).toBe("max_turns");
        expect(state?.status).toBe("failed");
    });

    test("max tokens budget stops the goal", () => {
        resetSession("session-1");
        makeGoal();
        const state = recordTurnSpend("session-1", 1000, 0);
        expect(checkBudget(state!)).toBe("max_tokens");
    });

    test("clearGoal cancels active goal", () => {
        resetSession("session-1");
        makeGoal();
        const result = clearGoal("session-1", { appendEntry: fakeAppendEntry });
        expect(result.success).toBe(true);
        expect(getGoal("session-1")?.status).toBe("cancelled");
    });

    test("restoreGoal loads latest persisted active goal", () => {
        resetSession("session-1");
        const persisted = {
            version: 1 as const,
            id: "goal_123",
            condition: { description: "foo", evaluator: "keyword" as const },
            budget: { maxTurns: 5 },
            status: "active" as const,
            turnCount: 2,
            tokenSpend: 100,
            costSpend: 0,
            evaluations: [],
            createdAt: 1,
        };
        const restored = restoreGoal("session-1", [
            { type: "custom", customType: "goal_state", data: persisted },
        ]);
        expect(restored?.id).toBe("goal_123");
        expect(restored?.turnCount).toBe(2);
    });

    test("formatGoalStatus renders budgets", () => {
        resetSession("session-1");
        const state = makeGoal();
        const text = formatGoalStatus(state);
        expect(text).toContain("Goal: the tests pass");
        expect(text).toContain("Budget: turns ≤ 3, tokens ≤ 1,000");
    });
});
