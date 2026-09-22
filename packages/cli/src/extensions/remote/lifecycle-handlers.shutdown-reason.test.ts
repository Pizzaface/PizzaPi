import { describe, expect, test } from "bun:test";
import { shouldReportCompleteOnShutdown } from "./lifecycle-handlers.js";

describe("session_shutdown → session_complete", () => {
    test("a real quit (or legacy reasonless shutdown) reports completion", () => {
        expect(shouldReportCompleteOnShutdown("quit")).toBe(true);
        expect(shouldReportCompleteOnShutdown(undefined)).toBe(true);
    });

    test("runtime restarts do not tell the parent the child is done", () => {
        for (const reason of ["reload", "new", "resume", "fork"]) {
            expect(shouldReportCompleteOnShutdown(reason)).toBe(false);
        }
    });
});
