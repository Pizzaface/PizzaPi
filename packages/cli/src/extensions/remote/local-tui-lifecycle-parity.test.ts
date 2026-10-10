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

// Mutable capture so tests can inspect the `before` cutoff a given
// clearTriggerHistory call was invoked with (GM a8yAXXwa round 2).
const _clearTriggerHistoryCalls: Array<number | undefined> = [];

mock.module("../trigger-client.js", () => ({
    listTriggerSubscriptions: async (_sid: string) => [],
    unsubscribeTrigger: async () => ({ ok: true }),
    clearTriggerHistory: async (_sid: string, _deps: unknown, before?: number) => {
        _clearTriggerHistoryCalls.push(before);
        return { ok: true };
    },
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

function makeMinimalDeps(rctxOverrides: Partial<RelayContext> = {}, delinkManagerOverrides: Record<string, (...args: any[]) => any> = {}) {
    const handlers = new Map<string, (event: any, ctx: any) => void>();
    const pi: any = {
        on: (name: string, fn: any) => handlers.set(name, fn),
        events: { on: () => {} },
        registerTool: () => {},
        registerCommand: () => {},
    };
    const state = makeState();
    const rctx = makeRctx(rctxOverrides);
    const followUpGrace = createFollowUpGrace(rctx, state as any);

    const delinkManager: any = {
        clearPendingDelinkRetryTimer: () => {},
        clearPendingDelinkOwnParentRetryTimer: () => {},
        emitDelinkChildren: () => {},
        emitDelinkOwnParent: () => {},
        ...delinkManagerOverrides,
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

    return { handlers, state, rctx, pi, delinkManager, triggerWaits };
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

        test("session_switch with reason:resume and reason:fork also clean (worker/local-TUI parity — GM a8yAXXwa)", () => {
            // Regression guard: worker session_switch must clean stale child
            // state on resume/fork exactly like local-TUI session_start does.
            // Before the fix, only reason:"new" ran performSessionTransitionCleanup
            // on the worker path, so a /resume or /fork there silently inherited
            // the previous generation's stale child links and trigger subscriptions.
            process.env.PIZZAPI_WORKER_CWD = "/tmp/worker-cwd";
            const { handlers, state } = makeMinimalDeps();
            const sessionStart = handlers.get("session_start")!;
            const sessionSwitch = handlers.get("session_switch")!;

            sessionStart({ reason: "startup" }, minimalCtx);

            state.staleChildIds.add("child-resume-stale");
            state.sessionCompleteFired = true;
            let genBefore = state.sessionCompleteGeneration;

            sessionSwitch({ reason: "resume" }, minimalCtx);

            expect(state.staleChildIds.has("child-resume-stale")).toBe(false);
            expect(state.pendingDelink).toBe(true);
            expect(state.sessionCompleteFired).toBe(false);
            expect(state.sessionCompleteGeneration).toBe(genBefore + 1);

            state.staleChildIds.add("child-fork-stale");
            state.sessionCompleteFired = true;
            state.pendingDelink = false;
            genBefore = state.sessionCompleteGeneration;

            sessionSwitch({ reason: "fork" }, minimalCtx);

            expect(state.staleChildIds.has("child-fork-stale")).toBe(false);
            expect(state.pendingDelink).toBe(true);
            expect(state.sessionCompleteFired).toBe(false);
            expect(state.sessionCompleteGeneration).toBe(genBefore + 1);
        });

        // Suspend-wake respawn boot resume (PR #994 P1, live-test finding):
        // initial-prompt.ts tags its boot-time switchSession(resumePath) call
        // with { reason: "wake" } only when PIZZAPI_WAKE_RESUME was set by the
        // daemon for a suspend-wake respawn (see runner/session-spawner.ts /
        // runner/daemon.ts "wake" field threaded from server events/transport.ts
        // wakeOfflineSession). That must NOT run performSessionTransitionCleanup
        // — it is the SAME conversation continuing, not a new generation, and
        // cleanup would delink the woken session from its parent and cancel its
        // trigger subscriptions even though nothing about the conversation
        // changed. A later real /resume inside the same worker (reason
        // "resume", the default — no wake tag) must still clean up normally.
        test("session_switch with reason:wake does NOT delink and keeps the parent link", () => {
            process.env.PIZZAPI_WORKER_CWD = "/tmp/worker-cwd";
            const emitDelinkChildren = mock(() => {});
            const emitDelinkOwnParent = mock(() => {});
            const { handlers, state, rctx, triggerWaits } = makeMinimalDeps(
                { isChildSession: true, parentSessionId: "parent-session-1" },
                { emitDelinkChildren, emitDelinkOwnParent },
            );
            const cancelAllSpy = mock(() => 0);
            (triggerWaits as any).cancelAll = cancelAllSpy;
            const sessionStart = handlers.get("session_start")!;
            const sessionSwitch = handlers.get("session_switch")!;

            sessionStart({ reason: "startup" }, minimalCtx);

            state.staleChildIds.add("child-wake-stale");
            state.sessionCompleteFired = true;
            const genBefore = state.sessionCompleteGeneration;

            sessionSwitch({ reason: "wake" }, minimalCtx);

            // No delink, no cancellation, no trigger unsubscribe/history clear.
            expect(emitDelinkChildren).not.toHaveBeenCalled();
            expect(emitDelinkOwnParent).not.toHaveBeenCalled();
            expect(cancelAllSpy).not.toHaveBeenCalled();
            expect(state.pendingDelink).toBe(false);
            expect(state.pendingDelinkOwnParent).toBe(false);
            // Stale child ids are from the real prior generation's cleanup, not
            // touched by this path — only performSessionTransitionCleanup clears
            // staleChildIds, and wake must not call it.
            expect(state.staleChildIds.has("child-wake-stale")).toBe(true);
            // The parent link must survive a wake boot resume.
            expect(rctx.isChildSession).toBe(true);
            expect(rctx.parentSessionId).toBe("parent-session-1");
            // Session-complete grace/arm state still resets so the woken session
            // can fire session_complete again once idle (defensive-fallback
            // branch still runs for any non-transition reason).
            expect(state.sessionCompleteFired).toBe(false);
            expect(state.sessionCompleteGeneration).toBe(genBefore + 1);
        });

        test("a real /resume after a wake boot still delinks and clears the parent link", () => {
            process.env.PIZZAPI_WORKER_CWD = "/tmp/worker-cwd";
            const { handlers, state, rctx } = makeMinimalDeps({ isChildSession: true, parentSessionId: "parent-session-1" });
            const sessionStart = handlers.get("session_start")!;
            const sessionSwitch = handlers.get("session_switch")!;

            sessionStart({ reason: "startup" }, minimalCtx);
            // Wake boot resume — keeps the link (asserted in the previous test).
            sessionSwitch({ reason: "wake" }, minimalCtx);
            expect(rctx.isChildSession).toBe(true);
            expect(state.pendingDelink).toBe(false);

            // User later runs a real /resume inside this same woken worker.
            sessionSwitch({ reason: "resume" }, minimalCtx);

            // performSessionTransitionCleanup runs (unlike the wake boot above):
            // pendingDelink/pendingDelinkOwnParent flip, and the parent link is
            // actually cleared on rctx — matching the pre-existing
            // reason:resume/fork parity test above.
            expect(state.pendingDelink).toBe(true);
            expect(state.pendingDelinkOwnParent).toBe(true);
            expect(rctx.isChildSession).toBe(false);
            expect(rctx.parentSessionId).toBeNull();
        });
    });
});

// ── clearTriggerHistory cutoff must be relay-clock-corrected (GM a8yAXXwa round 2) ──
//
// `clearTriggerHistory`'s `before` cutoff is compared against relay-local
// `recordedAt` timestamps (trigger-store.ts). A CLI host's raw local clock
// can drift from the relay's by many seconds; sending it uncorrected either
// lets recent pre-transition entries survive (CLI clock behind) or hides
// genuinely-new post-transition entries once the server's future-cutoff
// clamp kicks in (CLI clock ahead + any transit delay). The fix applies the
// same relay-clock-offset tracking `delink-management.ts` already uses for
// epoch-based delink filtering (`serverClockOffset`, maintained from each
// `registered` event's `serverTime` — see `remote/connection.ts`).
describe("clearTriggerHistory cutoff is relay-clock-corrected", () => {
    test("performSessionTransitionCleanup passes before = local now + serverClockOffset, not raw local Date.now()", () => {
        delete process.env.PIZZAPI_WORKER_CWD;
        _clearTriggerHistoryCalls.length = 0;

        const { handlers, state } = makeMinimalDeps({ relaySessionId: "session-under-test" });
        // Simulate a CLI host clock running 10s BEHIND the relay's. The offset
        // is `serverTime - Date.now()` measured at registration, so a
        // behind-clock CLI yields a *positive* correction.
        state.serverClockOffset = 10_000;
        const sessionStart = handlers.get("session_start")!;

        sessionStart({ reason: "startup" }, minimalCtx);

        const localBefore = Date.now();
        sessionStart({ reason: "new" }, minimalCtx);
        const localAfter = Date.now();

        expect(_clearTriggerHistoryCalls).toHaveLength(1);
        const cutoff = _clearTriggerHistoryCalls[0];
        expect(cutoff).toBeDefined();
        // Must land near (local now + 10s), not near bare local now — proving
        // the offset was actually applied rather than ignored.
        expect(cutoff!).toBeGreaterThanOrEqual(localBefore + 10_000);
        expect(cutoff!).toBeLessThanOrEqual(localAfter + 10_000);
    });

    test("a CLI clock running ahead is corrected too (negative offset)", () => {
        delete process.env.PIZZAPI_WORKER_CWD;
        _clearTriggerHistoryCalls.length = 0;

        const { handlers, state } = makeMinimalDeps({ relaySessionId: "session-under-test-2" });
        // CLI clock running 10s AHEAD of the relay's → negative correction.
        state.serverClockOffset = -10_000;
        const sessionStart = handlers.get("session_start")!;

        sessionStart({ reason: "startup" }, minimalCtx);

        const localBefore = Date.now();
        sessionStart({ reason: "new" }, minimalCtx);
        const localAfter = Date.now();

        expect(_clearTriggerHistoryCalls).toHaveLength(1);
        const cutoff = _clearTriggerHistoryCalls[0];
        expect(cutoff).toBeDefined();
        expect(cutoff!).toBeGreaterThanOrEqual(localBefore - 10_000);
        expect(cutoff!).toBeLessThanOrEqual(localAfter - 10_000);
    });
});
