import { afterEach, describe, expect, spyOn, test } from "bun:test";
import {
    applyChunkToPendingState,
    applySnapshotPatchToPendingState,
    canFinalizeChunkedSnapshot,
    enqueueSessionEvent,
    finalizeChunkedSnapshot,
    getPendingChunkedSnapshot,
    pendingChunkedStates,
    CHUNK_STREAM_STALE_MS,
    sessionEventQueues,
    type ChunkedSessionState,
} from "./event-pipeline.js";
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

        expect(firstInsert).toBe(true);
        expect(duplicateInsert).toBe(false);
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
        const getSharedSession = spyOn({
            getSharedSession: async () => ({ userId: "user-1", isEphemeral: false }),
        }, "getSharedSession");
        const storeAndReplaceImagesInEvent = spyOn({
            storeAndReplaceImagesInEvent: async (event: unknown) => event,
        }, "storeAndReplaceImagesInEvent");
        const appendRelayEventToCache = spyOn({
            appendRelayEventToCache: async () => {},
        }, "appendRelayEventToCache");

        applySnapshotPatchToPendingState(pending, {
            sessionName: "Updated",
            availableCommands: [{ name: "search_tools" }],
        });
        const nonce = markPendingRecovery("sess-chunked-recovery");
        pending.recoveryNonce = nonce;

        const fullState = await finalizeChunkedSnapshot("sess-chunked-recovery", pending, {
            consumePendingRecovery,
            updateSessionState: updateSessionState as any,
            getSharedSession: getSharedSession as any,
            storeAndReplaceImagesInEvent: storeAndReplaceImagesInEvent as any,
            appendRelayEventToCache: appendRelayEventToCache as any,
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
        expect(appendRelayEventToCache).toHaveBeenCalledTimes(1);
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
