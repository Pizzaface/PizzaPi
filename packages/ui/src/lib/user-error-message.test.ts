import { describe, expect, test } from "bun:test";
import { mapUserError } from "./user-error-message.js";

describe("mapUserError", () => {
    test("maps runner-not-found errors to a user-friendly message", () => {
        const result = mapUserError({
            error: "Runner not found",
            context: "session_spawn",
        });

        expect(result.userMessage).toContain("runner is no longer available");
        expect(result.technicalMessage).toBe("Runner not found");
    });

    test("maps spawn delivery failures to runner guidance", () => {
        const result = mapUserError({
            error: "Failed to send spawn request to runner",
            context: "session_spawn",
        });

        expect(result.userMessage).toContain("Couldn't reach the selected runner");
    });

    test("maps missing session id to recovery guidance", () => {
        const result = mapUserError({
            error: "Spawn failed: missing sessionId",
            context: "session_spawn",
        });

        expect(result.userMessage).toContain("didn't return full session details");
    });

    test("maps viewer connection xhr poll error (real socket.io format)", () => {
        // Real socket.io connect_error delivers an Error object with .message = "xhr poll error" (no prefix)
        const result = mapUserError({
            error: new Error("xhr poll error"),
            context: "viewer_connection",
        });

        expect(result.userMessage).toContain("Lost connection to PizzaPi");
    });

    test("maps viewer connection transport error (real socket.io format)", () => {
        const result = mapUserError({
            error: new Error("transport error"),
            context: "viewer_connection",
        });

        expect(result.userMessage).toContain("Lost connection to PizzaPi");
    });

    test("maps 'Session not found' server message to permanent-removal message", () => {
        const result = mapUserError({
            error: "Session not found",
            context: "viewer_connection",
            fallbackMessage: "Failed to load session.",
        });

        expect(result.userMessage).toContain("no longer exists");
        expect(result.userMessage).not.toContain("Failed to load session");
        expect(result.technicalMessage).toBe("Session not found");
    });

    test("maps 'Session snapshot not available' to refresh guidance", () => {
        const result = mapUserError({
            error: "Session snapshot not available",
            context: "viewer_connection",
        });

        expect(result.userMessage).toContain("couldn't be loaded");
    });

    test("maps 'Failed to load session snapshot' to refresh guidance", () => {
        const result = mapUserError({
            error: "Failed to load session snapshot",
            context: "viewer_connection",
        });

        expect(result.userMessage).toContain("couldn't be loaded");
    });

    test("uses context fallback for unknown errors", () => {
        const result = mapUserError({
            error: "Unexpected explosion",
            context: "runner_restart",
        });

        expect(result.userMessage).toBe("Couldn't restart the runner. Please try again.");
    });

    test("maps HTTP 502 via status code", () => {
        const result = mapUserError({
            statusCode: 502,
            context: "session_spawn",
            fallbackMessage: "fallback",
        });

        expect(result.userMessage).toContain("Couldn't reach the selected runner");
        expect(result.technicalMessage).toBe("HTTP 502");
    });
});
