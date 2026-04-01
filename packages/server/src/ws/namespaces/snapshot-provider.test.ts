import { beforeEach, describe, expect, mock, test } from "bun:test";

import {
    tryDeltaReplay,
    tryCacheSnapshot,
    tryMemoryState,
    tryPersistedSnapshot,
    getBestSnapshot,
    type SnapshotProviderDeps,
    type SnapshotResult,
} from "./snapshot-provider.js";
import type { CachedRelayEvent } from "./viewer-cache.js";

// ── Mock helpers ─────────────────────────────────────────────────────────────

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

function createDeps(overrides: Partial<SnapshotProviderDeps> = {}): SnapshotProviderDeps {
    return {
        getCachedRelayEventsAfterSeq: overrides.getCachedRelayEventsAfterSeq ?? mock(async () => [] as CachedRelayEvent[]),
        getLatestCachedSnapshotEvent: overrides.getLatestCachedSnapshotEvent ?? mock(async () => null),
        getPersistedRelaySessionSnapshot: overrides.getPersistedRelaySessionSnapshot ?? mock(async () => null),
    };
}

// ── tryDeltaReplay ───────────────────────────────────────────────────────────

describe("tryDeltaReplay", () => {
    test("returns SnapshotResult when cached events exist after seq", async () => {
        const events: CachedRelayEvent[] = [
            { seq: 11, event: { type: "message_start" } },
            { seq: 12, event: { type: "message_end" } },
        ];
        const deps = createDeps({
            getCachedRelayEventsAfterSeq: mock(async () => events),
        });

        const result = await tryDeltaReplay("sess-1", 10, deps);

        expect(result).not.toBeNull();
        expect(result!.snapshot.type).toBe("cache-delta");
        expect(result!.snapshot.source).toContain("10");
    });

    test("send() emits delta replay events to the socket", async () => {
        const events: CachedRelayEvent[] = [
            { seq: 5, event: { type: "message_delta" } },
        ];
        const deps = createDeps({
            getCachedRelayEventsAfterSeq: mock(async () => events),
        });

        const result = await tryDeltaReplay("sess-2", 4, deps);
        const socket = createMockSocket();
        result!.send(socket, 7);

        expect(socket.calls.length).toBe(1);
        expect(socket.calls[0].payload).toMatchObject({
            seq: 5,
            replay: true,
            deltaReplay: true,
            generation: 7,
        });
    });

    test("returns null when no events after seq", async () => {
        const deps = createDeps({
            getCachedRelayEventsAfterSeq: mock(async () => []),
        });

        const result = await tryDeltaReplay("sess-3", 100, deps);
        expect(result).toBeNull();
    });

    test("returns null when all events lack seq (legacy cache)", async () => {
        const events: CachedRelayEvent[] = [
            { event: { type: "old_event" } },
            { event: { type: "another_old" } },
        ];
        const deps = createDeps({
            getCachedRelayEventsAfterSeq: mock(async () => events),
        });

        const result = await tryDeltaReplay("sess-4", 5, deps);
        expect(result).toBeNull();
    });
});

// ── tryCacheSnapshot ─────────────────────────────────────────────────────────

describe("tryCacheSnapshot", () => {
    test("returns SnapshotResult when Redis has a snapshot event", async () => {
        const snapshotEvent = { type: "session_active", state: { messages: [] } };
        const deps = createDeps({
            getLatestCachedSnapshotEvent: mock(async () => snapshotEvent),
        });

        const result = await tryCacheSnapshot("sess-10", deps);

        expect(result).not.toBeNull();
        expect(result!.snapshot.type).toBe("cache-snapshot");
    });

    test("send() emits the snapshot event with replay flag", async () => {
        const snapshotEvent = { type: "agent_end", messages: [{ role: "user" }] };
        const deps = createDeps({
            getLatestCachedSnapshotEvent: mock(async () => snapshotEvent),
        });

        const result = await tryCacheSnapshot("sess-11", deps);
        const socket = createMockSocket();
        result!.send(socket, 3);

        expect(socket.calls.length).toBe(1);
        expect(socket.calls[0].event).toBe("event");
        expect(socket.calls[0].payload).toMatchObject({
            event: snapshotEvent,
            replay: true,
            generation: 3,
        });
    });

    test("returns null when Redis cache is empty", async () => {
        const deps = createDeps();
        const result = await tryCacheSnapshot("sess-12", deps);
        expect(result).toBeNull();
    });
});

