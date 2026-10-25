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
    clearTriggerHistory: async () => ({ ok: true }),
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
        events: { on: (name: string, fn: any) => handlers.set(`events:${name}`, fn) },
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
    const doDisconnectCalls: Array<{ final?: boolean } | undefined> = [];

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
        doDisconnect: (opts?: { final?: boolean }) => { doDisconnectCalls.push(opts); },
        clearCtx: () => {},
    });

    const agentEnd = handlers.get("agent_end")!;
    const agentSettled = handlers.get("agent_settled")!;
    return {
        agentEnd,
        agentSettled,
        turnEnd: handlers.get("turn_end")!,
        sessionShutdown: handlers.get("session_shutdown")!,
        doDisconnectCalls,
        emitted,
        rctx,
        handlers,
    };
}

const agentEndCtx = { hasPendingMessages: () => false, shutdown: () => {} };

/** Publishes are promise-chained now — flush microtasks before asserting order. */
function flush(): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, 0));
}

describe("nested tool events", () => {
    test("forwards parentToolCallId from Pi 1.0 nested executions unchanged", () => {
        const { handlers, rctx } = setup(null);
        const event = {
            type: "tool_execution_start",
            toolCallId: "parent/1",
            parentToolCallId: "parent",
            toolName: "read",
            args: { path: "README.md" },
        };

        handlers.get("tool_execution_start")!(event, {});

        expect(rctx.forwardEvent).toHaveBeenCalledWith(event);
    });

    test("strips Pi 1.0 structuredContent from forwarded tool_execution_end", () => {
        const { handlers, rctx } = setup(null);
        const result = {
            content: [{ type: "text", text: "ok" }],
            details: { truncation: null },
            structuredContent: { output: "x".repeat(1024 * 1024), exit_code: 0 },
        };

        handlers.get("tool_execution_end")!({ type: "tool_execution_end", toolCallId: "t1", toolName: "bash", result, isError: false }, {});

        const forwarded = (rctx.forwardEvent as any).mock.calls[0][0];
        expect(forwarded.result).toEqual({ content: result.content, details: result.details });
        expect(result.structuredContent).toBeDefined(); // Pi's own event object is not mutated
    });
});

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

    describe("waiting goal", () => {
        const waitingGoal = (manual = false) => ({
            id: "goal-wait", description: "CI passes", status: "active" as const, turnCount: 1,
            tokenSpend: 15, costSpend: 0,
            waiting: { reason: "CI running", wakeOn: "CI result", ...(manual ? { manual: true } : {}) },
        });

        /** Ack-capable socket; records session_message payloads and answers relay probes. */
        function withRelay(rctx: any, sessionMessageAck: any = { ok: true, delivered: ["parent-session-1"] }) {
            const notices: any[] = [];
            const suspendRequests: any[] = [];
            rctx.relaySessionId = "child-session-1";
            rctx.isAgentActive = false;
            rctx.sioSocket.emit = (event: string, payload: any, ack?: (r: any) => void) => {
                if (event === "session_message") { notices.push(payload); ack?.(sessionMessageAck); }
                else if (event === "get_linked_child_count") ack?.({ ok: true, count: 0 });
                else if (event === "session_suspend") { suspendRequests.push(payload); ack?.({ ok: true }); }
            };
            return { notices, suspendRequests };
        }

        const RETRY_DELAYS = new Set([3_000, 6_000, 12_000, 24_000, 48_000, 60_000]);
        /** Capture the idle-suspend and notice-retry timers instead of waiting on real clocks. */
        async function withSuspendTimers(fn: (fireSuspend: () => Promise<void>, fireRetry: () => Promise<void>, pendingRetries: () => number) => Promise<void>) {
            const realSetTimeout = globalThis.setTimeout;
            const realClearTimeout = globalThis.clearTimeout;
            const suspendTimers: Array<() => void> = [];
            const retryTimers = new Map<number, () => void>();
            let nextId = 1_000_000;
            const prevEnv = process.env.PIZZAPI_RUNNER_USAGE_CACHE_PATH;
            process.env.PIZZAPI_RUNNER_USAGE_CACHE_PATH = "/tmp/usage-cache";
            (globalThis as any).setTimeout = ((cb: () => void, ms?: number, ...rest: any[]) => {
                if (ms === 30 * 60_000) { suspendTimers.push(cb); return 0 as any; }
                if (ms !== undefined && RETRY_DELAYS.has(ms)) { const id = nextId++; retryTimers.set(id, cb); return id as any; }
                return realSetTimeout(cb, ms, ...rest);
            }) as any;
            (globalThis as any).clearTimeout = ((id: any) => {
                if (typeof id === "number" && retryTimers.delete(id)) return;
                realClearTimeout(id);
            }) as any;
            const drain = async (cbs: Array<() => void>) => {
                cbs.forEach((cb) => cb());
                for (let i = 0; i < 5; i++) await flush();
            };
            try {
                await fn(
                    () => drain(suspendTimers.splice(0)),
                    () => { const cbs = [...retryTimers.values()]; retryTimers.clear(); return drain(cbs); },
                    () => retryTimers.size,
                );
            } finally {
                globalThis.setTimeout = realSetTimeout;
                globalThis.clearTimeout = realClearTimeout;
                if (prevEnv === undefined) delete process.env.PIZZAPI_RUNNER_USAGE_CACHE_PATH;
                else process.env.PIZZAPI_RUNNER_USAGE_CACHE_PATH = prevEnv;
            }
        }

        test("notifies the parent once per waiting state instead of reporting completion", async () => {
            const { agentEnd, agentSettled, emitted, rctx } = setup(null);
            const { notices } = withRelay(rctx);
            const shutdown = mock(() => {});
            const ctx = { ...agentEndCtx, shutdown };
            rctx.goalState = waitingGoal();
            agentEnd({ messages: [{ role: "assistant", content: [{ type: "text", text: "CI kicked off" }] }] }, ctx);
            agentSettled({}, ctx);
            await flush();
            expect(emitted).toEqual([]);
            expect(shutdown).not.toHaveBeenCalled();
            expect(notices).toHaveLength(1);
            expect(notices[0]).toMatchObject({ target: "parent", deliverAs: "input" });
            expect(notices[0].message).toContain("NOT complete");
            expect(notices[0].message).toContain("Reason: CI running");
            expect(notices[0].message).toContain("Wakes on: CI result");
            expect(notices[0].message).toContain("CI kicked off");

            agentEnd({ messages: [] }, ctx);
            agentSettled({}, ctx);
            await flush();
            expect(notices).toHaveLength(1); // same waiting state: deduped

            rctx.goalState = waitingGoal(true);
            agentEnd({ messages: [] }, ctx);
            agentSettled({}, ctx);
            await flush();
            expect(notices).toHaveLength(2);
            expect(notices[1].message).toContain("paused");

            rctx.goalState = null;
            agentEnd({ messages: [] }, ctx);
            agentSettled({}, ctx);
            await flush();
            expect(emitted).toEqual(["lifecycle:session_complete"]);
        });

        test("still reports session_error while waiting", async () => {
            const { agentEnd, agentSettled, emitted, rctx } = setup({ errorMessage: "429 rate limit", detectedAt: Date.now() });
            const { notices } = withRelay(rctx);
            rctx.goalState = waitingGoal();
            agentEnd({ messages: [] }, agentEndCtx);
            agentSettled({}, agentEndCtx);
            await flush();
            expect(emitted).toEqual(["lifecycle:session_error"]);
            expect(notices).toHaveLength(1);
        });

        test("failed notice → visible → retried after reconnect → ack, and only then suspendable", async () => {
            await withSuspendTimers(async (fireSuspend, fireRetry) => {
                const { agentEnd, agentSettled, rctx } = setup(null);
                const { notices, suspendRequests } = withRelay(rctx);
                const notify = mock(() => {});
                const shutdown = mock(() => {});
                const ctx = { ...agentEndCtx, shutdown, ui: { notify } };
                rctx.goalState = waitingGoal();
                (rctx.sioSocket as any).connected = false; // relay dropped
                agentEnd({ messages: [] }, ctx);
                agentSettled({}, ctx);
                await flush();
                expect(notices).toHaveLength(0);
                expect(notify).toHaveBeenCalledTimes(1);
                expect(String((notify.mock.calls[0] as any[])[0])).toContain("Not connected to relay");
                await fireSuspend();
                expect(suspendRequests).toHaveLength(0); // no ack → no suspend

                (rctx.sioSocket as any).connected = true; // reconnected
                await fireRetry();
                expect(notices).toHaveLength(1);
                expect(notify).toHaveBeenCalledTimes(1); // retries don't re-toast
                await fireSuspend();
                expect(suspendRequests).toHaveLength(1);
                expect(shutdown).toHaveBeenCalledTimes(1);
            });
        });

        test("stale notice retries are cancelled by a new run or a goal change", async () => {
            await withSuspendTimers(async (_fireSuspend, fireRetry, pendingRetries) => {
                const { agentEnd, agentSettled, rctx, handlers } = setup(null);
                const { notices } = withRelay(rctx, { ok: false, error: "parent offline" });
                const ctx = { ...agentEndCtx, ui: { notify: () => {} } };
                rctx.goalState = waitingGoal();
                agentEnd({ messages: [] }, ctx);
                agentSettled({}, ctx);
                await flush();
                expect(notices).toHaveLength(1);
                expect(pendingRetries()).toBe(1);
                handlers.get("turn_start")!({ type: "turn_start" }, ctx); // woken by input
                expect(pendingRetries()).toBe(0);
                await fireRetry();
                expect(notices).toHaveLength(1);

                agentEnd({ messages: [] }, ctx);
                agentSettled({}, ctx);
                await flush();
                expect(notices).toHaveLength(2);
                expect(pendingRetries()).toBe(1);
                handlers.get("events:goal:state_changed")!({ ...waitingGoal(), waiting: undefined }, {}); // /goal resume
                expect(pendingRetries()).toBe(0);
                await fireRetry();
                expect(notices).toHaveLength(2);
            });
        });

        test("an acked waiting child suspends; a new turn before the timer blocks it", async () => {
            await withSuspendTimers(async (fireSuspend) => {
                const { agentEnd, agentSettled, rctx, handlers } = setup(null);
                const { suspendRequests } = withRelay(rctx);
                const shutdown = mock(() => {});
                const ctx = { ...agentEndCtx, shutdown };
                rctx.goalState = waitingGoal();

                agentEnd({ messages: [] }, ctx);
                agentSettled({}, ctx);
                await flush();
                // Woken by an incoming message: the notice ack no longer covers this generation.
                handlers.get("turn_start")!({ type: "turn_start" }, ctx);
                await fireSuspend();
                expect(suspendRequests).toHaveLength(0);
                expect(shutdown).not.toHaveBeenCalled();

                // Waits again (same state: no duplicate notice) and is now suspendable.
                agentEnd({ messages: [] }, ctx);
                agentSettled({}, ctx);
                await flush();
                await fireSuspend();
                expect(suspendRequests).toHaveLength(1);
                expect(shutdown).toHaveBeenCalledTimes(1);
                expect((rctx as any).suspending).toBe(true);
            });
        });
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

describe("turn_end — omit Pi boundary context from relay traffic", () => {
    test("preserves turn results without forwarding or mutating the full context", () => {
        const { turnEnd, rctx } = setup(null);
        const message = { role: "assistant", content: [{ type: "text", text: "done" }] };
        const toolResults = [{ role: "toolResult", toolCallId: "call-1", content: [] }];
        const context = {
            contextEntries: [{ text: "private history".repeat(100_000) }],
            contextMessages: [message],
            llmMessages: [message],
            pendingMessages: [],
            canContinue: true,
        };
        const event = Object.freeze({ type: "turn_end", turnIndex: 3, message, toolResults, context });

        turnEnd(event, agentEndCtx);

        const forwarded = (rctx.forwardEvent as ReturnType<typeof mock>).mock.calls
            .map(([value]) => value)
            .find((value) => value?.type === "turn_end");
        expect(forwarded).toEqual({ type: "turn_end", turnIndex: 3, message, toolResults });
        expect(JSON.stringify(forwarded).length).toBeLessThan(1_000);
        expect(event.context).toBe(context);
    });
});

describe("session_shutdown — doDisconnect final flag", () => {
    // GM VD0KKFpB: only a real quit may tell the server to kill this
    // session's terminals. session_shutdown fires for reload/new/resume/fork
    // too (runtime restarts), which must leave live PTYs running.
    test("a real quit (or legacy reasonless shutdown) passes final: true to doDisconnect", async () => {
        const { sessionShutdown, doDisconnectCalls } = setup(null);

        await sessionShutdown({ reason: "quit" }, {});
        await sessionShutdown(undefined, {});

        expect(doDisconnectCalls).toEqual([{ final: true }, { final: true }]);
    });

    test("reload/new/resume/fork pass final: false to doDisconnect", async () => {
        const { sessionShutdown, doDisconnectCalls } = setup(null);

        for (const reason of ["reload", "new", "resume", "fork"]) {
            await sessionShutdown({ reason }, {});
        }

        expect(doDisconnectCalls).toEqual([{ final: false }, { final: false }, { final: false }, { final: false }]);
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
