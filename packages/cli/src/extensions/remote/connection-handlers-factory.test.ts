import { describe, expect, mock, test } from "bun:test";
import { createConnectionHandlers } from "./connection-handlers-factory.js";

describe("createConnectionHandlers flushDeferredDelinks", () => {
    function makeDeps() {
        const fireSessionComplete = mock(async () => ({ ok: true }));
        const emitDelinkChildren = mock((_epoch: number) => {});
        const emitDelinkOwnParent = mock(() => {});
        const startPendingCancellationRetryLoop = mock(() => {});
        const retryPendingTriggerCancellations = mock((_reason: string) => {});
        const socket = { connected: true };
        const state = {
            pendingDelinkOwnParent: false,
            serverClockOffset: 0,
            staleChildIds: new Set<string>(),
            stalePrimaryParentId: null,
            pendingDelink: false,
            pendingDelinkEpoch: null,
            pendingCancellations: [],
            sessionCompleteFired: false,
            sessionCompleteTransportGeneration: 0,
            pendingSessionCompleteDelivery: null as Promise<{ ok: boolean; error?: string }> | null,
            pendingSessionCompleteSocket: null as any,
            pendingSessionCompleteTransportGeneration: null as number | null,
            sessionCompleteRetryTimer: null as ReturnType<typeof setTimeout> | null,
            lastSessionCompletePayload: {
                triggerId: "trigger-1",
                summary: "Buffered summary",
                fullOutputPath: "/tmp/out.md",
                exitReason: "completed" as const,
            },
        };

        const deps = {
            pi: { sendUserMessage: () => {} },
            rctx: {
                isChildSession: true,
                sioSocket: socket,
                parentSessionId: "parent-1",
            } as any,
            state,
            triggerWaits: {
                cancelAll: () => 0,
            } as any,
            delinkManager: {
                emitDelinkChildren,
                emitDelinkOwnParent,
                clearPendingDelinkRetryTimer: () => {},
                clearPendingDelinkOwnParentRetryTimer: () => {},
            } as any,
            cancellationManager: {
                startPendingCancellationRetryLoop,
                retryPendingTriggerCancellations,
                stopPendingCancellationRetryLoop: () => {},
            } as any,
            followUpGrace: {
                clearFollowUpGrace: () => {},
                shutdownFollowUpGraceImmediately: () => {},
                startFollowUpGrace: () => {},
                fireSessionComplete,
            } as any,
            setModelFromWeb: async () => {},
        };

        return { deps, fireSessionComplete, state, socket };
    }

    test("retries a buffered session_complete after reconnect", () => {
        const { deps, fireSessionComplete } = makeDeps();
        const { connectionHandlers } = createConnectionHandlers(deps as any);

        connectionHandlers.flushDeferredDelinks();

        expect(fireSessionComplete).toHaveBeenCalledTimes(1);
        expect(fireSessionComplete).toHaveBeenCalledWith();
    });

    test("drops the stale in-flight delivery on disconnect so reconnect can resend immediately", () => {
        const { deps, fireSessionComplete, state, socket } = makeDeps();
        state.pendingSessionCompleteDelivery = new Promise(() => {});
        state.pendingSessionCompleteSocket = socket as any;
        state.pendingSessionCompleteTransportGeneration = 0;

        const { connectionHandlers } = createConnectionHandlers(deps as any);
        connectionHandlers.onDelinkDisconnect();
        connectionHandlers.flushDeferredDelinks();

        expect(state.sessionCompleteTransportGeneration).toBe(1);
        expect(state.pendingSessionCompleteDelivery).toBeNull();
        expect(fireSessionComplete).toHaveBeenCalledTimes(1);
    });
});

describe("createConnectionHandlers sendUserMessage", () => {
    function makeBaseDeps(sessionHost: unknown) {
        return {
            pi: { sendUserMessage: () => { throw new Error("pi.sendUserMessage must never be called"); } },
            rctx: { sessionHost } as any,
            state: {} as any,
            triggerWaits: {} as any,
            delinkManager: {} as any,
            cancellationManager: {} as any,
            followUpGrace: {} as any,
            setModelFromWeb: async () => {},
        };
    }

    test("delegates to rctx.sessionHost.sendUserMessage and awaits the result", async () => {
        const calls: Array<[unknown, unknown]> = [];
        const sessionHost = {
            sendUserMessage: async (msg: unknown, opts?: unknown) => {
                calls.push([msg, opts]);
            },
        };
        const { connectionHandlers } = createConnectionHandlers(makeBaseDeps(sessionHost) as any);

        await connectionHandlers.sendUserMessage("hello", { expandPromptTemplates: true });

        expect(calls).toEqual([["hello", { expandPromptTemplates: true }]]);
    });

    test("throws clearly when no SessionHost is available — never falls back to pi.sendUserMessage", async () => {
        const { connectionHandlers } = createConnectionHandlers(makeBaseDeps(null) as any);

        await expect(connectionHandlers.sendUserMessage("hello")).rejects.toThrow(/SessionHost/);
    });
});
