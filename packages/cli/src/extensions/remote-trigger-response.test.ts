import { describe, expect, test } from "bun:test";
import { isCancelTriggerAction } from "./remote-trigger-response.js";

describe("isCancelTriggerAction", () => {
    test("returns true for cancel action", () => {
        expect(isCancelTriggerAction("cancel")).toBe(true);
        expect(isCancelTriggerAction(" Cancel ")).toBe(true);
        expect(isCancelTriggerAction("CANCEL")).toBe(true);
    });

    test("returns false for non-cancel values", () => {
        expect(isCancelTriggerAction("approve")).toBe(false);
        expect(isCancelTriggerAction(undefined)).toBe(false);
        expect(isCancelTriggerAction(null)).toBe(false);
        expect(isCancelTriggerAction(42)).toBe(false);
    });
});