// ── tryMemoryState ───────────────────────────────────────────────────────────

describe("tryMemoryState", () => {
    test("returns SnapshotResult for valid JSON lastState", () => {
        const state = { messages: [{ role: "assistant" }] };
        const result = tryMemoryState(JSON.stringify(state));

        expect(result).not.toBeNull();
        expect(result!.snapshot.type).toBe("memory");
    });

    test("send() emits session_active with _metaViaHub hint", () => {
        const state = { messages: [{ role: "user" }] };
        const result = tryMemoryState(JSON.stringify(state));

        const socket = createMockSocket();
        result!.send(socket, 5);

        expect(socket.calls.length).toBe(1);
        expect(socket.calls[0].event).toBe("event");
        const payload = socket.calls[0].payload as any;
        expect(payload.event.type).toBe("session_active");
        expect(payload.event.state).toEqual(state);
        expect(payload.event._metaViaHub).toBe(true);
        expect(payload.generation).toBe(5);
    });

    test("returns null for null lastState", () => {
        expect(tryMemoryState(null)).toBeNull();
    });

    test("returns null for undefined lastState", () => {
        expect(tryMemoryState(undefined)).toBeNull();
    });

    test("returns null for empty string", () => {
        expect(tryMemoryState("")).toBeNull();
    });

    test("returns null for invalid JSON", () => {
        expect(tryMemoryState("{not valid json")).toBeNull();
    });
});

// ── tryPersistedSnapshot ─────────────────────────────────────────────────────

describe("tryPersistedSnapshot", () => {
    test("returns SnapshotResult when persisted state exists", async () => {
        const deps = createDeps({
            getPersistedRelaySessionSnapshot: mock(async () => ({
                state: { messages: [{ role: "user" }] },
            })),
        });

        const result = await tryPersistedSnapshot("sess-20", "user-1", deps);

        expect(result).not.toBeNull();
        expect(result!.snapshot.type).toBe("persisted");
        expect(result!.snapshot.source).toContain("SQLite");
    });

    test("send() emits session_active without _metaViaHub (no live hub)", async () => {
        const state = { messages: [] };
        const deps = createDeps({
            getPersistedRelaySessionSnapshot: mock(async () => ({ state })),
        });

        const result = await tryPersistedSnapshot("sess-21", "user-1", deps);
        const socket = createMockSocket();
        result!.send(socket, 2);

        expect(socket.calls.length).toBe(1);
        const payload = socket.calls[0].payload as any;
        expect(payload.event.type).toBe("session_active");
        expect(payload.event.state).toEqual(state);
        expect(payload.event._metaViaHub).toBeUndefined();
        expect(payload.generation).toBe(2);
    });

    test("returns null when no persisted session found", async () => {
        const deps = createDeps();
        const result = await tryPersistedSnapshot("sess-22", "user-1", deps);
        expect(result).toBeNull();
    });

    test("returns null when persisted state is null", async () => {
        const deps = createDeps({
            getPersistedRelaySessionSnapshot: mock(async () => ({ state: null })),
        });

        const result = await tryPersistedSnapshot("sess-23", "user-1", deps);
        expect(result).toBeNull();
    });

    test("returns null when persisted state is undefined", async () => {
        const deps = createDeps({
            getPersistedRelaySessionSnapshot: mock(async () => ({ state: undefined })),
        });

        const result = await tryPersistedSnapshot("sess-24", "user-1", deps);
        expect(result).toBeNull();
    });
});

// ── getBestSnapshot — priority ordering ──────────────────────────────────────

