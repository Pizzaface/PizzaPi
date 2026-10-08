/**
 * Integration regression: connection.ts (relay socket handlers) →
 * connection-handlers-factory.ts (ConnectionHandlers.sendUserMessage) →
 * SessionHost.sendUserMessage → AgentSession.prompt().
 *
 * Proves the two live call sites (web input, trigger batch) route through the
 * real SessionHost with the correct PromptOptions, and that the retired
 * ExtensionAPI fallback (`pi.sendUserMessage`) is never invoked — it isn't
 * even part of ConnectionHandlersDeps anymore (see connection-handlers-factory.ts).
 */
import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { LINKED_SESSION_MESSAGE_TYPE, TRIGGER_MESSAGE_TYPE } from "@pizzapi/protocol";
import { SessionHost } from "../../runner/session-host.js";

class FakeSocket {
    handlers = new Map<string, Array<(...args: any[]) => void>>();
    connected = true;
    emit = mock((_event: string, _data?: any) => {});
    removeAllListeners = mock(() => this.handlers.clear());
    disconnect = mock(() => { this.connected = false; });
    on(event: string, handler: (data: any) => void) {
        const list = this.handlers.get(event) ?? [];
        list.push(handler);
        this.handlers.set(event, list);
        return this;
    }
    off() { return this; }
    trigger(event: string, ...args: any[]) {
        for (const handler of this.handlers.get(event) ?? []) handler(...args);
    }
    io = { on: () => this.io };
}

let lastSocket: FakeSocket | null = null;
let consumeApproval = false;

