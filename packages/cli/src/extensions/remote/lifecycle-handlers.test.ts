/**
 * Regression test for the session_error / session_complete emit ordering.
 *
 * Docs promise session_error is an "early signal" delivered before
 * session_complete. Both are published through the unified engine
 * (rctx.emitTriggerWithAck); session_complete is chained after the
 * session_error publish resolves, so arrival order at the engine is
 * deterministic. This exercises the real registerLifecycleHandlers agent_end
 * handler end-to-end (not a reimplementation) so a future accidental reordering
 * fails the test.
 */
import { describe, test, expect, mock } from "bun:test";

// Mutable override for the trigger-client mock so individual tests can inject
// a deferred/controlled promise without resetting the entire mock.
const _triggerClientMock: { subscriptionsOverride: null | (() => Promise<any[]>) } = {
    subscriptionsOverride: null,
};

mock.module("../trigger-client.js", () => ({
    listTriggerSubscriptions: (_sessionId: string) =>
        _triggerClientMock.subscriptionsOverride
            ? _triggerClientMock.subscriptionsOverride()
            : Promise.resolve([]),
    unsubscribeTrigger: () => Promise.resolve({ ok: true }),
}));
import { registerLifecycleHandlers, type LifecycleHandlerState } from "./lifecycle-handlers.js";
import { createFollowUpGrace } from "./followup-grace.js";
import type { RelayContext } from "../remote-types.js";
import { reserveSubagentSlots } from "../subagent/background-state.js";

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
        emit: mock(() => {}),
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
        emitTrigger: mock((trigger: any) => {
            emitted.push(trigger.type);
        }),
        emitTriggerWithAck: mock(async (trigger: any) => {
            emitted.push(trigger.type);
            return { ok: true };
        }),
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
    const agentSettled = handlers.get("agent_settled")!;
    return { agentEnd, agentSettled, emitted, rctx };
}

const agentEndCtx = { hasPendingMessages: () => false, shutdown: () => {} };

/** Publishes are promise-chained now — flush microtasks before asserting order. */
function flush(): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, 0));
}

describe("agent_end — session_error / session_complete ordering", () => {
    test("emits session_error before session_complete for a child session usage-limit error", async () => {
        const { agentEnd, agentSettled, emitted } = setup({
            errorMessage: "You have exceeded your usage limit",
            detectedAt: Date.now(),
        });

        agentEnd({ messages: [] }, agentEndCtx);
        agentSettled({}, agentEndCtx);
        await flush();

        // session_complete is chained after the session_error publish resolves,
        // so the engine receives them in this order.
        expect(emitted).toEqual(["lifecycle:session_error", "lifecycle:session_complete"]);
    });

    test("emits only session_complete when there is no usage-limit error", async () => {
        const { agentEnd, agentSettled, emitted } = setup(null);

        agentEnd({ messages: [] }, agentEndCtx);
        agentSettled({}, agentEndCtx);
        await flush();

        expect(emitted).toEqual(["lifecycle:session_complete"]);
    });

    test("defers session_complete until background subagents settle", async () => {
        const release = reserveSubagentSlots(1, 1)!;
        const { agentEnd, agentSettled, emitted } = setup(null);

        agentEnd({ messages: [] }, agentEndCtx);
        agentSettled({}, agentEndCtx);
        await flush();
        expect(emitted).toEqual([]);

        release();
        await flush();
        expect(emitted).toEqual(["lifecycle:session_complete"]);
    });

    test("does not report deferred completion after a result starts a follow-up turn", async () => {
        const release = reserveSubagentSlots(1, 1)!;
        const { agentEnd, agentSettled, emitted } = setup(null);

        agentEnd({ messages: [] }, agentEndCtx);
        agentSettled({}, agentEndCtx);
        release(true);
        await flush();
        expect(emitted).toEqual([]);

        agentEnd({ messages: [] }, agentEndCtx);
        agentSettled({}, agentEndCtx);
        await flush();
        expect(emitted).toEqual(["lifecycle:session_complete"]);
    });

    test("replays settlement when the last of concurrent subagents does not deliver", async () => {
        const releaseA = reserveSubagentSlots(1, 2)!;
        const releaseB = reserveSubagentSlots(1, 2)!;
        const { agentEnd, agentSettled, emitted } = setup(null);

        agentEnd({ messages: [] }, agentEndCtx);
        agentSettled({}, agentEndCtx);
        releaseA(true);

        agentEnd({ messages: [] }, agentEndCtx);
        agentSettled({}, agentEndCtx);
        releaseB(false);
        await flush();

        expect(emitted).toEqual(["lifecycle:session_complete"]);
    });

    test("agent_end alone emits nothing — reporting waits for agent_settled (auto-retry pending)", () => {
        const { agentEnd, emitted } = setup({
            errorMessage: "You have exceeded your usage limit",
            detectedAt: Date.now(),
        });

        agentEnd({ messages: [] }, agentEndCtx);

        expect(emitted).toEqual([]);
    });

    test("does not complete while a steering slash command aborts then dispatches", () => {
        const { agentEnd, agentSettled, emitted, rctx } = setup(null);
        (rctx as any).pendingSteeringSlashCommands = 1;

        agentEnd({ messages: [] }, agentEndCtx);
        expect((rctx as any).isAgentSettling).toBe(true);
        agentSettled({}, agentEndCtx);

        expect(emitted).toEqual([]);
        expect((rctx as any).isAgentSettling).toBe(false);
        expect((rctx as any).lastRetryableError).toBeNull();
    });

    test("no session_error when a retry recovers before settling", async () => {
        const { agentEnd, agentSettled, emitted, rctx } = setup({
            errorMessage: "You have exceeded your usage limit",
            detectedAt: Date.now(),
        });

        // Attempt 1 errors, pi auto-retries.
        agentEnd({ messages: [] }, agentEndCtx);
        // Retry succeeds: message_end (non-error) clears the latch.
        (rctx as any).lastRetryableError = null;
        agentEnd({ messages: [] }, agentEndCtx);
        agentSettled({}, agentEndCtx);
        await flush();

        expect(emitted).toEqual(["lifecycle:session_complete"]);
    });
});

