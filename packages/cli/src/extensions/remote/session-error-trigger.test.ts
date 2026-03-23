import { describe, test, expect, mock } from "bun:test";
import { maybeFireSessionError, type SessionErrorParams } from "./session-error-trigger.js";

// ── Helpers ───────────────────────────────────────────────────────────────────

type EmitFn = (event: string, payload: unknown) => void;

function makeEmitFn(): ReturnType<typeof mock<EmitFn>> {
    return mock<EmitFn>(() => {});
}

function makeParams(overrides: Partial<SessionErrorParams> = {}): SessionErrorParams {
    return {
        sessionErrorFired: false,
        errorMessage: "You have exceeded your usage limit",
        isChildSession: true,
        parentSessionId: "parent-session-123",
        socketConnected: true,
        emitFn: makeEmitFn(),
        relayToken: "relay-token-abc",
        relaySessionId: "relay-session-xyz",
        ...overrides,
    };
}

// ── Happy path: trigger IS emitted ───────────────────────────────────────────

describe("maybeFireSessionError — happy path", () => {
    test("emits session_trigger when all conditions are met", () => {
        const emitFn = makeEmitFn();
        const params = makeParams({ emitFn });

        const result = maybeFireSessionError(params);

        expect(result).toBe(true);
        expect(emitFn).toHaveBeenCalledTimes(1);
    });

    test("emits to the 'session_trigger' event name", () => {
        const emitFn = makeEmitFn();
        maybeFireSessionError(makeParams({ emitFn }));

        expect(emitFn.mock.calls[0][0]).toBe("session_trigger");
    });

    test("payload contains correct type, relayToken, and targetSessionId", () => {
        const emitFn = makeEmitFn();
        const params = makeParams({
            emitFn,
            relayToken: "tok-123",
            parentSessionId: "parent-456",
            relaySessionId: "source-789",
        });

        maybeFireSessionError(params);

        const payload = emitFn.mock.calls[0][1] as any;
        expect(payload.token).toBe("tok-123");
        expect(payload.trigger.type).toBe("session_error");
        expect(payload.trigger.targetSessionId).toBe("parent-456");
        expect(payload.trigger.sourceSessionId).toBe("source-789");
        expect(payload.trigger.deliverAs).toBe("steer");
        expect(payload.trigger.expectsResponse).toBe(true);
    });

    test("payload.trigger.payload.message contains the error message", () => {
        const emitFn = makeEmitFn();
        const errMsg = "Rate limit reached for your plan";
        maybeFireSessionError(makeParams({ emitFn, errorMessage: errMsg }));

        const payload = emitFn.mock.calls[0][1] as any;
        expect(payload.trigger.payload.message).toBe(errMsg);
    });

    test("payload includes a triggerId (UUID) and ts (ISO string)", () => {
        const emitFn = makeEmitFn();
        maybeFireSessionError(makeParams({ emitFn }));

        const payload = emitFn.mock.calls[0][1] as any;
        expect(typeof payload.trigger.triggerId).toBe("string");
        expect(payload.trigger.triggerId.length).toBeGreaterThan(0);
        expect(typeof payload.trigger.ts).toBe("string");
        expect(() => new Date(payload.trigger.ts)).not.toThrow();
    });

    test("works with gRPC RESOURCE_EXHAUSTED (underscore)", () => {
        const emitFn = makeEmitFn();
        const result = maybeFireSessionError(makeParams({
            emitFn,
            errorMessage: "grpc status RESOURCE_EXHAUSTED",
        }));

        expect(result).toBe(true);
        expect(emitFn).toHaveBeenCalledTimes(1);
    });

    test("works with gRPC QUOTA_EXCEEDED (underscore)", () => {
        const emitFn = makeEmitFn();
        const result = maybeFireSessionError(makeParams({
            emitFn,
            errorMessage: "grpc status QUOTA_EXCEEDED",
        }));

        expect(result).toBe(true);
        expect(emitFn).toHaveBeenCalledTimes(1);
    });
});

// ── Guard conditions: trigger must NOT fire ───────────────────────────────────

