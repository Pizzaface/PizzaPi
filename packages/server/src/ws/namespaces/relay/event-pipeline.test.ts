import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import {
    abortChunkedSnapshot,
    applyChunkToPendingState,
    applySnapshotPatchToPendingState,
    canFinalizeChunkedSnapshot,
    enqueueSessionEvent,
    finalizeChunkedSnapshot,
    getPendingChunkedSnapshot,
    pendingChunkedStates,
    resetPerSessionRelayState,
    CHUNK_STREAM_STALE_MS,
    sessionEventQueues,
    getChunkedSnapshotLimits,
    DEFAULT_SNAPSHOT_MAX_CHUNKS,
    type ChunkedSessionState,
    type ChunkedSnapshotLimits,
} from "./event-pipeline.js";
import {
    thinkingStartTimes,
    thinkingDurations,
} from "./thinking-tracker.js";
import {
    _injectRedisForTesting,
    _resetRedisForTesting,
} from "../../../sessions/redis.js";
import {
    consumePendingRecovery,
    markPendingRecovery,
    hasPendingRecovery,
    _resetPendingRecoveriesForTesting,
} from "../../sio-registry/viewer-recovery.js";

async function flushQueue(): Promise<void> {
    for (let i = 0; i < 5; i++) {
        await Promise.resolve();
    }
}

function createPendingState(): ChunkedSessionState {
    return {
        snapshotId: "snap-1",
        metadata: {},
        chunks: [],
        totalChunks: 0,
        receivedChunkIndexes: new Set<number>(),
        finalChunkSeen: false,
        lastActivityAt: Date.now(),
    };
}

describe("enqueueSessionEvent", () => {
    afterEach(() => {
        sessionEventQueues.clear();
    });

    test("logs a failed task and continues processing later tasks", async () => {
        const errorSpy = spyOn(console, "error").mockImplementation(() => {});
        let ranSecond = false;

        enqueueSessionEvent("session-1", async () => {
            throw new Error("boom");
        });
        enqueueSessionEvent("session-1", async () => {
            ranSecond = true;
        });

        await flushQueue();
        await sessionEventQueues.get("session-1");
        await flushQueue();

        expect(ranSecond).toBe(true);
        expect(errorSpy).toHaveBeenCalled();
        expect(sessionEventQueues.has("session-1")).toBe(false);

        errorSpy.mockRestore();
    });

    test("returned promise drains earlier events before lifecycle cleanup", async () => {
        const order: string[] = [];
        let release!: () => void;
        const blocked = new Promise<void>((resolve) => { release = resolve; });

        enqueueSessionEvent("session-1", async () => {
            await blocked;
            order.push("chunk-finalized");
        });
        const cleanup = enqueueSessionEvent("session-1", async () => {
            order.push("cleanup");
        });

        await Promise.resolve();
        expect(order).toEqual([]);
        release();
        await cleanup;

        expect(order).toEqual(["chunk-finalized", "cleanup"]);
    });
});

