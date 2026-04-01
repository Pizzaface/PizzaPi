import { beforeEach, describe, expect, mock, test } from "bun:test";

import {
    hydrateViewerFromCache,
    sendCachedDeltaReplayEvents,
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
        deps = createDeps({ getLatestCachedSnapshotEvent: mock(async () => snapshot) });

        const { emit, calls } = createMockSocket();
        const result = await hydrateViewerFromCache({ emit }, "sess-001", {}, deps);

        expect(result).toBe(true);
        expect(calls.length).toBe(1);
        expect(calls[0].event).toBe("event");
        expect(calls[0].payload).toMatchObject({ event: snapshot, replay: true });
    });

    test("returns true and emits with generation when generation is provided", async () => {
        const snapshot = { type: "agent_end", messages: [{ role: "assistant" }] };
        deps = createDeps({ getLatestCachedSnapshotEvent: mock(async () => snapshot) });

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
        deps = createDeps({ getLatestCachedSnapshotEvent: mock(async () => snapshot) });

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

    test("falls back to snapshot when delta returns no events after lastSeq", async () => {
        const snapshot = { type: "session_active", state: { messages: [] } };
        const deps = createDeps({
            getCachedRelayEventsAfterSeq: mock(async () => []),
            getLatestCachedSnapshotEvent: mock(async () => snapshot),
        });

        const { emit, calls } = createMockSocket();
        const result = await hydrateViewerFromCache({ emit }, "sess-011", { lastSeq: 5 }, deps);

        expect(result).toBe(true);
        expect(calls.length).toBe(1);
        expect(calls[0].payload).toMatchObject({ event: snapshot, replay: true });
        expect((calls[0].payload as Record<string, unknown>).deltaReplay).toBeUndefined();
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

    test("falls back to snapshot when all delta events lack seq (legacy cache)", async () => {
        const snapshot = { type: "session_active", state: { messages: [{ role: "assistant" }] } };
        const deps = createDeps({
            getCachedRelayEventsAfterSeq: mock(async () => [{ event: { type: "old_event" } }]),
            getLatestCachedSnapshotEvent: mock(async () => snapshot),
        });

        const { emit, calls } = createMockSocket();
        const result = await hydrateViewerFromCache({ emit }, "sess-014", { lastSeq: 3 }, deps);

        expect(result).toBe(true);
        expect(calls.length).toBe(1);
        expect(calls[0].payload).toMatchObject({ event: snapshot, replay: true });
    });
});

describe("cache-first → runner signal suppression invariant", () => {
    test("cache HIT: returns true → activateSession sets suppressRunnerSignal=true (no runner signal)", async () => {
        const deps = createDeps({
            getLatestCachedSnapshotEvent: mock(async () => ({ type: "session_active", state: { messages: [] } })),
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
