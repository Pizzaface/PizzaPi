// ============================================================================
// connection.trigger-ack.test.ts — Delivery-receipt ack contract (the CLI
// side of the trigger delivery guarantees):
//   1. register declares acksSessionTrigger so the server waits for acks
//   2. the session_trigger handler acks once a trigger is durably accepted
//      (tracked/batched), including the dedup/discard paths — a re-delivery
//      after an ack timeout must ack too, or the row never reaches delivered
//   3. a disconnect discards the pending batch AND untracks those triggers so
//      a server re-delivery is accepted instead of deduped (permanent loss)
// ============================================================================

import { afterAll, afterEach, beforeEach, describe, expect, mock, test } from "bun:test";

class FakeSocket {
    handlers = new Map<string, Array<(data: any, ack?: any) => void>>();
    ioHandlers = new Map<string, Array<(data: any) => void>>();
    connected = true;
    emit = mock((_event: string, _data?: any) => {});
    removeAllListeners = mock(() => {
        this.handlers.clear();
    });
    disconnect = mock(() => {
        this.connected = false;
    });
    on(event: string, handler: (data: any, ack?: any) => void) {
        const list = this.handlers.get(event) ?? [];
        list.push(handler);
        this.handlers.set(event, list);
        return this;
    }
    off(event: string, handler?: (data: any, ack?: any) => void) {
        if (!handler) {
            this.handlers.delete(event);
            return this;
        }
        const list = this.handlers.get(event) ?? [];
        this.handlers.set(event, list.filter((h) => h !== handler));
        return this;
    }
    trigger(event: string, data?: any, ack?: any) {
        for (const handler of this.handlers.get(event) ?? []) handler(data, ack);
    }
    io = {
        on: (event: string, handler: (data: any) => void) => {
            const list = this.ioHandlers.get(event) ?? [];
            this.ioHandlers.set(event, list);
            return this.io;
        },
    };
}

let lastSocket: FakeSocket | null = null;

mock.module("socket.io-client", () => ({
    io: mock(() => {
        lastSocket = new FakeSocket();
        return lastSocket;
    }),
}));

mock.module("../../config.js", () => ({
    loadConfig: mock(() => ({ relayUrl: "ws://relay.test" })),
}));

mock.module("../../backoff.js", () => ({
    RELAY_BACKOFF_DEFAULTS: { baseMs: 1000, maxMs: 30000, jitterFactor: 0.25 },
    computeBackoffDelay: mock(() => 1000),
}));

mock.module("../mcp-bridge.js", () => ({ getMcpBridge: mock(() => null) }));
mock.module("../session-message-bus.js", () => ({
    messageBus: {
        setOwnSessionId: mock(() => {}),
        setSendFn: mock(() => {}),
        receive: mock(() => {}),
    },
}));
mock.module("../remote-provider-usage.js", () => ({
    getOAuthToken: mock(() => null),
    refreshAllUsage: mock(async () => {}),
    buildProviderUsage: mock(() => ({})),
}));
mock.module("../remote-heartbeat.js", () => ({
    startHeartbeat: mock(() => {}),
    stopHeartbeat: mock(() => {}),
    buildHeartbeat: mock(() => ({ type: "heartbeat" })),
    buildTokenUsage: mock(() => ({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, contextTokens: null })),
}));
mock.module("../remote-meta-events.js", () => ({
    emitTodoUpdated: mock(() => {}),
    emitQuestionPending: mock(() => {}),
    emitQuestionCleared: mock(() => {}),
    emitPlanPending: mock(() => {}),
    emitPlanCleared: mock(() => {}),
    emitPlanModeToggled: mock(() => {}),
    emitCompactStarted: mock(() => {}),
    emitCompactEnded: mock(() => {}),
    emitRetryStateChanged: mock(() => {}),
    emitPluginTrustRequired: mock(() => {}),
    emitPluginTrustResolved: mock(() => {}),
    emitMcpStartupReport: mock(() => {}),
    emitTokenUsageUpdated: mock(() => {}),
    emitThinkingLevelChanged: mock(() => {}),
    emitAuthSourceChanged: mock(() => {}),
    emitModelChanged: mock(() => {}),
    emitGoalUpdated: mock(() => {}),
    emitApprovalPending: mock(() => {}),
    emitApprovalCleared: mock(() => {}),
}));
mock.module("../remote-auth-source.js", () => ({
    getAuthSource: mock(() => null),
    authSourceLabel: mock(() => ""),
}));
mock.module("../remote-ask-user.js", () => ({
    cancelPendingAskUserQuestion: mock(() => {}),
    consumePendingAskUserQuestionFromWeb: mock(() => false),
    registerAskUserTool: mock(() => {}),
}));
mock.module("../remote-plan-mode.js", () => ({
    cancelPendingPlanMode: mock(() => {}),
    consumePendingPlanModeFromWeb: mock(() => false),
    registerPlanModeTool: mock(() => {}),
}));
mock.module("../remote-input.js", () => ({
    normalizeRemoteInputAttachments: mock(() => []),
    buildUserMessageFromRemoteInput: mock(async (text: string) => text),
}));
mock.module("../remote-exec-handler.js", () => ({ handleExecFromWeb: mock(async () => {}) }));
mock.module("./registration-gate.js", () => ({
    resetRelayRegistrationGate: mock(() => {}),
    signalRelayRegistered: mock(() => {}),
    waitForRelayRegistrationGated: mock(async () => {}),
}));
mock.module("../remote-registered-parent-state.js", () => ({
    decideRegisteredParentState: mock(() => ({ kind: "no_change" })),
}));

