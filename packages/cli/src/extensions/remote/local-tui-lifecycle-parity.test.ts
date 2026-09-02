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

            sessionStart({ reason: "startup" }, minimalCtx);

            // First session_start must NOT clear stale state
            expect(state.staleChildIds.has("child-session-old")).toBe(true);
            expect(state.pendingCancellations).toHaveLength(1);
            // session-complete generation must NOT be bumped by cleanup
            expect(state.sessionCompleteGeneration).toBe(genBefore);
        });

        test("session_start with reason:new DOES clear stale child links and reset session-complete state", () => {
            delete process.env.PIZZAPI_WORKER_CWD;
            const { handlers, state } = makeMinimalDeps();
            const sessionStart = handlers.get("session_start")!;

            // Startup
            sessionStart({ reason: "startup" }, minimalCtx);

            // Seed stale state to verify cleanup
            state.staleChildIds.add("child-stale");
            state.sessionCompleteFired = true;
            const genBefore = state.sessionCompleteGeneration;

            // Transition: /new
            sessionStart({ reason: "new" }, minimalCtx);

            expect(state.staleChildIds.has("child-stale")).toBe(false);
            expect(state.pendingDelink).toBe(true);
            expect(state.sessionCompleteFired).toBe(false);
            expect(state.sessionCompleteGeneration).toBe(genBefore + 1);
        });

        test("session_start with reason:resume and reason:fork also clean", () => {
            delete process.env.PIZZAPI_WORKER_CWD;
            const { handlers, state } = makeMinimalDeps();
            const sessionStart = handlers.get("session_start")!;

            sessionStart({ reason: "startup" }, minimalCtx);

            state.staleChildIds.add("child-resume");
            state.sessionCompleteFired = true;
            let genBefore = state.sessionCompleteGeneration;

            sessionStart({ reason: "resume" }, minimalCtx);
            expect(state.staleChildIds.has("child-resume")).toBe(false);
            expect(state.sessionCompleteGeneration).toBe(genBefore + 1);

            state.staleChildIds.add("child-fork");
            state.sessionCompleteFired = true;
            genBefore = state.sessionCompleteGeneration;

            sessionStart({ reason: "fork" }, minimalCtx);
            expect(state.staleChildIds.has("child-fork")).toBe(false);
            expect(state.sessionCompleteGeneration).toBe(genBefore + 1);
        });

        test("session_start with reason:reload does NOT clean (regression guard)", () => {
            delete process.env.PIZZAPI_WORKER_CWD;
            const { handlers, state } = makeMinimalDeps();
            const sessionStart = handlers.get("session_start")!;

            sessionStart({ reason: "startup" }, minimalCtx);

            // Simulate in-flight child state that must survive a /reload
            state.staleChildIds.add("child-in-flight");
            state.pendingCancellations.push({ triggerId: "t-reload", childSessionId: "child-in-flight" });
            const genBefore = state.sessionCompleteGeneration;

            // /reload fires session_start with reason:"reload"
            sessionStart({ reason: "reload" }, minimalCtx);

            // Must NOT be cleaned
            expect(state.staleChildIds.has("child-in-flight")).toBe(true);
            expect(state.pendingCancellations).toHaveLength(1);
            expect(state.sessionCompleteGeneration).toBe(genBefore);
        });

        test("session_start with reason:startup after a transition does NOT clean", () => {
            delete process.env.PIZZAPI_WORKER_CWD;
            const { handlers, state } = makeMinimalDeps();
            const sessionStart = handlers.get("session_start")!;

            // Startup then a real transition
            sessionStart({ reason: "startup" }, minimalCtx);
            sessionStart({ reason: "new" }, minimalCtx);

            state.staleChildIds.add("child-should-survive");
            const genBefore = state.sessionCompleteGeneration;

            // Another startup-reason (shouldn't happen in practice, but must be safe)
            sessionStart({ reason: "startup" }, minimalCtx);

            expect(state.staleChildIds.has("child-should-survive")).toBe(true);
            expect(state.sessionCompleteGeneration).toBe(genBefore);
        });
    });

    describe("localTuiTransitionCleanup = false (worker path)", () => {
        test("session_start never triggers cleanup, regardless of call count", () => {
            process.env.PIZZAPI_WORKER_CWD = "/tmp/worker-cwd";
            const { handlers, state } = makeMinimalDeps();
            const sessionStart = handlers.get("session_start")!;

            sessionStart({ reason: "startup" }, minimalCtx);

            state.staleChildIds.add("child-stale");
            state.sessionCompleteFired = true;
            const genBefore = state.sessionCompleteGeneration;

            sessionStart({ reason: "new" }, minimalCtx); // second call — should NOT clean (worker path)

            expect(state.staleChildIds.has("child-stale")).toBe(true);
            expect(state.sessionCompleteFired).toBe(true);
            expect(state.sessionCompleteGeneration).toBe(genBefore);
        });

        test("session_switch with reason:new cleans exactly once (no double-clean)", () => {
            process.env.PIZZAPI_WORKER_CWD = "/tmp/worker-cwd";
            const { handlers, state } = makeMinimalDeps();
            const sessionStart = handlers.get("session_start")!;
            const sessionSwitch = handlers.get("session_switch")!;

            // Worker fires session_start first (pi's native event)
            sessionStart({ reason: "startup" }, minimalCtx);

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