describe("chunked snapshot assembly", () => {
    afterEach(() => {
        _resetPendingRecoveriesForTesting();
    });

    test("duplicate chunk retransmits are idempotent", () => {
        const pending = createPendingState();

        const firstInsert = applyChunkToPendingState(pending, {
            chunkIndex: 0,
            chunkMessages: [{ id: "m1" }],
            totalChunks: 2,
            isFinalChunk: false,
        });
        const duplicateInsert = applyChunkToPendingState(pending, {
            chunkIndex: 0,
            chunkMessages: [{ id: "m1-duplicate" }],
            totalChunks: 99,
            isFinalChunk: true,
        });

        expect(firstInsert).toEqual({ status: "applied" });
        expect(duplicateInsert).toEqual({ status: "duplicate" });
        expect(Array.from(pending.receivedChunkIndexes)).toEqual([0]);
        expect(pending.chunks[0]).toEqual([{ id: "m1" }]);
        expect(pending.totalChunks).toBe(2);
        expect(pending.finalChunkSeen).toBe(true);
        expect(canFinalizeChunkedSnapshot(pending)).toBe(false);
    });

    test("finalization requires all unique chunk indexes 0..N-1", () => {
        const pending = createPendingState();

        applyChunkToPendingState(pending, {
            chunkIndex: 0,
            chunkMessages: ["c0"],
            totalChunks: 3,
            isFinalChunk: false,
        });
        applyChunkToPendingState(pending, {
            chunkIndex: 0,
            chunkMessages: ["c0-retransmit"],
            totalChunks: 3,
            isFinalChunk: false,
        });
        applyChunkToPendingState(pending, {
            chunkIndex: 2,
            chunkMessages: ["c2"],
            totalChunks: 3,
            isFinalChunk: true,
        });

        expect(canFinalizeChunkedSnapshot(pending)).toBe(false);

        applyChunkToPendingState(pending, {
            chunkIndex: 1,
            chunkMessages: ["c1"],
            totalChunks: 3,
            isFinalChunk: false,
        });

        expect(canFinalizeChunkedSnapshot(pending)).toBe(true);
    });

    test("does not finalize until final chunk is seen", () => {
        const pending = createPendingState();

        applyChunkToPendingState(pending, {
            chunkIndex: 0,
            chunkMessages: ["c0"],
            totalChunks: 2,
            isFinalChunk: false,
        });
        applyChunkToPendingState(pending, {
            chunkIndex: 1,
            chunkMessages: ["c1"],
            totalChunks: 2,
            isFinalChunk: false,
        });

        expect(canFinalizeChunkedSnapshot(pending)).toBe(false);

        applyChunkToPendingState(pending, {
            chunkIndex: 1,
            chunkMessages: ["c1-final-retransmit"],
            totalChunks: 2,
            isFinalChunk: true,
        });

        expect(canFinalizeChunkedSnapshot(pending)).toBe(true);
    });

    test("out-of-order chunks still finalize once all unique indexes arrive", () => {
        const pending = createPendingState();

        // Final chunk arrives before chunk 1.
        applyChunkToPendingState(pending, {
            chunkIndex: 2,
            chunkMessages: ["c2"],
            totalChunks: 3,
            isFinalChunk: true,
        });
        applyChunkToPendingState(pending, {
            chunkIndex: 0,
            chunkMessages: ["c0"],
            totalChunks: 3,
            isFinalChunk: false,
        });

        expect(canFinalizeChunkedSnapshot(pending)).toBe(false);

        applyChunkToPendingState(pending, {
            chunkIndex: 1,
            chunkMessages: ["c1"],
            totalChunks: 3,
            isFinalChunk: false,
        });

        expect(canFinalizeChunkedSnapshot(pending)).toBe(true);

        // Assembled transcript must be in chunkIndex order (c0, c1, c2),
        // NOT arrival order (c2, c0, c1).  The server stores chunks in a
        // sparse array indexed by chunkIndex; flat() therefore always yields
        // the original server-side ordering.
        const assembled = pending.chunks.flat();
        expect(assembled).toEqual(["c0", "c1", "c2"]);
    });

    test("metadata patches update pending chunked snapshots before finalization", async () => {
        const pending: ChunkedSessionState = {
            snapshotId: "snap-recovery",
            metadata: {
                sessionName: "Recovered",
                availableCommands: [],
            },
            chunks: [[{ id: "m1" }], [{ id: "m2" }]],
            totalChunks: 2,
            receivedChunkIndexes: new Set<number>([0, 1]),
            finalChunkSeen: true,
            lastActivityAt: Date.now(),
        };
        const updateSessionState = spyOn({
            updateSessionState: async () => {},
        }, "updateSessionState");
        const published: Array<{ event: unknown; opts: unknown }> = [];
        const publishSessionEvent = async (_sid: string, event: unknown, opts?: unknown) => {
            published.push({ event, opts });
            return published.length;
        };
        pending.deferredEvents = [{ type: "message_start" }, { type: "message_end" }];

        applySnapshotPatchToPendingState(pending, {
            sessionName: "Updated",
            availableCommands: [{ name: "search_tools" }],
        });
        const nonce = markPendingRecovery("sess-chunked-recovery");
        pending.recoveryNonce = nonce;

        const fullState = await finalizeChunkedSnapshot("sess-chunked-recovery", pending, {
            consumePendingRecovery,
            updateSessionState: updateSessionState as any,
            publishSessionEvent: publishSessionEvent as any,
        });

        expect(fullState).toEqual({
            sessionName: "Updated",
            availableCommands: [{ name: "search_tools" }],
            messages: [{ id: "m1" }, { id: "m2" }],
        });
        expect(updateSessionState).toHaveBeenCalledWith(
            "sess-chunked-recovery",
            fullState,
            { isRecovery: true },
        );
        expect(hasPendingRecovery("sess-chunked-recovery")).toBe(false);
        expect(consumePendingRecovery("sess-chunked-recovery", nonce)).toBe(false);
        // Full state is published (cached) once with viewer truncation, then
        // the events that arrived during assembly follow it in order.
        expect(published).toEqual([
            { event: { type: "session_active", state: fullState }, opts: { truncateForViewers: true } },
            { event: { type: "message_start" }, opts: undefined },
            { event: { type: "message_end" }, opts: undefined },
        ]);
        expect(pending.deferredEvents).toEqual([]);
    });
});

