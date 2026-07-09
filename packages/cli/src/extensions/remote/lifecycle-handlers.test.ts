/**
 * Regression test for the session_error / session_complete emit ordering.
 *
 * Docs promise session_error is an "early signal" delivered before
 * session_complete. Both are emitted synchronously (direct socket.emit calls)
 * from the agent_end handler, so which call comes first in the source
 * determines wire order. This exercises the real registerLifecycleHandlers
 * agent_end handler end-to-end (not a reimplementation) so a future accidental
 * reordering fails the test.
 */
import { describe, test, expect, mock } from "bun:test";
import { registerLifecycleHandlers, type LifecycleHandlerState } from "./lifecycle-handlers.js";
import { createFollowUpGrace } from "./followup-grace.js";
import type { RelayContext } from "../remote-types.js";

function makeState(): LifecycleHandlerState {
    return {
        staleChildIds: new Set(),
        pendingDelink: false,
        pendingDelinkEpoch: null,
        pendingDelinkOwnParent: false,
        stalePrimaryParentId: null,
        pendingCancellations: [],
        sessionCompleteFired: false,
        sessionCompleteGeneration: 0,
        sessionCompleteTransportGeneration: 0,
        sessionCompleteRetryTimer: null,
        pendingSessionCompleteDelivery: null,
        pendingSessionCompleteSocket: null,
        pendingSessionCompleteTransportGeneration: null,
        lastSessionCompletePayload: null,
    };
}

/** Builds a minimal harness: real registerLifecycleHandlers + real followup-grace,
 * with a fake pi/socket capturing emitted trigger types in call order. */
function setup(lastRetryableError: { errorMessage: string; detectedAt: number } | null) {
    const handlers = new Map<string, (event: any, ctx: any) => void>();
    const emitted: string[] = [];

    const pi: any = {
        on: (name: string, fn: any) => handlers.set(name, fn),
        events: { on: () => {} },
        registerTool: () => {},
        registerCommand: () => {},
    };

    const socket: any = {
        connected: true,
        emit: mock((_event: string, payload: any) => {
            emitted.push(payload?.trigger?.type ?? "unknown");
        }),
        on: () => {},
        off: () => {},
    };

    const rctx = {
        pi,
        isChildSession: true,
        parentSessionId: "parent-session-1",
        relay: { sessionId: "child-session-1", token: "relay-token" },
        sioSocket: socket,
        lastRetryableError,
        wasAborted: false,
        shuttingDown: false,
        supportsSessionTriggerAck: true,
        forwardEvent: mock(() => {}),
        buildHeartbeat: () => ({ type: "heartbeat", ts: Date.now() }),
    } as unknown as RelayContext;

    const state = makeState();
    const followUpGrace = createFollowUpGrace(rctx, state as any);

    registerLifecycleHandlers({
        pi,
        rctx,
        state,
        triggerWaits: { cancelAll: () => 0 } as any,
        delinkManager: {} as any,
        cancellationManager: {} as any,
        followUpGrace,
        startSessionNameSync: () => {},
        stopSessionNameSync: () => {},
        doConnect: () => {},
        doDisconnect: () => {},
        clearCtx: () => {},
    });

    const agentEnd = handlers.get("agent_end")!;
    return { agentEnd, emitted };
}

const agentEndCtx = { hasPendingMessages: () => false, shutdown: () => {} };

describe("agent_end — session_error / session_complete ordering", () => {
    test("emits session_error before session_complete for a child session usage-limit error", () => {
        const { agentEnd, emitted } = setup({
            errorMessage: "You have exceeded your usage limit",
            detectedAt: Date.now(),
        });

        agentEnd({ messages: [] }, agentEndCtx);

        // Both are emitted synchronously within the handler call (before any
        // await/microtask), so capturing immediately after invocation is safe.
        expect(emitted).toEqual(["session_error", "session_complete"]);
    });

    test("emits only session_complete when there is no usage-limit error", () => {
        const { agentEnd, emitted } = setup(null);

        agentEnd({ messages: [] }, agentEndCtx);

        expect(emitted).toEqual(["session_complete"]);
    });
});
