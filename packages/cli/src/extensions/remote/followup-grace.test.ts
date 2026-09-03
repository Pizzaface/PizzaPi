import { beforeEach, describe, expect, mock, spyOn, test } from "bun:test";
import { createFollowUpGrace, isManualAbort, type FollowUpGraceState } from "./followup-grace.js";

describe("isManualAbort", () => {
    test("true only for an abort outside shutdown", () => {
        expect(isManualAbort({ wasAborted: true, shuttingDown: false })).toBe(true);
        expect(isManualAbort({ wasAborted: true, shuttingDown: true })).toBe(false);
        expect(isManualAbort({ wasAborted: false, shuttingDown: false })).toBe(false);
    });
});

const mockEmitTriggerWithAck = mock(async (_trigger: any): Promise<{ ok: boolean; error?: string; status?: number }> => ({ ok: true }));
const mockLogger = {
    info: mock((_message: string) => {}),
};

function makeState(): FollowUpGraceState {
    return {
        sessionCompleteFired: false,
        followUpGraceShutdown: null,
        sessionCompleteGeneration: 0,
        sessionCompleteTransportGeneration: 0,
        sessionCompleteRetryTimer: null,
        pendingSessionCompleteDelivery: null,
        pendingSessionCompleteSocket: null,
        pendingSessionCompleteTransportGeneration: null,
        lastSessionCompletePayload: null,
    };
}

function makeRelayContext() {
    return {
        isChildSession: true,
        parentSessionId: "parent-1",
        relay: { token: "relay-token", sessionId: "child-1" },
        sioSocket: { connected: true },
    } as any;
}

describe("startFollowUpGrace / shutdownFollowUpGraceImmediately", () => {
    test("startFollowUpGrace never schedules a timer — no auto-shutdown clock", () => {
        const setTimeoutSpy = spyOn(globalThis, "setTimeout");
        const followUpGrace = createFollowUpGrace(makeRelayContext(), makeState(), { logger: mockLogger });
        const shutdown = mock(() => {});

        followUpGrace.startFollowUpGrace({ shutdown });

        expect(setTimeoutSpy).not.toHaveBeenCalled();
        expect(shutdown).not.toHaveBeenCalled();
        setTimeoutSpy.mockRestore();
    });

    test("shutdownFollowUpGraceImmediately still shuts down on an explicit parent delink", () => {
        const followUpGrace = createFollowUpGrace(makeRelayContext(), makeState(), { logger: mockLogger });
        const shutdown = mock(() => {});

        followUpGrace.startFollowUpGrace({ shutdown });
        followUpGrace.shutdownFollowUpGraceImmediately();

        expect(shutdown).toHaveBeenCalledTimes(1);
    });

    test("clearFollowUpGrace disarms without ever invoking shutdown", () => {
        const followUpGrace = createFollowUpGrace(makeRelayContext(), makeState(), { logger: mockLogger });
        const shutdown = mock(() => {});

        followUpGrace.startFollowUpGrace({ shutdown });
        followUpGrace.clearFollowUpGrace();
        followUpGrace.shutdownFollowUpGraceImmediately();

        expect(shutdown).not.toHaveBeenCalled();
    });
});

