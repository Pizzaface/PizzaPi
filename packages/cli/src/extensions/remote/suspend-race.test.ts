/**
 * Regression test for the suspend ack-round-trip data-loss race.
 *
 * trySuspendIdleChild (lifecycle-handlers.ts) asks the relay to suspend an
 * idle child (requestSuspend): the relay stops routing to this worker the
 * instant it accepts, but the socket stays fully connected throughout that
 * ack round trip. A send_message that lands in the inter-session message bus
 * while the ack is in flight must block the suspend — if it doesn't, the
 * worker commits to ctx.shutdown() and the message is lost with it.
 *
 * This drives the real registerLifecycleHandlers agent_end/agent_settled
 * path (not a reimplementation) so a regression here fails for real. Only
 * `createFollowUpGrace`'s `startFollowUpGrace` is faked, to capture the
 * `trySuspend` callback instead of arming the real 30-minute timer.
 */
import { describe, test, expect, mock, beforeEach, afterEach } from "bun:test";

let capturedTrySuspend: (() => Promise<boolean>) | null = null;

mock.module("./followup-grace.js", () => ({
    isManualAbort: (opts: { wasAborted: boolean; shuttingDown: boolean }) => opts.wasAborted && !opts.shuttingDown,
    createFollowUpGrace: (_rctx: unknown, state: { sessionCompleteFired: boolean }) => ({
        clearFollowUpGrace: () => {},
        shutdownFollowUpGraceImmediately: () => {},
        startFollowUpGrace: (_ctx: unknown, trySuspend?: () => Promise<boolean>) => {
            capturedTrySuspend = trySuspend ?? null;
        },
        // Real fireSessionComplete delivers to the parent and flips this flag;
        // the fake just needs the same observable effect trySuspendIdleChild
        // depends on (sessionCompleteDelivered).
        fireSessionComplete: async () => {
            state.sessionCompleteFired = true;
            return { ok: true };
        },
    }),
}));

mock.module("../trigger-client.js", () => ({
    listTriggerSubscriptions: () => Promise.resolve([]),
    unsubscribeTrigger: () => Promise.resolve({ ok: true }),
}));

import { registerLifecycleHandlers, type LifecycleHandlerState } from "./lifecycle-handlers.js";
import { createFollowUpGrace } from "./followup-grace.js"; // resolves to the mock above
import type { RelayContext } from "../remote-types.js";
import { messageBus } from "../session-message-bus.js";

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

function flush(): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, 0));
}

/** Builds a harness with a socket whose emit behavior the test controls per event name. */
function setup(onEmit: (event: string, payload: unknown, cb?: (result: unknown) => void) => void) {
    capturedTrySuspend = null;
    const handlers = new Map<string, (event: any, ctx: any) => void>();

    const pi: any = {
        on: (name: string, fn: any) => handlers.set(name, fn),
        events: { on: () => {} },
        registerTool: () => {},
        registerCommand: () => {},
    };

    const socket: any = {
        connected: true,
        emit: mock((event: string, payload: unknown, cb?: (result: unknown) => void) => onEmit(event, payload, cb)),
        on: () => {},
        off: () => {},
    };

    const shutdown = mock(() => {});
    const rctx = {
        pi,
        isChildSession: true,
        parentSessionId: "parent-session-1",
        relaySessionId: "child-session-1",
        relay: { sessionId: "child-session-1", token: "relay-token" },
        sioSocket: socket,
        lastRetryableError: null,
        wasAborted: false,
        shuttingDown: false,
        suspending: false,
        supportsSessionTriggerAck: true,
        forwardEvent: mock(() => {}),
        buildHeartbeat: () => ({ type: "heartbeat", ts: Date.now() }),
        emitTrigger: mock(() => {}),
        emitTriggerWithAck: mock(async () => ({ ok: true })),
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

    return { handlers, rctx, socket, shutdown };
}

const PRIOR_RUNNER_USAGE_CACHE_PATH = process.env.PIZZAPI_RUNNER_USAGE_CACHE_PATH;

beforeEach(() => {
    // canSuspendWorker() gates trySuspendIdleChild on this marker.
    process.env.PIZZAPI_RUNNER_USAGE_CACHE_PATH = "/tmp/pizzapi-fake-usage-cache.json";
    messageBus.resetForTests();
});

afterEach(() => {
    if (PRIOR_RUNNER_USAGE_CACHE_PATH === undefined) delete process.env.PIZZAPI_RUNNER_USAGE_CACHE_PATH;
    else process.env.PIZZAPI_RUNNER_USAGE_CACHE_PATH = PRIOR_RUNNER_USAGE_CACHE_PATH;
    messageBus.resetForTests();
});

/** Drives agent_end + agent_settled on a fully idle child so the follow-up
 *  grace arms and captures trySuspendIdleChild via the mocked startFollowUpGrace. */
async function armSuspendCallback(handlers: Map<string, (event: any, ctx: any) => void>, ctx: { hasPendingMessages: () => boolean; shutdown: () => void }) {
    handlers.get("agent_end")!({ messages: [] }, ctx);
    handlers.get("agent_settled")!({}, ctx);
    // startFollowUpGrace runs synchronously, but sessionCompleteFired flips
    // only after the async maybeFireSessionError -> fireSessionComplete chain
    // settles — flush a few ticks so trySuspendIdleChild's first check sees it.
    for (let i = 0; i < 10; i++) await flush();
    if (!capturedTrySuspend) throw new Error("trySuspend callback was not captured — did the child-session grace path change?");
    return capturedTrySuspend;
}

describe("trySuspendIdleChild — ack round-trip race", () => {
    test("a send_message arriving during the ack round trip aborts the suspend instead of losing it", async () => {
        let cancelRequested = false;
        const { handlers, shutdown } = setup((event, _payload, cb) => {
            if (event === "get_linked_child_count") {
                cb?.({ ok: true, count: 0 });
                return;
            }
            if (event === "session_suspend") {
                // Work arrives on the still-connected socket WHILE the ack is
                // in flight — exactly the window the ack round trip opens.
                messageBus.receive({ fromSessionId: "other-session", message: "hi", ts: new Date().toISOString() });
                cb?.({ ok: true });
                return;
            }
            if (event === "session_suspend_cancel") {
                cancelRequested = true;
                cb?.({ ok: true });
                return;
            }
        });

        const ctx = { hasPendingMessages: () => false, shutdown };
        const trySuspend = await armSuspendCallback(handlers, ctx);

        const suspended = await trySuspend();

        expect(suspended).toBe(false);
        expect(cancelRequested).toBe(true);
        // The message that arrived mid-round-trip must not be discarded with
        // the worker: shutdown must never be called once it was detected.
        expect(shutdown).not.toHaveBeenCalled();
        expect(messageBus.pendingCount()).toBe(1);
    });

    test("a fully idle child still suspends when nothing arrives during the round trip", async () => {
        let cancelRequested = false;
        const { handlers, shutdown } = setup((event, _payload, cb) => {
            if (event === "get_linked_child_count") {
                cb?.({ ok: true, count: 0 });
                return;
            }
            if (event === "session_suspend") {
                cb?.({ ok: true });
                return;
            }
            if (event === "session_suspend_cancel") {
                cancelRequested = true;
                cb?.({ ok: true });
                return;
            }
        });

        const ctx = { hasPendingMessages: () => false, shutdown };
        const trySuspend = await armSuspendCallback(handlers, ctx);

        const suspended = await trySuspend();

        expect(suspended).toBe(true);
        expect(cancelRequested).toBe(false);
        expect(shutdown).toHaveBeenCalledTimes(1);
    });
});