describe("getBestSnapshot — priority ordering", () => {
    test("priority 1: returns delta replay when lastSeq is provided and events exist", async () => {
        const deps = createDeps({
            getCachedRelayEventsAfterSeq: mock(async () => [
                { seq: 11, event: { type: "message_start" } },
            ]),
            getLatestCachedSnapshotEvent: mock(async () => ({
                type: "session_active",
                state: { messages: [] },
            })),
            getPersistedRelaySessionSnapshot: mock(async () => ({
                state: { messages: [] },
            })),
        });

        const result = await getBestSnapshot("sess-30", { lastSeq: 10, userId: "u1", lastState: '{"messages":[]}' }, deps);

        expect(result).not.toBeNull();
        expect(result!.snapshot.type).toBe("cache-delta");
    });

    test("priority 1 fail: returns null (not snapshot) when lastSeq provided but delta empty", async () => {
        // This is the critical invariant: when lastSeq is provided but delta
        // fails, do NOT fall back to snapshot — it has no seq and would roll
        // back the client's transcript. Return null for runner recovery.
        const deps = createDeps({
            getCachedRelayEventsAfterSeq: mock(async () => []),
            getLatestCachedSnapshotEvent: mock(async () => ({
                type: "session_active",
                state: { messages: [] },
            })),
            getPersistedRelaySessionSnapshot: mock(async () => ({
                state: { messages: [] },
            })),
        });

        const result = await getBestSnapshot("sess-31", {
            lastSeq: 10,
            userId: "u1",
            lastState: '{"messages":[]}',
        }, deps);

        expect(result).toBeNull();
    });

    test("priority 2: returns cache snapshot when no lastSeq", async () => {
        const snapshotEvent = { type: "session_active", state: { messages: [] } };
        const deps = createDeps({
            getLatestCachedSnapshotEvent: mock(async () => snapshotEvent),
            getPersistedRelaySessionSnapshot: mock(async () => ({
                state: { messages: ["persisted"] },
            })),
        });

        const result = await getBestSnapshot("sess-32", {
            userId: "u1",
            lastState: '{"messages":["memory"]}',
        }, deps);

        expect(result).not.toBeNull();
        expect(result!.snapshot.type).toBe("cache-snapshot");
    });

    test("priority 3: returns memory state when cache is empty", async () => {
        const deps = createDeps({
            getLatestCachedSnapshotEvent: mock(async () => null),
            getPersistedRelaySessionSnapshot: mock(async () => ({
                state: { messages: ["persisted"] },
            })),
        });

        const result = await getBestSnapshot("sess-33", {
            userId: "u1",
            lastState: '{"messages":["memory"]}',
        }, deps);

        expect(result).not.toBeNull();
        expect(result!.snapshot.type).toBe("memory");
    });

    test("priority 3 skipped: memory state skipped when chunkedPending", async () => {
        const deps = createDeps({
            getLatestCachedSnapshotEvent: mock(async () => null),
            getPersistedRelaySessionSnapshot: mock(async () => ({
                state: { messages: ["persisted"] },
            })),
        });

        const result = await getBestSnapshot("sess-34", {
            userId: "u1",
            lastState: '{"messages":["memory"]}',
            chunkedPending: true,
        }, deps);

        expect(result).not.toBeNull();
        expect(result!.snapshot.type).toBe("persisted");
    });

    test("priority 4: returns persisted snapshot as last resort", async () => {
        const deps = createDeps({
            getLatestCachedSnapshotEvent: mock(async () => null),
            getPersistedRelaySessionSnapshot: mock(async () => ({
                state: { messages: ["persisted"] },
            })),
        });

        const result = await getBestSnapshot("sess-35", { userId: "u1" }, deps);

        expect(result).not.toBeNull();
        expect(result!.snapshot.type).toBe("persisted");
    });

    test("returns null when all sources fail", async () => {
        const deps = createDeps();
        const result = await getBestSnapshot("sess-36", {}, deps);
        expect(result).toBeNull();
    });

    test("returns null when persisted has no state and no other sources", async () => {
        const deps = createDeps({
            getPersistedRelaySessionSnapshot: mock(async () => ({ state: null })),
        });

        const result = await getBestSnapshot("sess-37", { userId: "u1" }, deps);
        expect(result).toBeNull();
    });

    test("skips persisted when no userId provided", async () => {
        const getPersistedMock = mock(async () => ({ state: { messages: [] } }));
        const deps = createDeps({
            getPersistedRelaySessionSnapshot: getPersistedMock,
        });

        const result = await getBestSnapshot("sess-38", {}, deps);
        expect(result).toBeNull();
        expect(getPersistedMock).not.toHaveBeenCalled();
    });
});

