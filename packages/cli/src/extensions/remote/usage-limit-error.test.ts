import { describe, test, expect } from "bun:test";
import { isProviderCapacityError, isUsageLimitError } from "./usage-limit-error.js";

describe("isUsageLimitError", () => {
    // ── True positives ────────────────────────────────────────────────────

    describe("matches known usage-limit phrases", () => {
        test("'usage limit' (Anthropic Claude)", () => {
            expect(isUsageLimitError("You have exceeded your usage limit")).toBe(true);
        });

        test("'usage limit' case-insensitive", () => {
            expect(isUsageLimitError("USAGE LIMIT reached")).toBe(true);
        });

        test("'rate limit'", () => {
            expect(isUsageLimitError("Rate limit reached for your plan")).toBe(true);
        });

        test("'rate limit' mixed case", () => {
            expect(isUsageLimitError("Rate Limit Exceeded")).toBe(true);
        });

        test("'quota exceeded'", () => {
            expect(isUsageLimitError("Quota exceeded for your current subscription")).toBe(true);
        });

        test("'resource exhausted'", () => {
            expect(isUsageLimitError("Resource exhausted: RESOURCE_EXHAUSTED")).toBe(true);
        });

        test("'RESOURCE_EXHAUSTED' gRPC/Gemini style (underscore)", () => {
            expect(isUsageLimitError("grpc status RESOURCE_EXHAUSTED")).toBe(true);
        });

        test("'QUOTA_EXCEEDED' gRPC style (underscore)", () => {
            expect(isUsageLimitError("grpc status QUOTA_EXCEEDED")).toBe(true);
        });

        test("'resource exhausted' lowercase", () => {
            expect(isUsageLimitError("resource exhausted: out of capacity")).toBe(true);
        });

        test("'tokens per minute'", () => {
            expect(isUsageLimitError("Tokens per minute limit reached for your tier")).toBe(true);
        });

        test("'requests per minute'", () => {
            expect(isUsageLimitError("Requests per minute exceeded")).toBe(true);
        });

        test("'quota' standalone", () => {
            expect(isUsageLimitError("Your quota has been exhausted")).toBe(true);
        });

        test("OpenAI rate limit message", () => {
            expect(isUsageLimitError("Rate limit reached for gpt-4 in organization org-xxx on tokens per minute")).toBe(true);
        });

        test("Gemini quota message", () => {
            expect(isUsageLimitError("You've exceeded your current quota. Please check your plan and billing.")).toBe(true);
        });
    });

    // ── False positives (must NOT match) ──────────────────────────────────

    describe("does NOT match unrelated errors", () => {
        test("'generate' — contains 'rate' as infix", () => {
            expect(isUsageLimitError("Failed to generate a response")).toBe(false);
        });

        test("'elaborate' — contains 'rate' as infix", () => {
            expect(isUsageLimitError("Please elaborate on the topic")).toBe(false);
        });

        test("'moderate' — contains 'rate' as infix", () => {
            expect(isUsageLimitError("Content failed moderate check")).toBe(false);
        });

        test("'demonstrate' — contains 'rate' as infix", () => {
            expect(isUsageLimitError("Unable to demonstrate behavior")).toBe(false);
        });

        test("generic network error", () => {
            expect(isUsageLimitError("Connection reset by peer")).toBe(false);
        });

        test("generic timeout error", () => {
            expect(isUsageLimitError("Request timed out after 30 seconds")).toBe(false);
        });

        test("empty string", () => {
            expect(isUsageLimitError("")).toBe(false);
        });

        test("'limited' — adjective, not a limit phrase", () => {
            // 'rate limit' pattern requires both words; 'limited' alone has no phrase match
            // and 'limit' pattern requires 'rate' or 'usage' before it as a phrase
            expect(isUsageLimitError("Limited functionality available")).toBe(false);
        });

        test("'usability' — contains 'usage' as infix would be wrong, but 'usage' pattern checks for 'usage limit'", () => {
            // The 'usage limit' phrase is required; 'usability' doesn't contain 'usage limit'
            expect(isUsageLimitError("There is a usability issue with this API")).toBe(false);
        });

        test("'accumulated' — contains 'quota' infix? No, 'quota' uses word boundary", () => {
            // \bquota\b would not match inside a longer word
            expect(isUsageLimitError("errors accumulated during processing")).toBe(false);
        });

        test("'overloaded' — transient provider saturation, not a quota error", () => {
            expect(isUsageLimitError("The model is currently overloaded, please try again")).toBe(false);
        });

        test("'throttled' — transient backpressure, not a quota error", () => {
            expect(isUsageLimitError("Request throttled due to high traffic")).toBe(false);
        });

        test("'throttling' — transient backpressure, not a quota error", () => {
            expect(isUsageLimitError("Server is throttling your requests")).toBe(false);
        });

        test("'capacity' standalone — transient saturation, not a quota error", () => {
            expect(isUsageLimitError("Service capacity exceeded for this region")).toBe(false);
        });

        test("model not found error", () => {
            expect(isUsageLimitError("Model not found: claude-opus-4-5")).toBe(false);
        });

        test("authentication error", () => {
            expect(isUsageLimitError("Invalid API key provided")).toBe(false);
        });

        test("server error", () => {
            expect(isUsageLimitError("Internal server error (500)")).toBe(false);
        });
    });
});

describe("isProviderCapacityError", () => {
    // ── True positives ────────────────────────────────────────────────────

    describe("matches known provider-capacity phrases", () => {
        test("Anthropic 'overloaded_error'", () => {
            expect(
                isProviderCapacityError(
                    "overloaded_error: Overloaded [status=200; request_id=req_011CeAZaCn185y5ESxRDYZMu; saw_message_stop=false; saw_tool_block=false]",
                ),
            ).toBe(true);
        });

        test("'overloaded' word", () => {
            expect(isProviderCapacityError("The model is currently overloaded, please try again")).toBe(true);
        });

        test("'Overloaded' capitalized", () => {
            expect(isProviderCapacityError("Provider returned error: Overloaded")).toBe(true);
        });

        test("HTTP 529", () => {
            expect(isProviderCapacityError("Error 529: overloaded")).toBe(true);
        });

        test("'throttled'", () => {
            expect(isProviderCapacityError("Request throttled due to high traffic")).toBe(true);
        });

        test("'throttling'", () => {
            expect(isProviderCapacityError("Server is throttling your requests")).toBe(true);
        });
    });

    // ── False positives (must NOT match) ──────────────────────────────────

    describe("does NOT match unrelated errors", () => {
        test("generic error", () => {
            expect(isProviderCapacityError("Something broke")).toBe(false);
        });

        test("empty string", () => {
            expect(isProviderCapacityError("")).toBe(false);
        });

        test("usage-limit error (other classifier)", () => {
            expect(isProviderCapacityError("Rate limit reached")).toBe(false);
        });

        test("'capacity' standalone", () => {
            expect(isProviderCapacityError("Service capacity exceeded for this region")).toBe(false);
        });
    });
});
