import { describe, expect, test } from "bun:test";
import { getGitOperationFeedback, parseUpstreamRef } from "./git-operation-feedback";

describe("git-operation-feedback", () => {
    test("maps missing upstream to repair action", () => {
        expect(getGitOperationFeedback({ ok: false, reason: "missingUpstream" })).toEqual({
            type: "error",
            message: "This branch has no upstream configured. Set an upstream branch, then pull again.",
            action: "setUpstream",
        });
    });

    test("maps ambiguous upstream to repair action", () => {
        expect(getGitOperationFeedback({ ok: false, reason: "ambiguousUpstream" })).toEqual({
            type: "error",
            message: "This branch has an ambiguous upstream configuration. Repair it by setting exactly one upstream branch.",
            action: "setUpstream",
        });
    });

    test("parses remote/branch upstream refs", () => {
        expect(parseUpstreamRef("origin/feature/test")).toEqual({ remote: "origin", branch: "feature/test" });
        expect(parseUpstreamRef("origin")).toBeNull();
        expect(parseUpstreamRef("/main")).toBeNull();
    });
});
