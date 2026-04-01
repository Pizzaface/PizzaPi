import { afterEach, describe, expect, spyOn, test } from "bun:test";
import {
    applyChunkToPendingState,
    canFinalizeChunkedSnapshot,
    enqueueSessionEvent,
    finalizeChunkedSnapshot,
    sessionEventQueues,
    type ChunkedSessionState,
} from "./event-pipeline.js";
import {
    consumePendingRecovery,
    markPendingRecovery,
    pendingRecoverySessionIds,
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
});

describe("chunked snapshot assembly", () => {
    afterEach(() => {
        pendingRecoverySessionIds.clear();
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
            totalChunks: 2,
            isFinalChunk: false,
        });

        expect(firstInsert).toBe(true);
        expect(duplicateInsert).toBe(false);
        expect(Array.from(pending.receivedChunkIndexes)).toEqual([0]);
        expect(pending.chunks[0]).toEqual([{ id: "m1" }]);
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

    test("chunked finalization consumes and clears the recovery flag", async () => {
        const pending: ChunkedSessionState = {
            snapshotId: "snap-recovery",
            metadata: { sessionName: "Recovered" },
            chunks: [[{ id: "m1" }], [{ id: "m2" }]],
            totalChunks: 2,
            receivedChunkIndexes: new Set<number>([0, 1]),
            finalChunkSeen: true,
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

        markPendingRecovery("sess-chunked-recovery");

        const fullState = await finalizeChunkedSnapshot("sess-chunked-recovery", pending, {
            consumePendingRecovery,
            updateSessionState: updateSessionState as any,
            getSharedSession: getSharedSession as any,
            storeAndReplaceImagesInEvent: storeAndReplaceImagesInEvent as any,
            appendRelayEventToCache: appendRelayEventToCache as any,
        });

        expect(fullState).toEqual({
            sessionName: "Recovered",
            messages: [{ id: "m1" }, { id: "m2" }],
        });
        expect(updateSessionState).toHaveBeenCalledWith(
            "sess-chunked-recovery",
            fullState,
            { isRecovery: true },
        );
        expect(pendingRecoverySessionIds.has("sess-chunked-recovery")).toBe(false);
        expect(consumePendingRecovery("sess-chunked-recovery")).toBe(false);
        expect(appendRelayEventToCache).toHaveBeenCalledTimes(1);
    });
});
