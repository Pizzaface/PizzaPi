/**
 * Tests for local-TUI transition cleanup parity (A1-007).
 *
 * Local TUI: pi fires session_start for /new, /resume, /fork.
 * Worker: emits session_switch manually — must NOT double-clean.
 *
 * Verifies:
 *  1. Startup (first) session_start does NOT clean stale child state.
 *  2. A subsequent session_start DOES clean (stale child links / trigger
 *     cancels cleared, session-complete state reset).
 *  3. Worker path (localTuiTransitionCleanup=false) — session_start never
 *     cleans; session_switch (reason:"new") still cleans exactly once.
 */
import { describe, test, expect, mock, afterEach } from "bun:test";
import type { LifecycleHandlerState } from "./lifecycle-handlers.js";
import type { RelayContext } from "../remote-types.js";

// ── Module mocks (must appear before any local import of the mocked modules) ──

// Stub out heavy chunked-delivery internals — session_active shape is not
// what this test verifies; we only care about state side-effects.
mock.module("./chunked-delivery.js", () => ({
    emitSessionActive: () => {},
    emitSessionMetadataUpdate: () => {},
}));

mock.module("../triggers/extension.js", () => ({
    clearAndCancelPendingTriggers: (_cb: any) => ({ cancelled: 0, sent: [], failed: [] }),
    receivedTriggers: new Map(),
}));

mock.module("../trigger-client.js", () => ({
    listTriggerSubscriptions: async (_sid: string) => [],
    unsubscribeTrigger: async () => ({ ok: true }),
}));

// Mocked after module mocks are registered:
import { registerLifecycleHandlers } from "./lifecycle-handlers.js";
import { createFollowUpGrace } from "./followup-grace.js";

// ── Helpers ────────────────────────────────────────────────────────────────────

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

function makeRctx(overrides: Partial<RelayContext> = {}): RelayContext {
    const pi: any = {
        on: () => {},
        events: { on: () => {} },
        registerTool: () => {},
        registerCommand: () => {},
    };
    return {
        pi,
        isChildSession: false,
        parentSessionId: null,
        relay: null,
        sioSocket: null,
        isAgentActive: false,
        isAgentSettling: false,
        lastRetryableError: null,
        wasAborted: false,
        shuttingDown: false,
        forwardEvent: mock(() => {}),
        buildHeartbeat: () => ({ type: "heartbeat", ts: Date.now() }),
        buildCapabilitiesState: () => ({}),
        setRelayStatus: () => {},
        disconnectedStatusText: () => "Not connected",
        emitSessionActive: () => {},
        relaySessionId: null,
        apiKey: () => null,
        relayUrl: () => "",
        pendingAskUserQuestion: null,
        getCurrentThinkingLevel: () => null,
        relayStatusText: "",
        ...overrides,
    } as unknown as RelayContext;
}

function makeMinimalDeps() {
    const handlers = new Map<string, (event: any, ctx: any) => void>();
    const pi: any = {
        on: (name: string, fn: any) => handlers.set(name, fn),
        events: { on: () => {} },
        registerTool: () => {},
        registerCommand: () => {},
    };
    const state = makeState();
    const rctx = makeRctx();
    const followUpGrace = createFollowUpGrace(rctx, state as any);

    const delinkManager: any = {
        clearPendingDelinkRetryTimer: () => {},
        clearPendingDelinkOwnParentRetryTimer: () => {},
        emitDelinkChildren: () => {},
        emitDelinkOwnParent: () => {},
    };
    const cancellationManager: any = {
        stopPendingCancellationRetryLoop: () => {},
        startPendingCancellationRetryLoop: () => {},
    };
    const triggerWaits: any = { cancelAll: () => 0 };

    registerLifecycleHandlers({
        pi,
        rctx,
        state,
        triggerWaits,
        delinkManager,
        cancellationManager,
        followUpGrace,
        startSessionNameSync: () => {},
        stopSessionNameSync: () => {},
        doConnect: () => {},
        doDisconnect: () => {},
        clearCtx: () => {},
    });

    return { handlers, state, rctx, pi };
}

const minimalCtx = {
    hasPendingMessages: () => false,
    shutdown: () => {},
    ui: { notify: () => {}, setFooter: () => ({}) },
    model: null,
    sessionManager: { getSessionName: () => null },
};

// ── Tests ──────────────────────────────────────────────────────────────────────

