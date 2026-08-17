import { beforeEach, describe, expect, mock, test } from "bun:test";

import {
    truncateSnapshotMessages,
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

// ── truncateSnapshotMessages ────────────────────────────────────────────────

describe("truncateSnapshotMessages", () => {
    test("returns all messages with hasMore=false when count is within tail size", () => {
        const state = {
            messages: [{ id: 1 }, { id: 2 }],
            model: { id: "sonnet" },
            sessionName: "Tail fits",
        };

        expect(truncateSnapshotMessages(state, 5)).toEqual({
            ...state,
            totalMessages: 2,
            hasMore: false,
            oldestLoadedIndex: 0,
        });
    });

    test("returns the last tailSize messages with hasMore=true when count exceeds tail size", () => {
        const state = {
            messages: Array.from({ length: 6 }, (_, index) => ({ id: index })),
            model: { id: "sonnet" },
        };

        expect(truncateSnapshotMessages(state, 3)).toEqual({
            ...state,
            messages: [{ id: 3 }, { id: 4 }, { id: 5 }],
            totalMessages: 6,
            hasMore: true,
            oldestLoadedIndex: 3,
        });
    });

    test("preserves other state properties", () => {
        const state = {
            messages: Array.from({ length: 4 }, (_, index) => ({ id: index })),
            model: { provider: "anthropic", id: "claude" },
            sessionName: "Preserve me",
            todoList: [{ title: "task" }],
        };

        const result = truncateSnapshotMessages(state, 2);
        expect(result.model).toEqual(state.model);
        expect(result.sessionName).toBe("Preserve me");
        expect(result.todoList).toEqual(state.todoList);
    });

    test("supports a custom tailSize parameter", () => {
        const state = {
            messages: Array.from({ length: 5 }, (_, index) => ({ id: index })),
        };

        expect(truncateSnapshotMessages(state, 1)).toEqual({
            ...state,
            messages: [{ id: 4 }],
            totalMessages: 5,
            hasMore: true,
            oldestLoadedIndex: 4,
        });
    });

    test("handles an empty messages array", () => {
        expect(truncateSnapshotMessages({ messages: [] })).toEqual({
            messages: [],
            totalMessages: 0,
            hasMore: false,
            oldestLoadedIndex: 0,
        });
    });

    test("handles state without a messages property gracefully", () => {
        expect(truncateSnapshotMessages({ sessionName: "No messages yet" })).toEqual({
            sessionName: "No messages yet",
            totalMessages: 0,
            hasMore: false,
            oldestLoadedIndex: 0,
        });
    });
});

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
            getLatestCachedSnapshotEvent: mock(async () => ({ event: snapshotEvent, eventsAfter: [] })),
        });

        const result = await tryCacheSnapshot("sess-10", deps);

        expect(result).not.toBeNull();
        expect(result!.snapshot.type).toBe("cache-snapshot");
    });

    test("send() emits the snapshot event with replay flag", async () => {
        const snapshotEvent = { type: "agent_end", messages: [{ role: "user" }] };
        const deps = createDeps({
            getLatestCachedSnapshotEvent: mock(async () => ({ event: snapshotEvent, eventsAfter: [] })),
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

    test("send() replays events cached after the snapshot so the viewer catches up to freshSeq", async () => {
        const snapshotEvent = { type: "session_active", state: { messages: [] } };
        const deps = createDeps({
            getLatestCachedSnapshotEvent: mock(async () => ({
                event: snapshotEvent,
                eventsAfter: [
                    { seq: 21, event: { type: "message_start" } },
                    { event: { type: "seqless_noise" } }, // no seq — skipped
                    { seq: 22, event: { type: "message_end" } },
                ],
            })),
        });

        const result = await tryCacheSnapshot("sess-13", deps);
        const socket = createMockSocket();
        result!.send(socket, 4);

        expect(socket.calls.length).toBe(3);
        expect(socket.calls[0].payload).toMatchObject({ event: snapshotEvent, replay: true });
        expect(socket.calls[1].payload).toMatchObject({
            event: { type: "message_start" },
            seq: 21,
            deltaReplay: true,
            generation: 4,
        });
        expect(socket.calls[2].payload).toMatchObject({
            event: { type: "message_end" },
            seq: 22,
            deltaReplay: true,
        });
    });

    test("returns null when Redis cache is empty", async () => {
        const deps = createDeps();
        const result = await tryCacheSnapshot("sess-12", deps);
        expect(result).toBeNull();
    });

    test("applies the snapshot overlay onto a stale cached snapshot", async () => {
        const snapshotEvent = { type: "session_active", state: { messages: [], queuedMessages: [] } };
        const deps = createDeps({
            getLatestCachedSnapshotEvent: mock(async () => ({ event: snapshotEvent, eventsAfter: [] })),
        });

        const overlay = JSON.stringify({ queuedMessages: ["follow up 1", "follow up 2"], thinkingLevel: "high" });
        const result = await tryCacheSnapshot("sess-14", deps, overlay);
        const socket = createMockSocket();
        result!.send(socket, 1);

        const sentState = (socket.calls[0].payload as any).event.state;
        expect(sentState.queuedMessages).toEqual(["follow up 1", "follow up 2"]);
        expect(sentState.thinkingLevel).toBe("high");
        // Original cached event is left untouched.
        expect(snapshotEvent.state.queuedMessages).toEqual([]);
    });

    test("overlay model is merged field-wise with the snapshot's model", async () => {
        const snapshotEvent = {
            type: "session_active",
            state: { messages: [], model: { provider: "p", id: "m", contextWindow: 200000 } },
        };
        const deps = createDeps({
            getLatestCachedSnapshotEvent: mock(async () => ({ event: snapshotEvent, eventsAfter: [] })),
        });

        const overlay = JSON.stringify({ model: { provider: "p", id: "m", thinking: true } });
        const result = await tryCacheSnapshot("sess-15", deps, overlay);
        const socket = createMockSocket();
        result!.send(socket, 1);

        expect((socket.calls[0].payload as any).event.state.model).toEqual({
            provider: "p",
            id: "m",
            contextWindow: 200000,
            thinking: true,
        });
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

    test("applies the snapshot overlay onto lastState", () => {
        const state = { messages: [{ role: "user" }], queuedMessages: [] };
        const result = tryMemoryState(JSON.stringify(state), JSON.stringify({ queuedMessages: ["q1"] }));

        const socket = createMockSocket();
        result!.send(socket, 1);
        expect((socket.calls[0].payload as any).event.state.queuedMessages).toEqual(["q1"]);
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
        expect(payload.event.state).toMatchObject({
            ...state,
            totalMessages: 1,
            hasMore: false,
            oldestLoadedIndex: 0,
        });
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
        expect(payload.event.state).toMatchObject({
            ...state,
            totalMessages: 0,
            hasMore: false,
            oldestLoadedIndex: 0,
        });
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
                event: { type: "session_active", state: { messages: [] } },
                eventsAfter: [],
                })),
            getPersistedRelaySessionSnapshot: mock(async () => ({
                state: { messages: [] },
            })),
        });

        const result = await getBestSnapshot("sess-30", { lastSeq: 10, userId: "u1", lastState: '{"messages":[]}' }, deps);

        expect(result).not.toBeNull();
        expect(result!.snapshot.type).toBe("cache-delta");
    });

    test("returns an already-current no-op when the empty delta matches latestSeq", async () => {
        const deps = createDeps({
            getCachedRelayEventsAfterSeq: mock(async () => []),
        });

        const result = await getBestSnapshot("sess-31", { lastSeq: 10, latestSeq: 10 }, deps);

        expect(result?.snapshot.type).toBe("already-current");
        const socket = createMockSocket();
        result?.send(socket);
        expect(socket.calls).toHaveLength(0);
    });

    test("returns null when latestSeq is newer than the client's cursor", async () => {
        const deps = createDeps({
            getCachedRelayEventsAfterSeq: mock(async () => []),
        });

        const result = await getBestSnapshot("sess-32", { lastSeq: 10, latestSeq: 11 }, deps);

        expect(result).toBeNull();
    });

    test("resumes via a seq-stamped snapshot when the delta replay is empty", async () => {
        // Regression for "blank conversation until I hit refresh": an empty delta
        // replay used to be terminal for any viewer holding a cursor, so a
        // reconnect delivered no transcript at all and nothing ever retried.
        const snapshotEvent = { type: "session_active", state: { messages: [{ role: "user" }] } };
        const deps = createDeps({
            getCachedRelayEventsAfterSeq: mock(async () => []),
            getLatestCachedSnapshotEvent: mock(async () => ({
                event: snapshotEvent,
                snapshotSeq: 14,
                eventsAfter: [],
            })),
        });

        const result = await getBestSnapshot("sess-31a", { lastSeq: 10, latestSeq: 14 }, deps);

        expect(result?.snapshot.type).toBe("cache-snapshot");
        expect(result?.snapshot.seq).toBe(14);
        const socket = createMockSocket();
        result?.send(socket);
        expect(socket.calls).toHaveLength(1);
    });

    test("refuses a snapshot older than the client cursor rather than rewinding it", async () => {
        const snapshotEvent = { type: "session_active", state: { messages: [] } };
        const deps = createDeps({
            getCachedRelayEventsAfterSeq: mock(async () => []),
            getLatestCachedSnapshotEvent: mock(async () => ({
                event: snapshotEvent,
                snapshotSeq: 4,
                eventsAfter: [],
            })),
        });

        const result = await getBestSnapshot("sess-31b", { lastSeq: 10, latestSeq: 14 }, deps);

        expect(result).toBeNull();
    });

    test("an older snapshot IS served when its trailing deltas reach the cursor", async () => {
        // Delta replay refuses (its own contiguity check from lastSeq+1 failed,
        // e.g. a legacy unsequenced row in the list), but the snapshot's trailing
        // run is contiguous and reaches past the cursor, so it is safe to replay.
        const snapshotEvent = { type: "session_active", state: { messages: [] } };
        const deps = createDeps({
            getCachedRelayEventsAfterSeq: mock(async () => []),
            getLatestCachedSnapshotEvent: mock(async () => ({
                event: snapshotEvent,
                snapshotSeq: 8,
                eventsAfter: [
                    { seq: 9, event: { type: "message_update" } },
                    { seq: 10, event: { type: "message_end" } },
                    { seq: 11, event: { type: "message_update" } },
                    { seq: 12, event: { type: "message_end" } },
                ],
            })),
        });

        const result = await getBestSnapshot("sess-31e", { lastSeq: 10, latestSeq: 12 }, deps);

        expect(result?.snapshot.type).toBe("cache-snapshot");
        expect(result?.snapshot.seq).toBe(12);
    });

    test("prefers the already-current no-op over resending a transcript the viewer has", async () => {
        // A level viewer must not be handed a full snapshot: replacing its
        // transcript would also discard any older history it had paged in.
        const snapshotEvent = { type: "session_active", state: { messages: [] } };
        const getLatestCachedSnapshotEvent = mock(async () => ({
            event: snapshotEvent,
            snapshotSeq: 10,
            eventsAfter: [],
        }));
        const deps = createDeps({
            getCachedRelayEventsAfterSeq: mock(async () => []),
            getLatestCachedSnapshotEvent,
        });

        const result = await getBestSnapshot("sess-31g", { lastSeq: 10, latestSeq: 10 }, deps);

        expect(result?.snapshot.type).toBe("already-current");
        expect(getLatestCachedSnapshotEvent).not.toHaveBeenCalled();
    });

    test("a resume snapshot keeps loaded history instead of truncating to the tail", async () => {
        // Truncation is a cold-start bandwidth guard. Applying it on a resume
        // would erase history the viewer had paged in, on a mere network blip.
        const messages = Array.from({ length: 120 }, (_, i) => ({ id: i }));
        const deps = createDeps({
            getCachedRelayEventsAfterSeq: mock(async () => []),
            getLatestCachedSnapshotEvent: mock(async () => ({
                event: { type: "session_active", state: { messages } },
                snapshotSeq: 14,
                eventsAfter: [],
            })),
        });

        const result = await getBestSnapshot("sess-31h", { lastSeq: 10, latestSeq: 14 }, deps);
        expect(result?.snapshot.type).toBe("cache-snapshot");

        const socket = createMockSocket();
        result?.send(socket);
        const payload = socket.calls[0]!.payload as { event: { state: { messages: unknown[] } } };
        expect(payload.event.state.messages).toHaveLength(120);
    });

    test("a cold-start snapshot still truncates to the message tail", async () => {
        const messages = Array.from({ length: 120 }, (_, i) => ({ id: i }));
        const deps = createDeps({
            getLatestCachedSnapshotEvent: mock(async () => ({
                event: { type: "session_active", state: { messages } },
                snapshotSeq: 14,
                eventsAfter: [],
            })),
        });

        const result = await getBestSnapshot("sess-31i", {}, deps);
        const socket = createMockSocket();
        result?.send(socket);
        const payload = socket.calls[0]!.payload as {
            event: { state: { messages: unknown[]; hasMore: boolean } };
        };
        expect(payload.event.state.messages).toHaveLength(50);
        expect(payload.event.state.hasMore).toBe(true);
    });

    test("refuses a snapshot whose trailing deltas have a hole", async () => {
        // A gap between the snapshot and the cursor means replacing the transcript
        // would silently drop whatever fell in the hole.
        const snapshotEvent = { type: "session_active", state: { messages: [] } };
        const deps = createDeps({
            getCachedRelayEventsAfterSeq: mock(async () => []),
            getLatestCachedSnapshotEvent: mock(async () => ({
                event: snapshotEvent,
                snapshotSeq: 8,
                eventsAfter: [{ seq: 11, event: { type: "message_end" } }],
            })),
        });

        const result = await getBestSnapshot("sess-31f", { lastSeq: 10, latestSeq: 11 }, deps);

        expect(result).toBeNull();
    });

    test("never serves unsequenced lastState or SQLite state to a cursor-holding viewer", async () => {
        // lastState is written on session_active only, so it can be arbitrarily
        // older than the cursor. Guessing its position would poison the cursor.
        const deps = createDeps({
            getCachedRelayEventsAfterSeq: mock(async () => []),
            getLatestCachedSnapshotEvent: mock(async () => null),
            getPersistedRelaySessionSnapshot: mock(async () => ({ state: { messages: ["persisted"] } })),
        });

        const result = await getBestSnapshot(
            "sess-31c",
            { lastSeq: 10, latestSeq: 14, userId: "u1", lastState: '{"messages":["memory"]}' },
            deps,
        );

        expect(result).toBeNull();
    });

    test("still prefers a cheap delta replay over a full snapshot", async () => {
        const deps = createDeps({
            getCachedRelayEventsAfterSeq: mock(async () => [
                { seq: 11, event: { type: "message_start" } },
            ]),
            getLatestCachedSnapshotEvent: mock(async () => ({
                event: { type: "session_active", state: { messages: [] } },
                snapshotSeq: 14,
                eventsAfter: [],
            })),
        });

        const result = await getBestSnapshot("sess-31d", { lastSeq: 10, latestSeq: 14 }, deps);

        expect(result?.snapshot.type).toBe("cache-delta");
    });

    test("returns null when delta replay is unavailable", async () => {
        const deps = createDeps({
            getCachedRelayEventsAfterSeq: mock(async () => {
                throw new Error("Redis unavailable");
            }),
        });

        const result = await getBestSnapshot("sess-33", { lastSeq: 10, latestSeq: 10 }, deps);

        expect(result).toBeNull();
    });

    test("priority 2: returns cache snapshot when no lastSeq", async () => {
        const snapshotEvent = { type: "session_active", state: { messages: [] } };
        const deps = createDeps({
            getLatestCachedSnapshotEvent: mock(async () => ({ event: snapshotEvent, eventsAfter: [] })),
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
            getLatestCachedSnapshotEvent: mock(async () => ({ event: snapshotEvent, eventsAfter: [] })),
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