describe("agent_end — forwarded event must not carry run-scoped messages", () => {
    // pi's agent_end.messages contains only the current run's messages. The web
    // UI and server snapshot cache treat agent_end.messages as a full-transcript
    // snapshot, so forwarding them truncates the visible transcript to the last
    // run. The handler must strip messages before forwarding.
    test("forwards agent_end without messages, keeps them for the settled summary", async () => {
        const { agentEnd, agentSettled, emitted, rctx } = setup(null);
        const runMessages = [{ role: "assistant", content: [{ type: "text", text: "turn 2 only" }] }];

        agentEnd({ type: "agent_end", messages: runMessages }, agentEndCtx);

        const forwarded = (rctx.forwardEvent as any).mock.calls
            .map((c: any[]) => c[0])
            .find((e: any) => e?.type === "agent_end");
        expect(forwarded).toBeDefined();
        expect("messages" in forwarded).toBe(false);

        // Summary reporting still sees the run messages via agent_settled.
        agentSettled({}, agentEndCtx);
        await flush();
        expect(emitted).toEqual(["lifecycle:session_complete"]);
    });
});

describe("auto-close — generation safety", () => {
    test("does not call shutdown when generation increments during subscription probe", async () => {
        // Deferred subscriptions promise — we control when it resolves.
        let resolveSubscriptions!: (val: any[]) => void;
        _triggerClientMock.subscriptionsOverride = () =>
            new Promise<any[]>((resolve) => {
                resolveSubscriptions = resolve;
            });

        const envBefore = process.env.PIZZAPI_WORKER_AUTO_CLOSE;
        process.env.PIZZAPI_WORKER_AUTO_CLOSE = "true";

        try {
            const handlers = new Map<string, (event: any, ctx: any) => void>();
            const pi: any = {
                on: (name: string, fn: any) => handlers.set(name, fn),
                events: { on: () => {} },
                registerTool: () => {},
                registerCommand: () => {},
            };

            const socket: any = {
                connected: true,
                emit: mock((_ev: string, _payload: any, cb?: (r: any) => void) => {
                    // For get_linked_child_count, return null so it doesn't time out.
                    if (_ev === "get_linked_child_count" && typeof cb === "function") {
                        cb({ ok: false });
                    }
                }),
                on: () => {},
                off: () => {},
            };

            const rctx = {
                pi,
                isChildSession: false,
                parentSessionId: null,
                relay: { sessionId: "ac-session-1", token: "relay-token" },
                relaySessionId: "ac-session-1",
                sioSocket: socket,
                lastRetryableError: null,
                wasAborted: false,
                shuttingDown: false,
                supportsSessionTriggerAck: true,
                isAgentActive: false,
                isAgentSettling: false,
                pendingSteeringSlashCommands: 0,
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
            const agentSettled = handlers.get("agent_settled")!;

            const shutdown = mock(() => {});
            const ctx = { hasPendingMessages: () => false, shutdown };

            // Kick off auto-close — the subscription probe is now in-flight.
            agentEnd({ messages: [] }, ctx);
            agentSettled({}, ctx);

            // Simulate a new turn arriving while probe is pending (e.g. /new).
            state.sessionCompleteGeneration += 1;

            // Resolve probe with empty list — would normally allow close.
            resolveSubscriptions([]);

            // Drain microtasks so the IIFE can continue past the await.
            await new Promise<void>((r) => setTimeout(r, 0));

            expect(shutdown).not.toHaveBeenCalled();
        } finally {
            _triggerClientMock.subscriptionsOverride = null;
            if (envBefore === undefined) {
                delete process.env.PIZZAPI_WORKER_AUTO_CLOSE;
            } else {
                process.env.PIZZAPI_WORKER_AUTO_CLOSE = envBefore;
            }
        }
    });
});