describe("createFollowUpGrace fireSessionComplete", () => {
    beforeEach(() => {
        mockEmitTriggerWithAck.mockReset();
        mockEmitTriggerWithAck.mockImplementation(async (_opts: any) => ({ ok: true }));
        mockLogger.info.mockReset();
    });

    test("does not retry a definitive 4xx publish failure", async () => {
        const state = makeState();
        mockEmitTriggerWithAck.mockResolvedValueOnce({ ok: false, error: "Parent session not found", status: 404 });
        const setTimeoutSpy = spyOn(globalThis, "setTimeout");
        const followUpGrace = createFollowUpGrace(makeRelayContext(), state, {
            emitTriggerWithAck: mockEmitTriggerWithAck,
            logger: mockLogger,
        });

        const result = await followUpGrace.fireSessionComplete("Done", undefined, "completed");

        expect(result).toEqual({ ok: false, error: "Parent session not found", status: 404 });
        expect(state.sessionCompleteRetryTimer).toBeNull();
        expect(setTimeoutSpy).not.toHaveBeenCalled();
        expect(mockLogger.info).toHaveBeenCalledTimes(1);
        expect(mockLogger.info).toHaveBeenCalledWith("session_complete undeliverable (HTTP 404) — not retrying");
        setTimeoutSpy.mockRestore();
    });

    test("keeps retrying 408, 429, 5xx, and network failures", async () => {
        for (const failure of [
            { error: "Request timeout", status: 408 },
            { error: "Rate limited", status: 429 },
            { error: "Bad gateway", status: 502 },
            { error: "ECONNRESET" },
        ]) {
            const state = makeState();
            const emit = mock(async () => ({ ok: false as const, ...failure }));
            const followUpGrace = createFollowUpGrace(makeRelayContext(), state, {
                emitTriggerWithAck: emit,
                logger: mockLogger,
            });

            await followUpGrace.fireSessionComplete("Done", undefined, "completed");

            expect(state.sessionCompleteRetryTimer).not.toBeNull();
            followUpGrace.clearFollowUpGrace();
        }
    });

    test("reuses the in-flight completion delivery promise instead of emitting twice", async () => {
        let resolveDelivery: ((value: { ok: boolean; error?: string }) => void) | null = null;
        mockEmitTriggerWithAck.mockImplementation(
            () => new Promise<{ ok: boolean; error?: string }>((resolve) => {
                resolveDelivery = resolve;
            }),
        );

        const followUpGrace = createFollowUpGrace(makeRelayContext(), makeState(), {
            emitTriggerWithAck: mockEmitTriggerWithAck,
            logger: mockLogger,
        });
        const first = followUpGrace.fireSessionComplete("Done", "/tmp/out.md", "completed");
        const second = followUpGrace.fireSessionComplete(undefined, undefined, "completed");

        expect(mockEmitTriggerWithAck).toHaveBeenCalledTimes(1);
        if (!resolveDelivery) throw new Error("missing deferred resolver");
        const resolver = resolveDelivery as (value: { ok: boolean; error?: string }) => void;
        resolver({ ok: true });
        await expect(first).resolves.toEqual({ ok: true });
        await expect(second).resolves.toEqual({ ok: true });
    });

    test("retries with the stored summary and fullOutputPath after an earlier failure", async () => {
        mockEmitTriggerWithAck
            .mockImplementationOnce(async () => ({ ok: false, error: "Target session parent-1 is not connected" } as { ok: boolean; error?: string }))
            .mockImplementationOnce(async () => ({ ok: true } as { ok: boolean; error?: string }));

        const followUpGrace = createFollowUpGrace(makeRelayContext(), makeState(), {
            emitTriggerWithAck: mockEmitTriggerWithAck,
            logger: mockLogger,
        });

        const first = await followUpGrace.fireSessionComplete("Rich summary", "/tmp/out.md", "completed");
        const second = await followUpGrace.fireSessionComplete(undefined, undefined, "completed");

        expect(first).toEqual({ ok: false, error: "Target session parent-1 is not connected" });
        expect(second).toEqual({ ok: true });
        expect(mockEmitTriggerWithAck).toHaveBeenCalledTimes(2);
        expect(mockEmitTriggerWithAck.mock.calls[1]?.[0]).toMatchObject({
            type: "lifecycle:session_complete",
            payload: {
                summary: "Rich summary",
                fullOutputPath: "/tmp/out.md",
                exitReason: "completed",
            },
        });
        expect(mockEmitTriggerWithAck.mock.calls[1]?.[0]?.triggerId).toBe(
            mockEmitTriggerWithAck.mock.calls[0]?.[0]?.triggerId,
        );
    });

    test("ignores a stale in-flight delivery that resolves after a new turn starts", async () => {
        let resolveFirst: ((value: { ok: boolean; error?: string }) => void) | null = null;
        mockEmitTriggerWithAck.mockImplementationOnce(
            () => new Promise<{ ok: boolean; error?: string }>((resolve) => {
                resolveFirst = resolve;
            }),
        );
        mockEmitTriggerWithAck.mockImplementationOnce(async () => ({ ok: true }));

        const state = makeState();
        const followUpGrace = createFollowUpGrace(makeRelayContext(), state, {
            emitTriggerWithAck: mockEmitTriggerWithAck,
            logger: mockLogger,
        });

        const first = followUpGrace.fireSessionComplete("First turn", undefined, "completed");
        expect(mockEmitTriggerWithAck).toHaveBeenCalledTimes(1);

        // Simulate turn_start/session_switch resetting completion state for a new turn.
        state.sessionCompleteFired = false;
        state.pendingSessionCompleteDelivery = null;
        state.pendingSessionCompleteSocket = null;
        state.pendingSessionCompleteTransportGeneration = null;
        state.lastSessionCompletePayload = null;
        state.sessionCompleteGeneration += 1;

        if (!resolveFirst) throw new Error("missing first resolver");
        const firstResolver = resolveFirst as (value: { ok: boolean; error?: string }) => void;
        firstResolver({ ok: true });
        await expect(first).resolves.toEqual({ ok: true });
        expect(state.sessionCompleteFired).toBe(false);

        const second = await followUpGrace.fireSessionComplete("Second turn", undefined, "completed");
        expect(second).toEqual({ ok: true });
        expect(mockEmitTriggerWithAck).toHaveBeenCalledTimes(2);
        expect(mockEmitTriggerWithAck.mock.calls[1]?.[0]).toMatchObject({ payload: { summary: "Second turn" } });
    });

    test("publishes completion over HTTP when the legacy socket is disconnected", async () => {
        const disconnected = makeRelayContext();
        disconnected.sioSocket = { connected: false };
        const state = makeState();
        const followUpGrace = createFollowUpGrace(disconnected, state, {
            emitTriggerWithAck: mockEmitTriggerWithAck,
            logger: mockLogger,
        });

        const result = await followUpGrace.fireSessionComplete("Buffered summary", "/tmp/buffered.md", "completed");

        expect(result).toEqual({ ok: true });
        expect(mockEmitTriggerWithAck).toHaveBeenCalledTimes(1);
        expect(mockEmitTriggerWithAck.mock.calls[0]?.[0]).toMatchObject({
            payload: {
                summary: "Buffered summary",
                fullOutputPath: "/tmp/buffered.md",
                exitReason: "completed",
            },
        });
    });

    test("preserves the original error exitReason on a shutdown-style retry", async () => {
        mockEmitTriggerWithAck
            .mockImplementationOnce(async () => ({ ok: false, error: "relay down" } as { ok: boolean; error?: string }))
            .mockImplementationOnce(async () => ({ ok: true } as { ok: boolean; error?: string }));

        const followUpGrace = createFollowUpGrace(makeRelayContext(), makeState(), {
            emitTriggerWithAck: mockEmitTriggerWithAck,
            logger: mockLogger,
        });

        const first = await followUpGrace.fireSessionComplete("Errored summary", "/tmp/error.md", "error");
        const second = await followUpGrace.fireSessionComplete(undefined, undefined, "completed");

        expect(first).toEqual({ ok: false, error: "relay down" });
        expect(second).toEqual({ ok: true });
        expect(mockEmitTriggerWithAck).toHaveBeenCalledTimes(2);
        expect(mockEmitTriggerWithAck.mock.calls[1]?.[0]).toMatchObject({
            payload: {
                summary: "Errored summary",
                fullOutputPath: "/tmp/error.md",
                exitReason: "error",
            },
        });
        expect(mockEmitTriggerWithAck.mock.calls[1]?.[0]?.triggerId).toBe(
            mockEmitTriggerWithAck.mock.calls[0]?.[0]?.triggerId,
        );
    });
});