mock.module("socket.io-client", () => ({
    io: mock(() => { lastSocket = new FakeSocket(); return lastSocket; }),
}));
mock.module("../../config.js", () => ({
    loadConfig: mock(() => ({ relayUrl: "ws://relay.test" })),
    expandHome: (path: string) => path,
}));
mock.module("../../backoff.js", () => ({
    RELAY_BACKOFF_DEFAULTS: { baseMs: 1000, maxMs: 30000, jitterFactor: 0.25 },
    computeBackoffDelay: mock(() => 1000),
}));
mock.module("../mcp-bridge.js", () => ({ getMcpBridge: mock(() => null) }));
mock.module("../session-message-bus.js", () => ({
    messageBus: { setOwnSessionId: mock(() => {}), setSendFn: mock(() => {}), receive: mock(() => {}) },
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
    emitTodoUpdated: mock(() => {}), emitQuestionPending: mock(() => {}), emitQuestionCleared: mock(() => {}),
    emitPlanPending: mock(() => {}), emitPlanCleared: mock(() => {}), emitPlanModeToggled: mock(() => {}),
    emitCompactStarted: mock(() => {}), emitCompactEnded: mock(() => {}), emitRetryStateChanged: mock(() => {}),
    emitPluginTrustRequired: mock(() => {}), emitPluginTrustResolved: mock(() => {}), emitMcpStartupReport: mock(() => {}),
    emitTokenUsageUpdated: mock(() => {}), emitThinkingLevelChanged: mock(() => {}), emitAuthSourceChanged: mock(() => {}),
    emitModelChanged: mock(() => {}), emitGoalUpdated: mock(() => {}),
    emitApprovalPending: mock(() => {}), emitApprovalCleared: mock(() => {}),
}));
mock.module("../remote-auth-source.js", () => ({ getAuthSource: mock(() => null), authSourceLabel: mock(() => "") }));
mock.module("../remote-approval.js", () => ({
    consumePendingApprovalFromWeb: mock(() => consumeApproval),
    cancelPendingApproval: mock(() => {}),
    registerApprovalBridge: mock(() => () => {}),
    setApprovalHandler: mock(() => {}),
    clearApprovalHandler: mock(() => {}),
    getApprovalHandler: mock(() => null),
    requestApprovalViaWeb: mock(async () => false),
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
const { createConnectionHandlers } = await import("./connection-handlers-factory.js");
const { _resetWorkerStartupGateForTesting } = await import("../worker-startup-gate.js");

mock.restore();

function sleep(ms: number) {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

function makeRctx(sessionHost: SessionHost) {
    const forwardEvent = mock((_e: unknown) => {});
    return {
        rctx: {
            shuttingDown: false,
            sioSocket: null,
            relay: null,
            relaySessionId: null,
            isAgentActive: false,
            sessionHost,
            apiKey: () => "test-key",
            relayUrl: () => "ws://relay.test",
            disconnectedStatusText: () => "Disconnected",
            setRelayStatus: mock(() => {}),
            getCurrentSessionName: () => null,
            getCurrentThinkingLevel: () => null,
            forwardEvent,
            buildCapabilitiesState: () => ({ type: "capabilities" }),
            buildHeartbeat: () => ({ type: "heartbeat" }),
            relayHttpBaseUrl: () => "http://relay.test",
        } as any,
        forwardEvent,
    };
}

function makeState() {
    return {
        pendingDelinkOwnParent: false,
        serverClockOffset: 0,
        staleChildIds: new Set<string>(),
        stalePrimaryParentId: null,
        pendingDelink: false,
        pendingDelinkEpoch: null,
        pendingCancellations: [],
        sessionCompleteFired: false,
        sessionCompleteTransportGeneration: 0,
        pendingSessionCompleteDelivery: null,
        pendingSessionCompleteSocket: null,
        pendingSessionCompleteTransportGeneration: null,
        sessionCompleteRetryTimer: null,
        lastSessionCompletePayload: null,
    };
}

describe("connection handler -> SessionHost -> AgentSession.prompt integration", () => {
    beforeEach(() => {
        lastSocket = null;
        consumeApproval = false;
        _resetWorkerStartupGateForTesting();
    });
    afterEach(() => {
        _resetWorkerStartupGateForTesting();
    });

    test("web input carries expandPromptTemplates:true, source:extension, and resolved streaming behavior", async () => {
        const promptCalls: Array<{ text: string; options: any }> = [];
        const fakeSession = {
            prompt: async (text: string, options: any) => { promptCalls.push({ text, options }); },
        } as any;
        const host = new SessionHost(() => fakeSession, {
            newSession: async () => ({ cancelled: false }),
            switchSession: async () => ({ cancelled: false }),
            fork: async () => ({ cancelled: false }),
        });
        const { rctx } = makeRctx(host);
        const { connectionHandlers } = createConnectionHandlers({
            rctx,
            state: makeState() as any,
            triggerWaits: { cancelAll: () => 0 } as any,
            delinkManager: {} as any,
            cancellationManager: {} as any,
            followUpGrace: { clearFollowUpGrace: () => {} } as any,
            setModelFromWeb: async () => {},
        });

        connect(rctx, connectionHandlers);
        expect(lastSocket).toBeTruthy();

        lastSocket!.trigger("input", { text: "fix the flaky test please" });
        await sleep(30);

        expect(promptCalls).toHaveLength(1);
        expect(promptCalls[0].text).toBe("fix the flaky test please");
        expect(promptCalls[0].options).toEqual({
            expandPromptTemplates: true,
            streamingBehavior: undefined,
            images: undefined,
            source: "extension",
            preflightResult: expect.any(Function),
        });
    });

    test("acks on acceptance, not when a long agent run finishes", async () => {
        // pi resolves prompt()/sendCustomMessage() only after the whole run on an
        // idle session; the relay gives up after 10s and reports "did not acknowledge".
        const never = new Promise<void>(() => {});
        const fakeSession = {
            prompt: (_text: string, options: any) => { options.preflightResult?.("started"); return never; },
            sendCustomMessage: () => never,
        } as any;
        const host = new SessionHost(() => fakeSession, {
            newSession: async () => ({ cancelled: false }),
            switchSession: async () => ({ cancelled: false }),
            fork: async () => ({ cancelled: false }),
        });
        const { rctx } = makeRctx(host);
        const { connectionHandlers } = createConnectionHandlers({
            rctx,
            state: makeState() as any,
            triggerWaits: { cancelAll: () => 0 } as any,
            delinkManager: {} as any,
            cancellationManager: {} as any,
            followUpGrace: { clearFollowUpGrace: () => {} } as any,
            setModelFromWeb: async () => {},
        });
        const userAck = mock((_delivered: boolean) => {});
        const linkedAck = mock((_delivered: boolean) => {});

        connect(rctx, connectionHandlers);
        lastSocket!.trigger("input", { text: "do a long task" }, userAck);
        lastSocket!.trigger("input", { text: "Message from linked session child-1:\n\nhi", message: "hi", client: "agent", fromSessionId: "child-1" }, linkedAck);
        await sleep(30);

        expect(userAck).toHaveBeenCalledWith(true);
        expect(linkedAck).toHaveBeenCalledWith(true);
    });

    test("agent input does not consume pending human approvals", async () => {
        const promptCalls: Array<{ text: string; options: any }> = [];
        const fakeSession = {
            prompt: async (text: string, options: any) => { promptCalls.push({ text, options }); },
        } as any;
        const host = new SessionHost(() => fakeSession, {
            newSession: async () => ({ cancelled: false }),
            switchSession: async () => ({ cancelled: false }),
            fork: async () => ({ cancelled: false }),
        });
        const { rctx } = makeRctx(host);
        const { connectionHandlers } = createConnectionHandlers({
            rctx,
            state: makeState() as any,
            triggerWaits: { cancelAll: () => 0 } as any,
            delinkManager: {} as any,
            cancellationManager: {} as any,
            followUpGrace: { clearFollowUpGrace: () => {} } as any,
            setModelFromWeb: async () => {},
        });
        consumeApproval = true;
        const ack = mock((_delivered: boolean) => {});

        connect(rctx, connectionHandlers);
        lastSocket!.trigger("input", { text: "yes", client: "agent", fromSessionId: "child-1" }, ack);
        await sleep(30);

        expect(ack).toHaveBeenCalledWith(true);
        expect(promptCalls).toHaveLength(1);
        expect(promptCalls[0].text).toBe("yes");
    });

    test("linked-session input is injected as a structured custom message", async () => {
        const custom: Array<{ message: any; options: any }> = [];
        const fakeSession = {
            prompt: mock(async () => {}),
            sendCustomMessage: async (message: any, options: any) => { custom.push({ message, options }); },
        } as any;
        const host = new SessionHost(() => fakeSession, {
            newSession: async () => ({ cancelled: false }),
            switchSession: async () => ({ cancelled: false }),
            fork: async () => ({ cancelled: false }),
        });
        const { rctx } = makeRctx(host);
        const { connectionHandlers } = createConnectionHandlers({
            rctx,
            state: makeState() as any,
            triggerWaits: { cancelAll: () => 0 } as any,
            delinkManager: {} as any,
            cancellationManager: {} as any,
            followUpGrace: { clearFollowUpGrace: () => {} } as any,
            setModelFromWeb: async () => {},
        });
        const ack = mock((_delivered: boolean) => {});

        connect(rctx, connectionHandlers);
        lastSocket!.trigger("input", {
            text: "Message from linked session child-1:\n\nhi",
            message: "hi",
            client: "agent",
            fromSessionId: "child-1",
            deliverAs: "steer",
        }, ack);
        await sleep(30);

        expect(ack).toHaveBeenCalledWith(true);
        expect(fakeSession.prompt).not.toHaveBeenCalled();
        expect(custom).toEqual([{
            message: {
                customType: LINKED_SESSION_MESSAGE_TYPE,
                content: "Message from linked session child-1:\n\nhi",
                display: true,
                details: { fromSessionId: "child-1", message: "hi" },
            },
            options: { triggerTurn: true, deliverAs: "steer" },
        }]);
    });

    test("acknowledges an interactive response consumed by the runner", async () => {
        const fakeSession = { prompt: mock(async () => {}) } as any;
        const host = new SessionHost(() => fakeSession, {
            newSession: async () => ({ cancelled: false }),
            switchSession: async () => ({ cancelled: false }),
            fork: async () => ({ cancelled: false }),
        });
        const { rctx } = makeRctx(host);
        const { connectionHandlers } = createConnectionHandlers({
            rctx,
            state: makeState() as any,
            triggerWaits: { cancelAll: () => 0 } as any,
            delinkManager: {} as any,
            cancellationManager: {} as any,
            followUpGrace: { clearFollowUpGrace: () => {} } as any,
            setModelFromWeb: async () => {},
        });
        consumeApproval = true;
        const ack = mock((_delivered: boolean) => {});

        connect(rctx, connectionHandlers);
        lastSocket!.trigger("input", { text: "approve" }, ack);

        expect(ack).toHaveBeenCalledWith(true);
        expect(fakeSession.prompt).not.toHaveBeenCalled();
    });

    test("trigger batch is injected as a structured custom message with steer streaming", async () => {
        const custom: Array<{ message: any; options: any }> = [];
        const fakeSession = {
            prompt: mock(async () => {}),
            sendCustomMessage: async (message: any, options: any) => { custom.push({ message, options }); },
        } as any;
        const host = new SessionHost(() => fakeSession, {
            newSession: async () => ({ cancelled: false }),
            switchSession: async () => ({ cancelled: false }),
            fork: async () => ({ cancelled: false }),
        });
        const { rctx } = makeRctx(host);
        const { connectionHandlers } = createConnectionHandlers({
            rctx,
            state: makeState() as any,
            triggerWaits: { cancelAll: () => 0 } as any,
            delinkManager: {} as any,
            cancellationManager: {} as any,
            followUpGrace: { clearFollowUpGrace: () => {} } as any,
            setModelFromWeb: async () => {},
        });

        connect(rctx, connectionHandlers);
        expect(lastSocket).toBeTruthy();

        lastSocket!.trigger("session_trigger", {
            trigger: {
                type: "github:pr_comment",
                sourceSessionId: "external:github",
                sourceSessionName: "GitHub",
                triggerId: "trig_integration_1",
                payload: { body: "please fix this" },
                deliverAs: "steer",
                ts: new Date().toISOString(),
            },
        });

        await sleep(120);

        // Never via prompt(): no slash-command / template expansion of trigger text.
        expect(fakeSession.prompt).not.toHaveBeenCalled();
        expect(custom).toHaveLength(1);
        expect(custom[0].options).toEqual({ triggerTurn: true, deliverAs: "steer" });
        expect(custom[0].message.customType).toBe(TRIGGER_MESSAGE_TYPE);
        expect(custom[0].message.content).toContain("<!-- trigger:trig_integration_1");
        expect(custom[0].message.details.triggers[0]).toMatchObject({
            triggerId: "trig_integration_1", type: "github:pr_comment", payload: { body: "please fix this" },
        });
    });

    test("throws (and surfaces a relay-visible cli_error) instead of falling back to pi.sendUserMessage when no SessionHost is set", async () => {
        // createConnectionHandlers no longer accepts a `pi` fallback at all —
        // this is the structural proof the old ExtensionAPI path is unused.
        const { rctx, forwardEvent } = makeRctx(null as any);
        const { connectionHandlers } = createConnectionHandlers({
            rctx,
            state: makeState() as any,
            triggerWaits: { cancelAll: () => 0 } as any,
            delinkManager: {} as any,
            cancellationManager: {} as any,
            followUpGrace: { clearFollowUpGrace: () => {} } as any,
            setModelFromWeb: async () => {},
        });

        connect(rctx, connectionHandlers);
        expect(lastSocket).toBeTruthy();

        lastSocket!.trigger("input", { text: "hello" });
        await sleep(30);

        expect(forwardEvent).toHaveBeenCalledWith(
            expect.objectContaining({ type: "cli_error", source: "remote" }),
        );
    });
});
