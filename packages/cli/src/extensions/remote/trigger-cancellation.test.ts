import { describe, test, expect, beforeEach } from "bun:test";
import { createCancellationManager, type CancellationState } from "./trigger-cancellation.js";
import type { RelayContext } from "../remote-types.js";

/** Minimal mock for the RelayContext / socket needed by the cancellation manager. */
function createMockContext(emitHandler?: (event: string, data: any, ack: Function) => void) {
    const emitted: Array<{ event: string; data: any }> = [];
    const sioSocket = {
        connected: true,
        emit(event: string, data: any, ack?: Function) {
            emitted.push({ event, data });
            if (emitHandler) emitHandler(event, data, ack!);
        },
    };
    const rctx = {
        relay: { token: "test-token" },
        sioSocket,
    } as unknown as RelayContext;

    return { rctx, sioSocket, emitted };
}

function createState(cancellations: CancellationState["pendingCancellations"] = []): CancellationState {
    return {
        pendingCancellations: cancellations,
        pendingCancellationRetryTimer: null,
        pendingCancellationRetryInFlight: false,
    };
}

describe("trigger-cancellation", () => {
    describe("permanent error handling", () => {
        test("drops cancellation on 'Target session belongs to a different user' error", () => {
            const { rctx } = createMockContext((_event, _data, ack) => {
                ack({ ok: false, error: "Target session belongs to a different user" });
            });

            const state = createState([
                { triggerId: "t1", childSessionId: "child1" },
            ]);
            const mgr = createCancellationManager(rctx, state);

            mgr.retryPendingTriggerCancellations("test");

            // The permanent error should have removed the cancellation
            expect(state.pendingCancellations).toHaveLength(0);
        });

        test("drops cancellation on 'Sender is not the parent of the target session' error", () => {
            const { rctx } = createMockContext((_event, _data, ack) => {
                ack({ ok: false, error: "Sender is not the parent of the target session" });
            });

            const state = createState([
                { triggerId: "t1", childSessionId: "child1" },
            ]);
            const mgr = createCancellationManager(rctx, state);

            mgr.retryPendingTriggerCancellations("test");

            expect(state.pendingCancellations).toHaveLength(0);
        });

        test("keeps cancellation on transient errors and increments retryCount", () => {
            const { rctx } = createMockContext((_event, _data, ack) => {
                ack({ ok: false, error: "Network timeout" });
            });

            const state = createState([
                { triggerId: "t1", childSessionId: "child1" },
            ]);
            const mgr = createCancellationManager(rctx, state);

            mgr.retryPendingTriggerCancellations("test");

            expect(state.pendingCancellations).toHaveLength(1);
            expect(state.pendingCancellations[0].retryCount).toBe(1);
        });
    });

    describe("max retries", () => {
        test("drops cancellation after 10 retries even for transient errors", () => {
            const { rctx } = createMockContext((_event, _data, ack) => {
                ack({ ok: false, error: "Some transient error" });
            });

            const state = createState([
                { triggerId: "t1", childSessionId: "child1", retryCount: 9 },
            ]);
            const mgr = createCancellationManager(rctx, state);

            mgr.retryPendingTriggerCancellations("test");

            // retryCount was 9, now 10 — should be dropped
            expect(state.pendingCancellations).toHaveLength(0);
        });

        test("keeps cancellation at retryCount 8 (below max)", () => {
            const { rctx } = createMockContext((_event, _data, ack) => {
                ack({ ok: false, error: "Some transient error" });
            });

            const state = createState([
                { triggerId: "t1", childSessionId: "child1", retryCount: 8 },
            ]);
            const mgr = createCancellationManager(rctx, state);

            mgr.retryPendingTriggerCancellations("test");

            expect(state.pendingCancellations).toHaveLength(1);
            expect(state.pendingCancellations[0].retryCount).toBe(9);
        });
    });

    describe("successful cancellations", () => {
        test("removes cancellation on ok:true response", () => {
            const { rctx } = createMockContext((_event, _data, ack) => {
                ack({ ok: true });
            });

            const state = createState([
                { triggerId: "t1", childSessionId: "child1" },
            ]);
            const mgr = createCancellationManager(rctx, state);

            mgr.retryPendingTriggerCancellations("test");

            expect(state.pendingCancellations).toHaveLength(0);
        });

        test("handles mixed results in a batch", () => {
            let callCount = 0;
            const { rctx } = createMockContext((_event, data, ack) => {
                callCount++;
                if (data.triggerId === "t1") {
                    ack({ ok: true }); // success
                } else if (data.triggerId === "t2") {
                    ack({ ok: false, error: "Target session belongs to a different user" }); // permanent
                } else {
                    ack({ ok: false, error: "Temporary" }); // transient
                }
            });

            const state = createState([
                { triggerId: "t1", childSessionId: "child1" },
                { triggerId: "t2", childSessionId: "child2" },
                { triggerId: "t3", childSessionId: "child3" },
            ]);
            const mgr = createCancellationManager(rctx, state);

            mgr.retryPendingTriggerCancellations("test");

            expect(callCount).toBe(3);
            // t1 succeeded, t2 permanent-dropped, t3 still pending
            expect(state.pendingCancellations).toHaveLength(1);
            expect(state.pendingCancellations[0].triggerId).toBe("t3");
        });
    });

    describe("no-op when empty", () => {
        test("does nothing when no pending cancellations", () => {
            const { rctx, emitted } = createMockContext();
            const state = createState([]);
            const mgr = createCancellationManager(rctx, state);

            mgr.retryPendingTriggerCancellations("test");

            expect(emitted).toHaveLength(0);
        });
    });

    describe("skips when not connected", () => {
        test("does nothing when socket is not connected", () => {
            const { rctx, sioSocket, emitted } = createMockContext();
            sioSocket.connected = false;
            const state = createState([
                { triggerId: "t1", childSessionId: "child1" },
            ]);
            const mgr = createCancellationManager(rctx, state);

            mgr.retryPendingTriggerCancellations("test");

            expect(emitted).toHaveLength(0);
            // Should still be pending
            expect(state.pendingCancellations).toHaveLength(1);
        });
    });
});
