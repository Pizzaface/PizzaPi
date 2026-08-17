import { beforeEach, describe, expect, mock, test } from "bun:test";

import {
    hydrateViewerFromCache,
    sendCachedDeltaReplayEvents,
    snapshotCoverageSeq,
    snapshotCoversCursor,
    type CachedRelayEvent,
    type ViewerCacheDeps,
} from "./viewer-cache.js";

interface EmittedCall {
    event: string;
    payload: unknown;
}

function createMockSocket(): { emit: ReturnType<typeof mock>; calls: EmittedCall[] } {
    const calls: EmittedCall[] = [];
    const emit = mock((event: string, payload: unknown) => {
        calls.push({ event, payload });
        return true;
    });
    return { emit, calls };
}

function createDeps(overrides: Partial<ViewerCacheDeps> = {}): ViewerCacheDeps {
    return {
        getCachedRelayEventsAfterSeq: overrides.getCachedRelayEventsAfterSeq ?? mock(async () => [] as CachedRelayEvent[]),
        getLatestCachedRelayEventSeq: overrides.getLatestCachedRelayEventSeq ?? mock(async () => null),
        getLatestCachedSnapshotEvent: overrides.getLatestCachedSnapshotEvent ?? mock(async () => null),
    };
}

describe("hydrateViewerFromCache — snapshot path", () => {
    let deps: ViewerCacheDeps;

    beforeEach(() => {
        deps = createDeps();
    });

    test("returns true and emits event when Redis has a session_active snapshot", async () => {
        const snapshot = { type: "session_active", state: { messages: [{ role: "user" }] } };
        deps = createDeps({ getLatestCachedSnapshotEvent: mock(async () => ({ event: snapshot, eventsAfter: [] })) });

        const { emit, calls } = createMockSocket();
        const result = await hydrateViewerFromCache({ emit }, "sess-001", {}, deps);

        expect(result).toBe(true);
        expect(calls.length).toBe(1);
        expect(calls[0].event).toBe("event");
        expect(calls[0].payload).toMatchObject({ event: snapshot, replay: true });
    });

    test("returns true and emits with generation when generation is provided", async () => {
        const snapshot = { type: "agent_end", messages: [{ role: "assistant" }] };
        deps = createDeps({ getLatestCachedSnapshotEvent: mock(async () => ({ event: snapshot, eventsAfter: [] })) });

        const { emit, calls } = createMockSocket();
        const result = await hydrateViewerFromCache({ emit }, "sess-002", { generation: 7 }, deps);

        expect(result).toBe(true);
        expect(calls[0].payload).toMatchObject({ event: snapshot, replay: true, generation: 7 });
    });

    test("returns false when cache is empty — viewer needs runner fallback", async () => {
        const { emit, calls } = createMockSocket();
        const result = await hydrateViewerFromCache({ emit }, "sess-003", {}, deps);

        expect(result).toBe(false);
        expect(calls.length).toBe(0);
    });

    test("does NOT call getCachedRelayEventsAfterSeq when no lastSeq provided", async () => {
        const getCachedRelayEventsAfterSeq = mock(async () => [] as CachedRelayEvent[]);
        deps = createDeps({ getCachedRelayEventsAfterSeq });

        const { emit } = createMockSocket();
        await hydrateViewerFromCache({ emit }, "sess-004", {}, deps);

        expect(getCachedRelayEventsAfterSeq).not.toHaveBeenCalled();
    });

    test("works for agent_end snapshot (full session end)", async () => {
        const snapshot = { type: "agent_end", messages: [{ role: "user" }, { role: "assistant" }] };
        deps = createDeps({ getLatestCachedSnapshotEvent: mock(async () => ({ event: snapshot, eventsAfter: [] })) });

        const { emit, calls } = createMockSocket();
        const result = await hydrateViewerFromCache({ emit }, "sess-005", {}, deps);

        expect(result).toBe(true);
        expect(calls[0].payload).toMatchObject({ event: snapshot, replay: true });
    });
});