describe("chunked snapshot resource limits (F10)", () => {
    const limits: ChunkedSnapshotLimits = {
        maxChunks: 4,
        maxMessages: 5,
        maxBytes: 1_000,
        maxDeferredEvents: 2,
    };

    function apply(pending: ChunkedSessionState, chunkIndex: number, totalChunks: number, msgs: unknown[] = ["m"]) {
        return applyChunkToPendingState(pending, {
            chunkIndex,
            chunkMessages: msgs,
            totalChunks,
            isFinalChunk: false,
        }, limits);
    }

    test.each([
        ["negative", -1],
        ["fractional", 1.5],
        ["NaN", Number.NaN],
        ["Infinity", Number.POSITIVE_INFINITY],
        ["unsafe integer", Number.MAX_SAFE_INTEGER + 2],
        ["huge", 4_294_967_294],
        ["at the chunk cap", 4],
    ])("rejects a %s chunkIndex before allocating", (_label, chunkIndex) => {
        const pending = createPendingState();
        const result = apply(pending, chunkIndex, 4);
        expect(result.status).toBe("rejected");
        expect(pending.chunks.length).toBe(0);
        expect(pending.receivedChunkIndexes.size).toBe(0);
        expect(pending.totalChunks).toBe(0);
    });

    test("rejects chunkIndex >= totalChunks", () => {
        const pending = createPendingState();
        expect(apply(pending, 2, 2).status).toBe("rejected");
        expect(pending.chunks.length).toBe(0);
    });

    test.each([
        ["zero", 0],
        ["fractional", 2.5],
        ["above the cap", 5],
        ["unsafe", Number.MAX_SAFE_INTEGER + 2],
    ])("rejects a %s totalChunks", (_label, totalChunks) => {
        const pending = createPendingState();
        expect(apply(pending, 0, totalChunks).status).toBe("rejected");
        expect(pending.receivedChunkIndexes.size).toBe(0);
    });

    test("rejects a totalChunks that changes mid-stream", () => {
        const pending = createPendingState();
        expect(apply(pending, 0, 3).status).toBe("applied");
        expect(apply(pending, 1, 4).status).toBe("rejected");
        expect(pending.totalChunks).toBe(3);
        expect(Array.from(pending.receivedChunkIndexes)).toEqual([0]);
    });

    test("enforces the aggregate message budget", () => {
        const pending = createPendingState();
        expect(apply(pending, 0, 3, ["a", "b", "c"]).status).toBe("applied");
        expect(apply(pending, 1, 3, ["d", "e", "f"]).status).toBe("rejected");
        expect(pending.receivedMessages).toBe(3);
        expect(pending.chunks[1]).toBeUndefined();
    });

    test("enforces the aggregate byte budget", () => {
        const pending = createPendingState();
        expect(apply(pending, 0, 3, ["x".repeat(600)]).status).toBe("applied");
        expect(apply(pending, 1, 3, ["y".repeat(600)]).status).toBe("rejected");
        expect(pending.receivedBytes).toBeLessThanOrEqual(limits.maxBytes);
    });

    test("a legitimate in-budget stream still finalizes", () => {
        const pending = createPendingState();
        expect(apply(pending, 1, 2, ["b"]).status).toBe("applied");
        expect(applyChunkToPendingState(pending, {
            chunkIndex: 0, chunkMessages: ["a"], totalChunks: 2, isFinalChunk: true,
        }, limits).status).toBe("applied");
        expect(canFinalizeChunkedSnapshot(pending)).toBe(true);
        expect(pending.chunks.flat()).toEqual(["a", "b"]);
    });

    test("limits come from PIZZAPI_RELAY_SNAPSHOT_* env vars with safe fallbacks", () => {
        const saved = process.env.PIZZAPI_RELAY_SNAPSHOT_MAX_CHUNKS;
        try {
            process.env.PIZZAPI_RELAY_SNAPSHOT_MAX_CHUNKS = "25";
            expect(getChunkedSnapshotLimits().maxChunks).toBe(25);
            for (const bad of ["0", "-3", "1.5", "abc", "1e400"]) {
                process.env.PIZZAPI_RELAY_SNAPSHOT_MAX_CHUNKS = bad;
                expect(getChunkedSnapshotLimits().maxChunks).toBe(DEFAULT_SNAPSHOT_MAX_CHUNKS);
            }
        } finally {
            if (saved === undefined) delete process.env.PIZZAPI_RELAY_SNAPSHOT_MAX_CHUNKS;
            else process.env.PIZZAPI_RELAY_SNAPSHOT_MAX_CHUNKS = saved;
        }
    });

    test("abortChunkedSnapshot drops the pending entry and flushes deferred events in order", async () => {
        const pending = createPendingState();
        apply(pending, 0, 3, ["a"]);
        pending.deferredEvents = [{ type: "message_start" }, { type: "message_end" }];
        pendingChunkedStates.set("sess-abort", pending);
        const published: unknown[] = [];
        const marked: string[] = [];
        const warnSpy = spyOn(console, "warn").mockImplementation(() => {});
        try {
            await abortChunkedSnapshot("sess-abort", pending, "test", {
                publishSessionEvent: (async (_sid: string, evt: unknown) => {
                    published.push(evt);
                    return published.length;
                }) as any,
                markSnapshotRejected: async (sid: string) => { marked.push(sid); },
            });
        } finally {
            warnSpy.mockRestore();
            pendingChunkedStates.clear();
        }
        expect(pendingChunkedStates.has("sess-abort")).toBe(false);
        expect(published).toEqual([{ type: "message_start" }, { type: "message_end" }]);
        // Review R10: the rejection is recorded durably for viewer recovery.
        expect(marked).toEqual(["sess-abort"]);
        expect(pending.chunks).toEqual([]);
        expect(pending.deferredEvents).toEqual([]);
    });

    test("a transiently failing marker write is retried, not dropped (review R2-6)", async () => {
        const pending = createPendingState();
        let attempts = 0;
        const signals: string[] = [];
        const errSpy = spyOn(console, "error").mockImplementation(() => {});
        const warnSpy = spyOn(console, "warn").mockImplementation(() => {});
        try {
            await abortChunkedSnapshot("sess-retry", pending, "test", {
                publishSessionEvent: (async () => 1) as any,
                markSnapshotRejected: async () => {
                    attempts++;
                    if (attempts < 3) throw new Error("redis down");
                },
                requestRunnerSnapshot: (sid) => { signals.push(sid); },
                markRetryDelaysMs: [1, 1],
            });
        } finally {
            errSpy.mockRestore();
            warnSpy.mockRestore();
        }
        expect(attempts).toBe(3);
        expect(signals).toEqual([]);
    });

    test("a persistently failing marker write asks the runner for a fresh snapshot (review R2-6)", async () => {
        const pending = createPendingState();
        pending.deferredEvents = [{ type: "message_start" }];
        let attempts = 0;
        const signals: string[] = [];
        const published: unknown[] = [];
        const errSpy = spyOn(console, "error").mockImplementation(() => {});
        const warnSpy = spyOn(console, "warn").mockImplementation(() => {});
        try {
            await abortChunkedSnapshot("sess-fail", pending, "test", {
                publishSessionEvent: (async (_sid: string, evt: unknown) => { published.push(evt); return 1; }) as any,
                markSnapshotRejected: async () => { attempts++; throw new Error("redis down"); },
                requestRunnerSnapshot: (sid) => { signals.push(sid); },
                markRetryDelaysMs: [1, 1],
            });
        } finally {
            errSpy.mockRestore();
            warnSpy.mockRestore();
        }
        expect(attempts).toBe(3);
        expect(signals).toEqual(["sess-fail"]);
        expect(published).toEqual([{ type: "message_start" }]);
    });
});

