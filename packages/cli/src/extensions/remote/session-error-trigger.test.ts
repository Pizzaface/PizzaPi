import { describe, test, expect, mock } from "bun:test";
import { maybeFireSessionError, type SessionErrorParams } from "./session-error-trigger.js";
import type { ConversationTrigger } from "../triggers/types.js";

// ── Helpers ───────────────────────────────────────────────────────────────────

type EmitFn = (trigger: ConversationTrigger) => Promise<{ ok: boolean; error?: string }>;

function makeEmitFn(overrides: { ok?: boolean; error?: string } = {}): ReturnType<typeof mock<EmitFn>> {
    return mock<EmitFn>(async () => ({ ok: overrides.ok ?? true, error: overrides.error }));
}

function makeParams(overrides: Partial<SessionErrorParams> = {}): SessionErrorParams {
    return {
        sessionErrorFired: false,
        errorMessage: "You have exceeded your usage limit",
        isChildSession: true,
        parentSessionId: "parent-session-123",
        relaySessionId: "relay-session-xyz",
        emitTriggerWithAck: makeEmitFn(),
        ...overrides,
    };
}

// ── Happy path: event IS published ───────────────────────────────────────────

describe("maybeFireSessionError — happy path", () => {
    test("publishes when all conditions are met", async () => {
        const emitFn = makeEmitFn();
        const result = await maybeFireSessionError(makeParams({ emitTriggerWithAck: emitFn }));

        expect(result).toBe(true);
        expect(emitFn).toHaveBeenCalledTimes(1);
    });

    test("trigger carries correct type, target, and source", async () => {
        const emitFn = makeEmitFn();
        await maybeFireSessionError(makeParams({
            emitTriggerWithAck: emitFn,
            parentSessionId: "parent-456",
            relaySessionId: "source-789",
        }));

        const trigger = emitFn.mock.calls[0][0];
        expect(trigger.type).toBe("lifecycle:session_error");
        expect(trigger.targetSessionId).toBe("parent-456");
        expect(trigger.sourceSessionId).toBe("source-789");
        expect(trigger.deliverAs).toBe("steer");
        expect(trigger.expectsResponse).toBe(true);
    });

    test("payload.message contains the error message", async () => {
        const emitFn = makeEmitFn();
        const errMsg = "Rate limit reached for your plan";
        await maybeFireSessionError(makeParams({ emitTriggerWithAck: emitFn, errorMessage: errMsg }));

        expect(emitFn.mock.calls[0][0].payload.message).toBe(errMsg);
    });

    test("trigger includes a triggerId (UUID) and ts (ISO string)", async () => {
        const emitFn = makeEmitFn();
        await maybeFireSessionError(makeParams({ emitTriggerWithAck: emitFn }));

        const trigger = emitFn.mock.calls[0][0];
        expect(typeof trigger.triggerId).toBe("string");
        expect(trigger.triggerId.length).toBeGreaterThan(0);
        expect(typeof trigger.ts).toBe("string");
        expect(() => new Date(trigger.ts)).not.toThrow();
    });

    test("works with gRPC RESOURCE_EXHAUSTED (underscore)", async () => {
        const emitFn = makeEmitFn();
        const result = await maybeFireSessionError(makeParams({
            emitTriggerWithAck: emitFn,
            errorMessage: "grpc status RESOURCE_EXHAUSTED",
        }));

        expect(result).toBe(true);
        expect(emitFn).toHaveBeenCalledTimes(1);
    });

    test("works with gRPC QUOTA_EXCEEDED (underscore)", async () => {
        const emitFn = makeEmitFn();
        const result = await maybeFireSessionError(makeParams({
            emitTriggerWithAck: emitFn,
            errorMessage: "grpc status QUOTA_EXCEEDED",
        }));

        expect(result).toBe(true);
        expect(emitFn).toHaveBeenCalledTimes(1);
    });

    test("reports failure when the publish fails", async () => {
        const emitFn = makeEmitFn({ ok: false, error: "relay unavailable" });
        const result = await maybeFireSessionError(makeParams({ emitTriggerWithAck: emitFn }));

        expect(result).toBe(false);
        expect(emitFn).toHaveBeenCalledTimes(1);
    });
});

// ── Guard conditions: event must NOT publish ──────────────────────────────────

describe("maybeFireSessionError — guard conditions", () => {
    test("returns false when sessionErrorFired is already true", async () => {
        const emitFn = makeEmitFn();
        const result = await maybeFireSessionError(makeParams({ emitTriggerWithAck: emitFn, sessionErrorFired: true }));

        expect(result).toBe(false);
        expect(emitFn).not.toHaveBeenCalled();
    });

    test("returns false when errorMessage is undefined", async () => {
        const emitFn = makeEmitFn();
        const result = await maybeFireSessionError(makeParams({ emitTriggerWithAck: emitFn, errorMessage: undefined }));

        expect(result).toBe(false);
        expect(emitFn).not.toHaveBeenCalled();
    });

    test("returns false when errorMessage is null", async () => {
        const emitFn = makeEmitFn();
        const result = await maybeFireSessionError(makeParams({ emitTriggerWithAck: emitFn, errorMessage: null }));

        expect(result).toBe(false);
        expect(emitFn).not.toHaveBeenCalled();
    });

    test("returns false when errorMessage is empty string", async () => {
        const emitFn = makeEmitFn();
        const result = await maybeFireSessionError(makeParams({ emitTriggerWithAck: emitFn, errorMessage: "" }));

        expect(result).toBe(false);
        expect(emitFn).not.toHaveBeenCalled();
    });

    test("returns false when not a child session", async () => {
        const emitFn = makeEmitFn();
        const result = await maybeFireSessionError(makeParams({ emitTriggerWithAck: emitFn, isChildSession: false }));

        expect(result).toBe(false);
        expect(emitFn).not.toHaveBeenCalled();
    });

    test("returns false when parentSessionId is null", async () => {
        const emitFn = makeEmitFn();
        const result = await maybeFireSessionError(makeParams({ emitTriggerWithAck: emitFn, parentSessionId: null }));

        expect(result).toBe(false);
        expect(emitFn).not.toHaveBeenCalled();
    });

    test("returns false when emitTriggerWithAck is null", async () => {
        const result = await maybeFireSessionError(makeParams({ emitTriggerWithAck: null }));

        expect(result).toBe(false);
    });

    test("returns false when relaySessionId is missing", async () => {
        const emitFn = makeEmitFn();
        const result = await maybeFireSessionError(makeParams({ emitTriggerWithAck: emitFn, relaySessionId: null }));

        expect(result).toBe(false);
        expect(emitFn).not.toHaveBeenCalled();
    });

    test("returns false when error is not a usage-limit error", async () => {
        const emitFn = makeEmitFn();
        const result = await maybeFireSessionError(makeParams({
            emitTriggerWithAck: emitFn,
            errorMessage: "Connection reset by peer",
        }));

        expect(result).toBe(false);
        expect(emitFn).not.toHaveBeenCalled();
    });
});