describe("hydrateViewerFromCache — delta resume path", () => {
    test("returns true via delta resume when events exist after lastSeq", async () => {
        const deltaEvents = [
            { seq: 11, event: { type: "message_start" } },
            { seq: 12, event: { type: "message_end" } },
        ];
        const getLatestCachedSnapshotEvent = mock(async () => null);
        const deps = createDeps({
            getCachedRelayEventsAfterSeq: mock(async () => deltaEvents),
            getLatestCachedSnapshotEvent,
        });

        const { emit, calls } = createMockSocket();
        const result = await hydrateViewerFromCache({ emit }, "sess-010", { lastSeq: 10, generation: 3 }, deps);

        expect(result).toBe(true);
        expect(calls.length).toBe(2);
        expect(calls[0].payload).toMatchObject({ seq: 11, replay: true, deltaReplay: true, generation: 3 });
        expect(calls[1].payload).toMatchObject({ seq: 12, replay: true, deltaReplay: true, generation: 3 });
        expect(getLatestCachedSnapshotEvent).not.toHaveBeenCalled();
    });

    test("returns true without emitting when the client is already at the latest seq", async () => {
        const getLatestCachedRelayEventSeq = mock(async () => 5);
        const deps = createDeps({
            getCachedRelayEventsAfterSeq: mock(async () => []),
            getLatestCachedRelayEventSeq,
        });

        const { emit, calls } = createMockSocket();
        const result = await hydrateViewerFromCache({ emit }, "sess-011", { lastSeq: 5 }, deps);

        expect(result).toBe(true);
        expect(calls.length).toBe(0);
        expect(getLatestCachedRelayEventSeq).toHaveBeenCalledWith("sess-011");
    });

    test("replays a seq-stamped snapshot at or ahead of the cursor instead of going blank", async () => {
        // Regression: an empty delta replay used to be terminal, so a reconnecting
        // viewer got no transcript at all and only a page reload fixed it. The
        // snapshot's own seq proves it is not a rewind, so it is safe to send.
        const snapshot = { type: "session_active", state: { messages: [{ role: "user" }] } };
        const deps = createDeps({
            getCachedRelayEventsAfterSeq: mock(async () => []),
            getLatestCachedRelayEventSeq: mock(async () => 8),
            getLatestCachedSnapshotEvent: mock(async () => ({
                event: snapshot,
                snapshotSeq: 8,
                eventsAfter: [],
            })),
        });

        const { emit, calls } = createMockSocket();
        const result = await hydrateViewerFromCache({ emit }, "sess-012", { lastSeq: 5 }, deps);

        expect(result).toBe(true);
        expect(calls.length).toBe(1);
        expect(calls[0].payload).toMatchObject({ event: snapshot, replay: true });
    });

    test("replays trailing deltas after a seq-stamped snapshot", async () => {
        const snapshot = { type: "session_active", state: { messages: [] } };
        const deps = createDeps({
            getCachedRelayEventsAfterSeq: mock(async () => []),
            getLatestCachedRelayEventSeq: mock(async () => 9),
            getLatestCachedSnapshotEvent: mock(async () => ({
                event: snapshot,
                snapshotSeq: 7,
                eventsAfter: [{ seq: 8, event: { type: "message_update" } }],
            })),
        });

        const { emit, calls } = createMockSocket();
        const result = await hydrateViewerFromCache({ emit }, "sess-012b", { lastSeq: 6 }, deps);

        expect(result).toBe(true);
        expect(calls.length).toBe(2);
        expect(calls[1].payload).toMatchObject({ seq: 8, deltaReplay: true });
    });

    test("refuses a snapshot that would rewind the client", async () => {
        // The snapshot predates what the viewer already rendered, so sending it
        // would erase messages. Recover through the runner instead.
        const snapshot = { type: "session_active", state: { messages: [] } };
        const deps = createDeps({
            getCachedRelayEventsAfterSeq: mock(async () => []),
            getLatestCachedRelayEventSeq: mock(async () => 8),
            getLatestCachedSnapshotEvent: mock(async () => ({
                event: snapshot,
                snapshotSeq: 4,
                eventsAfter: [],
            })),
        });

        const { emit, calls } = createMockSocket();
        const result = await hydrateViewerFromCache({ emit }, "sess-012c", { lastSeq: 5 }, deps);

        expect(result).toBe(false);
        expect(calls.length).toBe(0);
    });

    test("refuses an unsequenced snapshot for a cursor-holding viewer", async () => {
        // finalizeChunkedSnapshot() caches its assembled session_active without a
        // seq, so its position in the stream is unknown and cannot be compared.
        const snapshot = { type: "session_active", state: { messages: [] } };
        const deps = createDeps({
            getCachedRelayEventsAfterSeq: mock(async () => []),
            getLatestCachedRelayEventSeq: mock(async () => 8),
            getLatestCachedSnapshotEvent: mock(async () => ({ event: snapshot, eventsAfter: [] })),
        });

        const { emit, calls } = createMockSocket();
        const result = await hydrateViewerFromCache({ emit }, "sess-012d", { lastSeq: 5 }, deps);

        expect(result).toBe(false);
        expect(calls.length).toBe(0);
    });

    test("returns false when both delta and snapshot are empty — cold start", async () => {
        const deps = createDeps({
            getCachedRelayEventsAfterSeq: mock(async () => []),
            getLatestCachedSnapshotEvent: mock(async () => null),
        });

        const { emit, calls } = createMockSocket();
        const result = await hydrateViewerFromCache({ emit }, "sess-012", { lastSeq: 99 }, deps);

        expect(result).toBe(false);
        expect(calls.length).toBe(0);
    });

    test("skips events without seq in delta resume", async () => {
        const deltaEvents = [
            { event: { type: "legacy_no_seq" } },
            { seq: 42, event: { type: "message_delta" } },
        ];
        const deps = createDeps({ getCachedRelayEventsAfterSeq: mock(async () => deltaEvents) });

        const { emit, calls } = createMockSocket();
        const result = await hydrateViewerFromCache({ emit }, "sess-013", { lastSeq: 41 }, deps);

        expect(result).toBe(true);
        expect(calls.length).toBe(1);
        expect(calls[0].payload).toMatchObject({ seq: 42, deltaReplay: true });
    });

    test("returns false (runner recovery) when all delta events lack seq (legacy cache)", async () => {
        // All cached events pre-date seq stamping — none have a seq field, so delta
        // replay emits nothing.  Same reasoning as above: don't snapshot-fallback;
        // return false and let the caller request runner recovery.
        const snapshot = { type: "session_active", state: { messages: [{ role: "assistant" }] } };
        const deps = createDeps({
            getCachedRelayEventsAfterSeq: mock(async () => [{ event: { type: "old_event" } }]),
            // Legacy cache: the snapshot has no seq either, so it cannot be proven safe.
            getLatestCachedSnapshotEvent: mock(async () => ({ event: snapshot, eventsAfter: [] })),
        });

        const { emit, calls } = createMockSocket();
        const result = await hydrateViewerFromCache({ emit }, "sess-014", { lastSeq: 3 }, deps);

        expect(result).toBe(false);
        expect(calls.length).toBe(0);
    });
});