describe("getPendingChunkedSnapshot — stale stream expiry", () => {
    afterEach(() => {
        pendingChunkedStates.clear();
    });

    function seed(sessionId: string, lastActivityAt: number): void {
        pendingChunkedStates.set(sessionId, {
            snapshotId: "snap-stale",
            metadata: { totalMessages: 3 },
            chunks: [[{ id: "m1" }]],
            totalChunks: 3,
            receivedChunkIndexes: new Set<number>([0]),
            finalChunkSeen: false,
            lastActivityAt,
        });
    }

    test("returns an active stream as not stale", () => {
        seed("s-active", Date.now());
        expect(getPendingChunkedSnapshot("s-active")?.stale).toBe(false);
        expect(pendingChunkedStates.has("s-active")).toBe(true);
    });

    test("flags a stream with no chunk activity past the stale threshold, without deleting it", () => {
        seed("s-stale", Date.now() - CHUNK_STREAM_STALE_MS - 1);
        expect(getPendingChunkedSnapshot("s-stale")?.stale).toBe(true);
        // Kept: a hung runner that resumes refreshes lastActivityAt and the
        // stream can still finalize — deleting would discard its chunks.
        expect(pendingChunkedStates.has("s-stale")).toBe(true);
    });

    test("chunk arrival refreshes activity and clears staleness", () => {
        seed("s-refresh", Date.now() - CHUNK_STREAM_STALE_MS - 1);
        const pending = pendingChunkedStates.get("s-refresh")!;
        applyChunkToPendingState(pending, {
            chunkIndex: 1,
            chunkMessages: [{ id: "m2" }],
            totalChunks: 3,
            isFinalChunk: false,
        });
        expect(getPendingChunkedSnapshot("s-refresh")?.stale).toBe(false);
    });
});

