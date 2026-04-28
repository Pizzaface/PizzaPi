import { beforeEach, describe, expect, mock, test } from "bun:test";
import { createFollowUpGrace, type FollowUpGraceState } from "./followup-grace.js";

const mockEmitSessionCompleteWithAck = mock(async (_opts: any) => ({ ok: true }));
const mockLogger = {
    info: mock((_message: string) => {}),
};

function makeState(): FollowUpGraceState {
    return {
        sessionCompleteFired: false,
        followUpGraceTimer: null,
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

describe("createFollowUpGrace fireSessionComplete", () => {
    beforeEach(() => {
        mockEmitSessionCompleteWithAck.mockReset();
        mockEmitSessionCompleteWithAck.mockImplementation(async (_opts: any) => ({ ok: true }));
        mockLogger.info.mockReset();
    });

    test("reuses the in-flight completion delivery promise instead of emitting twice", async () => {
        let resolveDelivery: ((value: { ok: boolean; error?: string }) => void) | null = null;
        mockEmitSessionCompleteWithAck.mockImplementation(
            () => new Promise<{ ok: boolean; error?: string }>((resolve) => {
                resolveDelivery = resolve;
            }),
        );

        const followUpGrace = createFollowUpGrace(makeRelayContext(), makeState(), {
            emitSessionCompleteWithAck: mockEmitSessionCompleteWithAck,
            logger: mockLogger,
        });
        const first = followUpGrace.fireSessionComplete("Done", "/tmp/out.md", "completed");
        const second = followUpGrace.fireSessionComplete(undefined, undefined, "completed");

        expect(mockEmitSessionCompleteWithAck).toHaveBeenCalledTimes(1);
        if (!resolveDelivery) throw new Error("missing deferred resolver");
        const resolver = resolveDelivery as (value: { ok: boolean; error?: string }) => void;
        resolver({ ok: true });
        await expect(first).resolves.toEqual({ ok: true });
        await expect(second).resolves.toEqual({ ok: true });
    });

    test("retries with the stored summary and fullOutputPath after an earlier failure", async () => {
        mockEmitSessionCompleteWithAck
            .mockImplementationOnce(async () => ({ ok: false, error: "Target session parent-1 is not connected" } as { ok: boolean; error?: string }))
            .mockImplementationOnce(async () => ({ ok: true } as { ok: boolean; error?: string }));

        const followUpGrace = createFollowUpGrace(makeRelayContext(), makeState(), {
            emitSessionCompleteWithAck: mockEmitSessionCompleteWithAck,
            logger: mockLogger,
        });

        const first = await followUpGrace.fireSessionComplete("Rich summary", "/tmp/out.md", "completed");
        const second = await followUpGrace.fireSessionComplete(undefined, undefined, "completed");

        expect(first).toEqual({ ok: false, error: "Target session parent-1 is not connected" });
        expect(second).toEqual({ ok: true });
        expect(mockEmitSessionCompleteWithAck).toHaveBeenCalledTimes(2);
        expect(mockEmitSessionCompleteWithAck.mock.calls[1]?.[0]).toMatchObject({
            summary: "Rich summary",
            fullOutputPath: "/tmp/out.md",
            exitReason: "completed",
        });
        expect(mockEmitSessionCompleteWithAck.mock.calls[1]?.[0]?.triggerId).toBe(
            mockEmitSessionCompleteWithAck.mock.calls[0]?.[0]?.triggerId,
        );
    });

    test("ignores a stale in-flight delivery that resolves after a new turn starts", async () => {
        let resolveFirst: ((value: { ok: boolean; error?: string }) => void) | null = null;
        mockEmitSessionCompleteWithAck.mockImplementationOnce(
            () => new Promise<{ ok: boolean; error?: string }>((resolve) => {
                resolveFirst = resolve;
            }),
        );
        mockEmitSessionCompleteWithAck.mockImplementationOnce(async () => ({ ok: true }));

        const state = makeState();
        const followUpGrace = createFollowUpGrace(makeRelayContext(), state, {
            emitSessionCompleteWithAck: mockEmitSessionCompleteWithAck,
            logger: mockLogger,
        });

        const first = followUpGrace.fireSessionComplete("First turn", undefined, "completed");
        expect(mockEmitSessionCompleteWithAck).toHaveBeenCalledTimes(1);

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
        expect(mockEmitSessionCompleteWithAck).toHaveBeenCalledTimes(2);
        expect(mockEmitSessionCompleteWithAck.mock.calls[1]?.[0]).toMatchObject({ summary: "Second turn" });
    });

    test("stores completion payload even when the first attempt cannot send due to a disconnected socket", async () => {
        const disconnected = makeRelayContext();
        disconnected.sioSocket = { connected: false };
        const state = makeState();
        const followUpGrace = createFollowUpGrace(disconnected, state, {
            emitSessionCompleteWithAck: mockEmitSessionCompleteWithAck,
            logger: mockLogger,
        });

        const first = await followUpGrace.fireSessionComplete("Buffered summary", "/tmp/buffered.md", "completed");
        expect(first).toEqual({ ok: false, error: "Child session is not connected to a linked parent" });

        disconnected.sioSocket = { connected: true };
        mockEmitSessionCompleteWithAck.mockResolvedValueOnce({ ok: true });

        const second = await followUpGrace.fireSessionComplete(undefined, undefined, "completed");
        expect(second).toEqual({ ok: true });
        expect(mockEmitSessionCompleteWithAck).toHaveBeenCalledTimes(1);
        expect(mockEmitSessionCompleteWithAck.mock.calls[0]?.[0]).toMatchObject({
            summary: "Buffered summary",
            fullOutputPath: "/tmp/buffered.md",
            exitReason: "completed",
        });
    });

    test("preserves the original error exitReason on a shutdown-style retry", async () => {
        mockEmitSessionCompleteWithAck
            .mockImplementationOnce(async () => ({ ok: false, error: "relay down" } as { ok: boolean; error?: string }))
            .mockImplementationOnce(async () => ({ ok: true } as { ok: boolean; error?: string }));

        const followUpGrace = createFollowUpGrace(makeRelayContext(), makeState(), {
            emitSessionCompleteWithAck: mockEmitSessionCompleteWithAck,
            logger: mockLogger,
        });

        const first = await followUpGrace.fireSessionComplete("Errored summary", "/tmp/error.md", "error");
        const second = await followUpGrace.fireSessionComplete(undefined, undefined, "completed");

        expect(first).toEqual({ ok: false, error: "relay down" });
        expect(second).toEqual({ ok: true });
        expect(mockEmitSessionCompleteWithAck).toHaveBeenCalledTimes(2);
        expect(mockEmitSessionCompleteWithAck.mock.calls[1]?.[0]).toMatchObject({
            summary: "Errored summary",
            fullOutputPath: "/tmp/error.md",
            exitReason: "error",
        });
        expect(mockEmitSessionCompleteWithAck.mock.calls[1]?.[0]?.triggerId).toBe(
            mockEmitSessionCompleteWithAck.mock.calls[0]?.[0]?.triggerId,
        );
    });
});