describe("cache-first → runner signal suppression invariant", () => {
    test("cache HIT: returns true → activateSession sets suppressRunnerSignal=true (no runner signal)", async () => {
        const deps = createDeps({
            getLatestCachedSnapshotEvent: mock(async () => ({ event: { type: "session_active", state: { messages: [] } }, eventsAfter: [] })),
        });

        const { emit } = createMockSocket();
        const cacheHit = await hydrateViewerFromCache({ emit }, "sess-020", {}, deps);

        expect(cacheHit).toBe(true);
    });

    test("cache MISS: returns false → activateSession calls emitToRelaySession (runner fallback)", async () => {
        const deps = createDeps({
            getLatestCachedSnapshotEvent: mock(async () => null),
            getCachedRelayEventsAfterSeq: mock(async () => []),
        });

        const { emit } = createMockSocket();
        const cacheHit = await hydrateViewerFromCache({ emit }, "sess-021", {}, deps);

        expect(cacheHit).toBe(false);
    });

    test("cache HIT via delta: also returns true → runner signal suppressed", async () => {
        const deps = createDeps({
            getCachedRelayEventsAfterSeq: mock(async () => [{ seq: 8, event: { type: "message_end" } }]),
            getLatestCachedSnapshotEvent: mock(async () => null),
        });

        const { emit } = createMockSocket();
        const cacheHit = await hydrateViewerFromCache({ emit }, "sess-022", { lastSeq: 7 }, deps);

        expect(cacheHit).toBe(true);
    });
});