// ── getBestSnapshot — graceful degradation ───────────────────────────────────

describe("getBestSnapshot — graceful degradation", () => {
    test("falls through when cache snapshot throws", async () => {
        const deps = createDeps({
            getLatestCachedSnapshotEvent: mock(async () => {
                throw new Error("Redis unavailable");
            }),
            getPersistedRelaySessionSnapshot: mock(async () => ({
                state: { messages: ["persisted"] },
            })),
        });

        const result = await getBestSnapshot("sess-40", { userId: "u1", lastState: '{"m":[]}' }, deps);

        // Should fall through to memory state (priority 3)
        expect(result).not.toBeNull();
        expect(result!.snapshot.type).toBe("memory");
    });

    test("falls through when delta replay throws (with lastSeq)", async () => {
        const deps = createDeps({
            getCachedRelayEventsAfterSeq: mock(async () => {
                throw new Error("Redis connection lost");
            }),
        });

        // When lastSeq is provided and delta throws, we still return null
        // (don't fall through to snapshot) because the invariant is:
        // "lastSeq provided + delta failed = runner recovery"
        const result = await getBestSnapshot("sess-41", { lastSeq: 5 }, deps);
        expect(result).toBeNull();
    });

    test("falls through when memory state has invalid JSON", async () => {
        const deps = createDeps({
            getLatestCachedSnapshotEvent: mock(async () => null),
            getPersistedRelaySessionSnapshot: mock(async () => ({
                state: { messages: ["persisted"] },
            })),
        });

        const result = await getBestSnapshot("sess-42", {
            userId: "u1",
            lastState: "not valid json {{{",
        }, deps);

        expect(result).not.toBeNull();
        expect(result!.snapshot.type).toBe("persisted");
    });

    test("falls through when persisted throws", async () => {
        const deps = createDeps({
            getLatestCachedSnapshotEvent: mock(async () => null),
            getPersistedRelaySessionSnapshot: mock(async () => {
                throw new Error("SQLite locked");
            }),
        });

        const result = await getBestSnapshot("sess-43", { userId: "u1" }, deps);
        expect(result).toBeNull();
    });
});

// ── getBestSnapshot — chunkedPending behavior ────────────────────────────────

describe("getBestSnapshot — chunkedPending sessions", () => {
    test("skips memory state when chunkedPending is true", async () => {
        const deps = createDeps({
            getLatestCachedSnapshotEvent: mock(async () => null),
        });

        const result = await getBestSnapshot("sess-50", {
            lastState: '{"messages":[]}',
            chunkedPending: true,
        }, deps);

        // No userId, so no persisted fallback either — should be null
        expect(result).toBeNull();
    });

    test("still uses cache snapshot even when chunkedPending", async () => {
        const snapshotEvent = { type: "session_active", state: { messages: [] } };
        const deps = createDeps({
            getLatestCachedSnapshotEvent: mock(async () => snapshotEvent),
        });

        const result = await getBestSnapshot("sess-51", {
            lastState: '{"messages":[]}',
            chunkedPending: true,
        }, deps);

        expect(result).not.toBeNull();
        expect(result!.snapshot.type).toBe("cache-snapshot");
    });

    test("falls through to persisted when chunkedPending skips memory", async () => {
        const deps = createDeps({
            getLatestCachedSnapshotEvent: mock(async () => null),
            getPersistedRelaySessionSnapshot: mock(async () => ({
                state: { messages: ["persisted"] },
            })),
        });

        const result = await getBestSnapshot("sess-52", {
            userId: "u1",
            lastState: '{"messages":["memory"]}',
            chunkedPending: true,
        }, deps);

        expect(result).not.toBeNull();
        expect(result!.snapshot.type).toBe("persisted");
    });
});
