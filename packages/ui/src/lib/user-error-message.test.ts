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

    // session_spawn HTTP 400 — distinct server error messages should be preserved

    test("maps cwd-inaccessible 400 to folder-path hint", () => {
        const result = mapUserError({
            error: "Runner cannot access cwd: /home/user/secret",
            statusCode: 400,
            context: "session_spawn",
        });

        expect(result.userMessage).toContain("can't access that folder");
        expect(result.userMessage).toContain("folder path");
        expect(result.technicalMessage).toBe("Runner cannot access cwd: /home/user/secret");
    });

    test("maps invalid-agent-name 400 to agent guidance (not folder hint)", () => {
        const result = mapUserError({
            error: "Invalid agent name",
            statusCode: 400,
            context: "session_spawn",
        });

        expect(result.userMessage).toContain("agent name is invalid");
        expect(result.userMessage).not.toContain("folder path");
        expect(result.technicalMessage).toBe("Invalid agent name");
    });

    test("maps requested-model-unavailable 400 to model guidance", () => {
        const result = mapUserError({
            error: "Requested model is not available",
            statusCode: 400,
            context: "session_spawn",
        });

        expect(result.userMessage).toContain("model is not available");
        expect(result.userMessage).not.toContain("folder path");
        expect(result.technicalMessage).toBe("Requested model is not available");
    });

    test("passes through runner ack error message for 400 (not folder hint)", () => {
        const result = mapUserError({
            error: "Runner rejected spawn: unsupported prompt format",
            statusCode: 400,
            context: "session_spawn",
        });

        // Server message surfaced directly rather than replaced with folder hint
        expect(result.userMessage).toContain("unsupported prompt format");
        expect(result.userMessage).not.toContain("folder path");
        expect(result.technicalMessage).toBe("Runner rejected spawn: unsupported prompt format");
    });

    test("uses generic 400 message when no body text available", () => {
        const result = mapUserError({
            statusCode: 400,
            context: "session_spawn",
        });

        expect(result.userMessage).toContain("Couldn't start that session");
        expect(result.userMessage).not.toContain("folder path");
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

    // Regression: Socket.IO auth failures during viewer connect_error
    //
    // When the server rejects the connection with HTTP 401/403, Socket.IO
    // reports err.message = "xhr poll error" (the transport error) but places
    // the actual HTTP status in err.description.status.  Without inspecting
    // that field, mapUserError would misclassify these as network errors and
    // tell the user to "check your network" instead of "sign in again".

    test("Socket.IO connect_error 401 via err.description.status → sign-in guidance (not network error)", () => {
        const err = new Error("xhr poll error");
        (err as unknown as Record<string, unknown>).description = { status: 401 };

        const result = mapUserError({
            error: err,
            context: "viewer_connection",
        });

        expect(result.userMessage).toContain("Sign in");
        expect(result.userMessage).not.toContain("Lost connection");
        expect(result.technicalMessage).toBe("xhr poll error");
    });

    test("Socket.IO connect_error 403 via err.description.status → access guidance (not network error)", () => {
        const err = new Error("xhr poll error");
        (err as unknown as Record<string, unknown>).description = { status: 403 };

        const result = mapUserError({
            error: err,
            context: "viewer_connection",
        });

        expect(result.userMessage).toContain("access");
        expect(result.userMessage).not.toContain("Lost connection");
    });

    test("Socket.IO connect_error 401 via err.context.status → sign-in guidance", () => {
        const err = new Error("xhr poll error");
        (err as unknown as Record<string, unknown>).context = { status: 401 };

        const result = mapUserError({
            error: err,
            context: "viewer_connection",
        });

        expect(result.userMessage).toContain("Sign in");
        expect(result.userMessage).not.toContain("Lost connection");
    });

    test("Socket.IO connect_error without status stays as network error", () => {
        // Plain "xhr poll error" with no description/context status should still
        // be treated as a network/transport error.
        const err = new Error("xhr poll error");

        const result = mapUserError({
            error: err,
            context: "viewer_connection",
        });

        expect(result.userMessage).toContain("Lost connection");
    });
});