describe("resetPerSessionRelayState — reconnect state reset", () => {
    beforeEach(() => {
        // Inject a mock Redis client so the reset helper's cache deletion is
        // deterministic and never depends on a live Redis instance.
        _injectRedisForTesting({ del: async (_key: string) => 1 } as unknown);
    });

    afterEach(() => {
        pendingChunkedStates.clear();
        sessionEventQueues.clear();
        thinkingStartTimes.clear();
        thinkingDurations.clear();
        _resetRedisForTesting();
    });

    test("drains the event queue before clearing half-assembled chunk state", async () => {
        const order: string[] = [];
        let release!: () => void;
        const blocked = new Promise<void>((resolve) => { release = resolve; });

        // A chunk handler from the OLD generation is still in flight (already
        // started — queued-but-unstarted work is skipped by the reset; see
        // relay-state.reset.test.ts).
        let started!: () => void;
        const running = new Promise<void>((resolve) => { started = resolve; });
        enqueueSessionEvent("sess-reconnect", async () => {
            started();
            await blocked;
            order.push("old-chunk-handler");
        });
        await running;
        pendingChunkedStates.set("sess-reconnect", {
            snapshotId: "old-snap",
            metadata: {},
            chunks: [[{ id: "old-m1" }]],
            totalChunks: 2,
            receivedChunkIndexes: new Set<number>([0]),
            finalChunkSeen: false,
            lastActivityAt: Date.now(),
        });

        const resetPromise = resetPerSessionRelayState("sess-reconnect");
        // The reset must NOT complete until the in-flight handler drains.
        await Promise.resolve();
        expect(order).toEqual([]);
        release();
        await resetPromise;

        expect(order).toEqual(["old-chunk-handler"]);
        expect(pendingChunkedStates.has("sess-reconnect")).toBe(false);
        expect(sessionEventQueues.has("sess-reconnect")).toBe(false);
    });

    test("clears thinking maps and pending chunk state for the session", async () => {
        thinkingStartTimes.set("sess-reconnect", new Map([[0, Date.now()]]));
        thinkingDurations.set("sess-reconnect", new Map([[0, 1234]]));
        pendingChunkedStates.set("sess-reconnect", {
            snapshotId: "old-snap",
            metadata: {},
            chunks: [[{ id: "old-m1" }]],
            totalChunks: 1,
            receivedChunkIndexes: new Set<number>([0]),
            finalChunkSeen: true,
            lastActivityAt: Date.now(),
        });

        await resetPerSessionRelayState("sess-reconnect");

        expect(thinkingStartTimes.has("sess-reconnect")).toBe(false);
        expect(thinkingDurations.has("sess-reconnect")).toBe(false);
        expect(pendingChunkedStates.has("sess-reconnect")).toBe(false);
    });

    test("deletes the relay event cache for the session", async () => {
        const del = spyOn({
            del: async (_key: string | string[]) => 1,
        }, "del");
        _injectRedisForTesting({ del } as unknown);

        await resetPerSessionRelayState("sess-reconnect");

        expect(del).toHaveBeenCalledWith([
            "pizzapi:relay:session:sess-reconnect:events",
            "pizzapi:relay:session:sess-reconnect:events:bytes",
        ]);
    });

    test("does not clear state for other sessions", async () => {
        pendingChunkedStates.set("sess-other", {
            snapshotId: "other-snap",
            metadata: {},
            chunks: [[{ id: "other-m1" }]],
            totalChunks: 1,
            receivedChunkIndexes: new Set<number>([0]),
            finalChunkSeen: false,
            lastActivityAt: Date.now(),
        });

        await resetPerSessionRelayState("sess-reconnect");

        expect(pendingChunkedStates.has("sess-other")).toBe(true);
    });
});