describe("sendCachedDeltaReplayEvents (re-exported helper)", () => {
    test("emits deltaReplay events in order with generation tag", () => {
        const socket = createMockSocket();

        const sent = sendCachedDeltaReplayEvents(socket, [
            { seq: 3, event: { type: "message_start" } },
            { seq: 4, event: { type: "message_end" } },
        ], 12);

        expect(sent).toBe(true);
        expect(socket.calls.map((call) => call.payload)).toEqual([
            { event: { type: "message_start" }, seq: 3, replay: true, deltaReplay: true, generation: 12 },
            { event: { type: "message_end" }, seq: 4, replay: true, deltaReplay: true, generation: 12 },
        ]);
    });

    test("returns false and emits nothing for empty event list", () => {
        const socket = createMockSocket();
        const sent = sendCachedDeltaReplayEvents(socket, []);

        expect(sent).toBe(false);
        expect(socket.calls.length).toBe(0);
    });

    test("omits generation from payload when undefined", () => {
        const socket = createMockSocket();
        sendCachedDeltaReplayEvents(socket, [{ seq: 1, event: {} }]);

        expect(socket.calls[0].payload).toEqual({
            event: {},
            seq: 1,
            replay: true,
            deltaReplay: true,
            generation: undefined,
        });
    });
});

describe("snapshotCoverageSeq", () => {
    test("is the snapshot seq when nothing trails it", () => {
        expect(snapshotCoverageSeq({ event: {}, snapshotSeq: 7, eventsAfter: [] })).toBe(7);
    });

    test("extends through a contiguous run of trailing deltas", () => {
        expect(snapshotCoverageSeq({
            event: {},
            snapshotSeq: 7,
            eventsAfter: [{ seq: 8, event: {} }, { seq: 9, event: {} }],
        })).toBe(9);
    });

    test("ignores unsequenced trailing records without breaking the run", () => {
        expect(snapshotCoverageSeq({
            event: {},
            snapshotSeq: 7,
            eventsAfter: [{ event: {} }, { seq: 8, event: {} }],
        })).toBe(8);
    });

    test("is null when the trailing run has a hole", () => {
        expect(snapshotCoverageSeq({
            event: {},
            snapshotSeq: 7,
            eventsAfter: [{ seq: 9, event: {} }],
        })).toBeNull();
    });

    test("is null for an unsequenced snapshot (chunked-assembled)", () => {
        expect(snapshotCoverageSeq({ event: {}, eventsAfter: [{ seq: 9, event: {} }] })).toBeNull();
    });

    test("snapshotCoversCursor compares coverage, not the snapshot seq alone", () => {
        const cached = {
            event: {},
            snapshotSeq: 8,
            eventsAfter: [{ seq: 9, event: {} }, { seq: 10, event: {} }],
        };
        expect(snapshotCoversCursor(cached, 10)).toBe(true);
        expect(snapshotCoversCursor(cached, 11)).toBe(false);
    });
});
