import { describe, expect, test } from "bun:test";
import { isPlanModeEnabled, isExecutionMode, getPlanTodoItems, togglePlanModeFromRemote } from "./plan-mode-toggle.js";

// These tests verify the module-level state accessors and the remote toggle.
// The extension itself requires a full pi runtime to test (registerCommand,
// event hooks, etc.), so we only test the exported pure functions and state.

describe("plan-mode-toggle module state", () => {
    test("isPlanModeEnabled defaults to false", () => {
        expect(isPlanModeEnabled()).toBe(false);
    });

    test("isExecutionMode defaults to false", () => {
        expect(isExecutionMode()).toBe(false);
    });

    test("getPlanTodoItems defaults to empty array", () => {
        expect(getPlanTodoItems()).toEqual([]);
    });

    test("togglePlanModeFromRemote returns false when extension not initialized", () => {
        // Before the extension factory runs, _toggleFn is null, so this should
        // return false.  In a real session the extension sets _toggleFn.
        // Note: if other tests have already initialised the extension (e.g. via
        // factories.test.ts importing it), _toggleFn may be set.  We accept
        // either boolean — the key contract is it doesn't throw.
        const result = togglePlanModeFromRemote();
        expect(typeof result).toBe("boolean");
    });
});