const { connect } = await import("./connection.js");
const { receivedTriggers } = await import("../triggers/extension.js");

mock.restore();

function sleep(ms: number) {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

function makeHarness() {
    const sendUserMessage = mock(async () => {});
    const rctx = {
        shuttingDown: false,
        sioSocket: null,
        relay: null,
        relaySessionId: null,
        apiKey: () => "test-key",
        relayUrl: () => "ws://relay.test",
        disconnectedStatusText: () => "Disconnected",
        setRelayStatus: mock(() => {}),
        getCurrentSessionName: () => null,
        getCurrentThinkingLevel: () => null,
        forwardEvent: mock(() => {}),
        buildCapabilitiesState: () => ({ type: "capabilities" }),
    } as any;
    const handlers = {
        clearFollowUpGrace: mock(() => {}),
        setModelFromWeb: mock(async () => {}),
        sendUserMessage,
        isPendingDelinkOwnParent: () => false,
        setServerClockOffset: mock(() => {}),
        isStaleChild: () => false,
        getStalePrimaryParentId: () => null,
        onParentExplicitlyDelinked: mock(() => {}),
        onParentTransientlyOffline: mock(() => {}),
        onParentDelinked: mock(() => {}),
        flushDeferredDelinks: mock(() => {}),
        onDelinkDisconnect: mock(() => {}),
        onSocketTeardown: mock(() => {}),
        getParentSessionIdForRegister: () => undefined,
    } as any;
    return { rctx, handlers, sendUserMessage };
}

function makeTrigger(triggerId: string) {
    return {
        type: "github:pr_comment",
        sourceSessionId: "external:github",
        sourceSessionName: "GitHub",
        triggerId,
        payload: { body: "please fix this" },
        deliverAs: "steer",
        ts: new Date().toISOString(),
    };
}

describe("session_trigger receipt acks", () => {
    beforeEach(() => {
        lastSocket = null;
    });

    afterEach(() => {
        receivedTriggers.clear();
    });

    test("register declares acksSessionTrigger so the server waits for receipt acks", () => {
        const { rctx, handlers } = makeHarness();
        connect(rctx, handlers);
        lastSocket!.trigger("connect");

        const registerCall = lastSocket!.emit.mock.calls.find((c: any[]) => c[0] === "register");
        expect(registerCall).toBeTruthy();
        expect((registerCall![1] as any).acksSessionTrigger).toBe(true);
    });

    test("handler acks after durably accepting a trigger (tracked + batched)", async () => {
        const { rctx, handlers, sendUserMessage } = makeHarness();
        connect(rctx, handlers);

        const ack = mock((_result: { ok: boolean }) => {});
        lastSocket!.trigger("session_trigger", { trigger: makeTrigger("ack_trig_1") }, ack);

        // Ack fires immediately on durable accept — before the batch flush.
        expect(ack).toHaveBeenCalledTimes(1);
        expect(ack.mock.calls[0][0]).toEqual({ ok: true });
        expect(receivedTriggers.has("ack_trig_1")).toBe(true);

        // The trigger still injects through the normal batch path.
        await sleep(120);
        expect(sendUserMessage).toHaveBeenCalledTimes(1);
    });

    test("duplicate re-delivery acks too (already durably accepted)", async () => {
        const { rctx, handlers, sendUserMessage } = makeHarness();
        connect(rctx, handlers);

        lastSocket!.trigger("session_trigger", { trigger: makeTrigger("ack_trig_2") });
        await sleep(120);
        expect(sendUserMessage).toHaveBeenCalledTimes(1);

        // Server redelivered after an ack timeout: the CLI dedups the
        // injection but must STILL ack, or the delivery row never settles.
        const ack = mock((_result: { ok: boolean }) => {});
        lastSocket!.trigger("session_trigger", { trigger: makeTrigger("ack_trig_2") }, ack);
        expect(ack).toHaveBeenCalledTimes(1);
        expect(ack.mock.calls[0][0]).toEqual({ ok: true });
        await sleep(120);
        expect(sendUserMessage).toHaveBeenCalledTimes(1); // no double injection
    });

    test("old server without an ack callback is handled safely", () => {
        const { rctx, handlers } = makeHarness();
        connect(rctx, handlers);
        // No ack argument — must not throw.
        expect(() => lastSocket!.trigger("session_trigger", { trigger: makeTrigger("ack_trig_3") })).not.toThrow();
        expect(receivedTriggers.has("ack_trig_3")).toBe(true);
    });

    test("disconnect discards the batch AND untracks for re-delivery", async () => {
        const { rctx, handlers, sendUserMessage } = makeHarness();
        connect(rctx, handlers);

        // Batched but not yet flushed.
        lastSocket!.trigger("session_trigger", { trigger: makeTrigger("ack_trig_4") });
        expect(receivedTriggers.has("ack_trig_4")).toBe(true);

        // Connection dies before injection: the batch is discarded and the
        // trigger untracked, so a server re-delivery is accepted (not deduped).
        lastSocket!.trigger("disconnect");
        expect(receivedTriggers.has("ack_trig_4")).toBe(false);

        // Server re-delivers the same triggerId after reconnect.
        lastSocket!.trigger("session_trigger", { trigger: makeTrigger("ack_trig_4") });
        await sleep(120);
        expect(sendUserMessage).toHaveBeenCalledTimes(1);
    });
});

afterAll(() => {
    receivedTriggers.clear();
});