describe("maybeFireSessionError — guard conditions", () => {
    test("returns false and does not emit when sessionErrorFired is already true", () => {
        const emitFn = makeEmitFn();
        const result = maybeFireSessionError(makeParams({ emitFn, sessionErrorFired: true }));

        expect(result).toBe(false);
        expect(emitFn).not.toHaveBeenCalled();
    });

    test("returns false and does not emit when errorMessage is undefined", () => {
        const emitFn = makeEmitFn();
        const result = maybeFireSessionError(makeParams({ emitFn, errorMessage: undefined }));

        expect(result).toBe(false);
        expect(emitFn).not.toHaveBeenCalled();
    });

    test("returns false and does not emit when errorMessage is null", () => {
        const emitFn = makeEmitFn();
        const result = maybeFireSessionError(makeParams({ emitFn, errorMessage: null }));

        expect(result).toBe(false);
        expect(emitFn).not.toHaveBeenCalled();
    });

    test("returns false and does not emit when errorMessage is empty string", () => {
        const emitFn = makeEmitFn();
        const result = maybeFireSessionError(makeParams({ emitFn, errorMessage: "" }));

        expect(result).toBe(false);
        expect(emitFn).not.toHaveBeenCalled();
    });

    test("returns false and does not emit when not a child session", () => {
        const emitFn = makeEmitFn();
        const result = maybeFireSessionError(makeParams({ emitFn, isChildSession: false }));

        expect(result).toBe(false);
        expect(emitFn).not.toHaveBeenCalled();
    });

    test("returns false and does not emit when parentSessionId is null", () => {
        const emitFn = makeEmitFn();
        const result = maybeFireSessionError(makeParams({ emitFn, parentSessionId: null }));

        expect(result).toBe(false);
        expect(emitFn).not.toHaveBeenCalled();
    });

    test("returns false and does not emit when socket is not connected", () => {
        const emitFn = makeEmitFn();
        const result = maybeFireSessionError(makeParams({ emitFn, socketConnected: false }));

        expect(result).toBe(false);
        expect(emitFn).not.toHaveBeenCalled();
    });

    test("returns false and does not emit when emitFn is null", () => {
        const result = maybeFireSessionError(makeParams({ emitFn: null }));

        expect(result).toBe(false);
    });

    test("returns false and does not emit when relayToken is missing", () => {
        const emitFn = makeEmitFn();
        const result = maybeFireSessionError(makeParams({ emitFn, relayToken: null }));

        expect(result).toBe(false);
        expect(emitFn).not.toHaveBeenCalled();
    });

    test("returns false and does not emit when relaySessionId is missing", () => {
        const emitFn = makeEmitFn();
        const result = maybeFireSessionError(makeParams({ emitFn, relaySessionId: null }));

        expect(result).toBe(false);
        expect(emitFn).not.toHaveBeenCalled();
    });

    test("returns false and does not emit when error is not a usage-limit error", () => {
        const emitFn = makeEmitFn();
        const result = maybeFireSessionError(makeParams({
            emitFn,
            errorMessage: "Connection reset by peer",
        }));

        expect(result).toBe(false);
        expect(emitFn).not.toHaveBeenCalled();
    });

    test("returns false and does not emit for generic server errors", () => {
        const emitFn = makeEmitFn();
        const result = maybeFireSessionError(makeParams({
            emitFn,
            errorMessage: "Internal server error (500)",
        }));

        expect(result).toBe(false);
        expect(emitFn).not.toHaveBeenCalled();
    });
});

// ── One-shot guard behaviour ──────────────────────────────────────────────────

describe("maybeFireSessionError — one-shot semantics", () => {
    test("caller is responsible for setting sessionErrorFired after return", () => {
        // Simulate the agent_end pattern from index.ts:
        //   if (maybeFireSessionError(...)) { sessionErrorFired = true; }
        let sessionErrorFired = false;
        const emitFn = makeEmitFn();

        // First call: fires and caller sets the flag
        if (maybeFireSessionError(makeParams({ emitFn, sessionErrorFired }))) {
            sessionErrorFired = true;
        }

        // Second call with updated flag: must NOT fire again
        const secondResult = maybeFireSessionError(makeParams({ emitFn, sessionErrorFired }));

        expect(secondResult).toBe(false);
        expect(emitFn).toHaveBeenCalledTimes(1); // only the first call emitted
    });
});