describe("local-TUI transition cleanup parity", () => {
    const originalWorkerCwd = process.env.PIZZAPI_WORKER_CWD;
    afterEach(() => {
        // Restore env so worker tests don't pollute local-TUI tests and vice versa.
        if (originalWorkerCwd === undefined) {
            delete process.env.PIZZAPI_WORKER_CWD;
        } else {
            process.env.PIZZAPI_WORKER_CWD = originalWorkerCwd;
        }
    });
    describe("localTuiTransitionCleanup = true (local TUI path)", () => {
        test("startup (first) session_start does NOT clean stale state", () => {
            delete process.env.PIZZAPI_WORKER_CWD;
            const { handlers, state } = makeMinimalDeps();
            const sessionStart = handlers.get("session_start")!;

            // Pre-seed some stale child IDs and pending cancellations
            state.staleChildIds.add("child-session-old");
            state.pendingCancellations.push({ triggerId: "t1", childSessionId: "child-a" });
            const genBefore = state.sessionCompleteGeneration;

            sessionStart({}, minimalCtx);

            // First session_start must NOT clear stale state
            expect(state.staleChildIds.has("child-session-old")).toBe(true);
            expect(state.pendingCancellations).toHaveLength(1);
            // session-complete generation must NOT be bumped by cleanup
            // (no cleanup ran; session_start itself doesn't bump it)
            expect(state.sessionCompleteGeneration).toBe(genBefore);
        });

        test("second session_start DOES clear stale child links and reset session-complete state", () => {
            delete process.env.PIZZAPI_WORKER_CWD;
            const { handlers, state } = makeMinimalDeps();
            const sessionStart = handlers.get("session_start")!;

            // First (startup) call
            sessionStart({}, minimalCtx);

            // Seed stale state to verify cleanup
            state.staleChildIds.add("child-stale");
            state.sessionCompleteFired = true;
            const genBefore = state.sessionCompleteGeneration;

            // Second call (transition: /new, /resume, /fork)
            sessionStart({}, minimalCtx);

            expect(state.staleChildIds.has("child-stale")).toBe(false);
            expect(state.pendingDelink).toBe(true);
            expect(state.sessionCompleteFired).toBe(false);
            expect(state.sessionCompleteGeneration).toBe(genBefore + 1);
        });

        test("third session_start also cleans (every subsequent start is a transition)", () => {
            delete process.env.PIZZAPI_WORKER_CWD;
            const { handlers, state } = makeMinimalDeps();
            const sessionStart = handlers.get("session_start")!;

            sessionStart({}, minimalCtx); // startup
            sessionStart({}, minimalCtx); // transition 1

            state.staleChildIds.add("child-2");
            state.sessionCompleteFired = true;
            const genBefore = state.sessionCompleteGeneration;

            sessionStart({}, minimalCtx); // transition 2

            expect(state.staleChildIds.has("child-2")).toBe(false);
            expect(state.sessionCompleteFired).toBe(false);
            expect(state.sessionCompleteGeneration).toBe(genBefore + 1);
        });
    });

    describe("localTuiTransitionCleanup = false (worker path)", () => {
        test("session_start never triggers cleanup, regardless of call count", () => {
            process.env.PIZZAPI_WORKER_CWD = "/tmp/worker-cwd";
            const { handlers, state } = makeMinimalDeps();
            const sessionStart = handlers.get("session_start")!;

            sessionStart({}, minimalCtx); // startup

            state.staleChildIds.add("child-stale");
            state.sessionCompleteFired = true;
            const genBefore = state.sessionCompleteGeneration;

            sessionStart({}, minimalCtx); // second call — should NOT clean

            expect(state.staleChildIds.has("child-stale")).toBe(true);
            expect(state.sessionCompleteFired).toBe(true);
            expect(state.sessionCompleteGeneration).toBe(genBefore);
        });

        test("session_switch with reason:new cleans exactly once (no double-clean)", () => {
            process.env.PIZZAPI_WORKER_CWD = "/tmp/worker-cwd";
            const { handlers, state, rctx } = makeMinimalDeps();
            const sessionStart = handlers.get("session_start")!;
            const sessionSwitch = handlers.get("session_switch")!;

            // Worker fires session_start first (pi's native event)
            sessionStart({}, minimalCtx);

            state.staleChildIds.add("child-stale");
            state.sessionCompleteFired = true;
            const genBefore = state.sessionCompleteGeneration;

            // Worker then emits session_switch manually
            sessionSwitch({ reason: "new" }, minimalCtx);

            // Cleanup ran exactly once (from session_switch)
            expect(state.staleChildIds.has("child-stale")).toBe(false);
            expect(state.pendingDelink).toBe(true);
            expect(state.sessionCompleteFired).toBe(false);
            // sessionCompleteGeneration bumped once by performSessionTransitionCleanup
            expect(state.sessionCompleteGeneration).toBe(genBefore + 1);
        });
    });
});
