import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";

class FakeSocket {
    handlers = new Map<string, Array<(data: any) => void>>();
    ioHandlers = new Map<string, Array<(data: any) => void>>();
    connected = true;
    emit = mock((_event: string, _data?: any) => {});
    removeAllListeners = mock(() => {
        this.handlers.clear();
    });
    disconnect = mock(() => {
        this.connected = false;
    });
    on(event: string, handler: (data: any) => void) {
        const list = this.handlers.get(event) ?? [];
        list.push(handler);
        this.handlers.set(event, list);
        return this;
    }
    off(event: string, handler?: (data: any) => void) {
        if (!handler) {
            this.handlers.delete(event);
            return this;
        }
        const list = this.handlers.get(event) ?? [];
        this.handlers.set(event, list.filter((h) => h !== handler));
        return this;
    }
    trigger(event: string, data?: any) {
        for (const handler of this.handlers.get(event) ?? []) handler(data);
    }
    io = {
        on: (event: string, handler: (data: any) => void) => {
            const list = this.ioHandlers.get(event) ?? [];
            list.push(handler);
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
mock.module("../remote-provider-usage.js", () => ({ refreshAllUsage: mock(async () => {}) }));
mock.module("../remote-heartbeat.js", () => ({ startHeartbeat: mock(() => {}), stopHeartbeat: mock(() => {}) }));
mock.module("../remote-meta-events.js", () => ({
    emitAuthSourceChanged: mock(() => {}),
    emitThinkingLevelChanged: mock(() => {}),
    emitMcpStartupReport: mock(() => {}),
}));
mock.module("../remote-auth-source.js", () => ({ getAuthSource: mock(() => null) }));
mock.module("../remote-ask-user.js", () => ({
    cancelPendingAskUserQuestion: mock(() => {}),
    consumePendingAskUserQuestionFromWeb: mock(() => false),
}));
mock.module("../remote-plan-mode.js", () => ({
    cancelPendingPlanMode: mock(() => {}),
    consumePendingPlanModeFromWeb: mock(() => false),
}));
mock.module("../remote-input.js", () => ({
    normalizeRemoteInputAttachments: mock(() => []),
    buildUserMessageFromRemoteInput: mock(async (text: string) => text),
}));
mock.module("../remote-exec-handler.js", () => ({ handleExecFromWeb: mock(async () => {}) }));
mock.module("./registration-gate.js", () => ({
    resetRelayRegistrationGate: mock(() => {}),
    signalRelayRegistered: mock(() => {}),
}));
mock.module("../remote-registered-parent-state.js", () => ({
    decideRegisteredParentState: mock(() => ({ kind: "no_change" })),
}));

const { connect } = await import("./connection.js");
const {
    armWorkerStartupGate,
    markWorkerStartupComplete,
    _resetWorkerStartupGateForTesting,
} = await import("../worker-startup-gate.js");

function sleep(ms: number) {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

describe("remote connection startup gate", () => {
    beforeEach(() => {
        lastSocket = null;
        _resetWorkerStartupGateForTesting();
    });

    afterEach(() => {
        _resetWorkerStartupGateForTesting();
    });

    test("buffers trigger-delivered turns until worker startup completes", async () => {
        armWorkerStartupGate();

        const sendUserMessage = mock(() => {});
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

        connect(rctx, handlers);
        expect(lastSocket).toBeTruthy();

        lastSocket!.trigger("session_trigger", {
            trigger: {
                type: "github:pr_comment",
                sourceSessionId: "external:github",
                sourceSessionName: "GitHub",
                triggerId: "trig_1",
                payload: { body: "please fix this" },
                deliverAs: "steer",
                ts: new Date().toISOString(),
            },
        });

        await sleep(120);
        expect(sendUserMessage).not.toHaveBeenCalled();

        markWorkerStartupComplete();
        await Promise.resolve();
        await sleep(0);

        expect(sendUserMessage).toHaveBeenCalledTimes(1);
        const firstCall = sendUserMessage.mock.calls[0] as unknown as [string, { deliverAs?: "followUp" | "steer" }?];
        expect(firstCall[0]).toContain("<!-- trigger:trig_1");
        expect(firstCall[0]).toContain("GitHub");
    });

    test("buffers remote input until worker startup completes", async () => {
        armWorkerStartupGate();

        const sendUserMessage = mock(() => {});
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
            buildHeartbeat: () => ({ type: "heartbeat" }),
            relayHttpBaseUrl: () => "http://relay.test",
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

        connect(rctx, handlers);
        expect(lastSocket).toBeTruthy();

        // Simulate remote input arriving before boot completes
        lastSocket!.trigger("input", {
            text: "fix the flaky test please",
        });

        // Give the async handler time to run (it awaits the gate)
        await sleep(50);
        expect(sendUserMessage).not.toHaveBeenCalled();

        markWorkerStartupComplete();
        // Let the awaited promise chain resolve
        await sleep(50);

        expect(sendUserMessage).toHaveBeenCalledTimes(1);
        const firstCall = sendUserMessage.mock.calls[0] as unknown as [string];
        expect(firstCall[0]).toBe("fix the flaky test please");
    });

    test("delivers immediately when gate is not armed (normal CLI session)", async () => {
        // Don't arm the gate — simulates a normal interactive CLI session
        const sendUserMessage = mock(() => {});
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

        connect(rctx, handlers);
        expect(lastSocket).toBeTruthy();

        lastSocket!.trigger("session_trigger", {
            trigger: {
                type: "github:pr_comment",
                sourceSessionId: "external:github",
                sourceSessionName: "GitHub",
                triggerId: "trig_2",
                payload: { body: "looks good" },
                deliverAs: "steer",
                ts: new Date().toISOString(),
            },
        });

        // Trigger batch debounce is 80ms
        await sleep(120);
        expect(sendUserMessage).toHaveBeenCalledTimes(1);
    });

    // NOTE: regression coverage for the "isAgentActive -> default deliverAs"
    // path lives in deliver-as-default.test.ts as a focused unit test. Adding
    // it to this file requires fleshing out several more mocks first — see
    // the preamble comment above. Tracked as a separate cleanup.
});
