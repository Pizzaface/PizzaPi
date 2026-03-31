// ============================================================================
// viewer.test.ts — Unit tests for pure helper functions in viewer.ts
//
// The socket event handlers (resync, connect) require a full socket.io + Redis
// stack and are covered by integration tests.  This file tests the pure
// snapshot-scanning helpers that have no I/O dependencies.
// ============================================================================

import { describe, test, expect, mock } from "bun:test";
import {
    isAgentEndEvent,
    isSessionActiveEvent,
    findLatestSnapshotEvent,
    onViewerConnectedSignal,
    onViewerReadyForRunnerSignal,
    isViewerSwitchCurrent,
    withHubMetaSource,
    withMetaViaHubHint,
    withLivenessOnlyHint,
    sendCachedDeltaReplayEvents,
} from "./viewer.js";

// ── isAgentEndEvent ──────────────────────────────────────────────────────────

describe("isAgentEndEvent", () => {
    test("returns true for a valid agent_end event", () => {
        expect(isAgentEndEvent({ type: "agent_end", messages: [] })).toBe(true);
        expect(isAgentEndEvent({ type: "agent_end", messages: [{ role: "user" }] })).toBe(true);
    });

    test("returns false for missing or wrong type", () => {
        expect(isAgentEndEvent({ type: "session_active", messages: [] })).toBe(false);
        expect(isAgentEndEvent({ messages: [] })).toBe(false);
        expect(isAgentEndEvent({ type: "agent_end" })).toBe(false);
    });

    test("returns false when messages is not an array", () => {
        expect(isAgentEndEvent({ type: "agent_end", messages: "not-an-array" })).toBe(false);
        expect(isAgentEndEvent({ type: "agent_end", messages: null })).toBe(false);
    });

    test("returns false for non-objects", () => {
        expect(isAgentEndEvent(null)).toBe(false);
        expect(isAgentEndEvent(undefined)).toBe(false);
        expect(isAgentEndEvent("string")).toBe(false);
        expect(isAgentEndEvent(42)).toBe(false);
    });
});

// ── isSessionActiveEvent ─────────────────────────────────────────────────────

describe("isSessionActiveEvent", () => {
    test("returns true for a valid session_active event", () => {
        expect(isSessionActiveEvent({ type: "session_active", state: {} })).toBe(true);
        expect(isSessionActiveEvent({ type: "session_active", state: { messages: [] } })).toBe(true);
        expect(isSessionActiveEvent({ type: "session_active", state: 0 })).toBe(true); // falsy but defined
    });

    test("returns false for missing or wrong type", () => {
        expect(isSessionActiveEvent({ type: "agent_end", state: {} })).toBe(false);
        expect(isSessionActiveEvent({ state: {} })).toBe(false);
    });

    test("returns false when state is missing", () => {
        expect(isSessionActiveEvent({ type: "session_active" })).toBe(false);
    });

    test("returns false when state is undefined", () => {
        expect(isSessionActiveEvent({ type: "session_active", state: undefined })).toBe(false);
    });

    test("returns false for non-objects", () => {
        expect(isSessionActiveEvent(null)).toBe(false);
        expect(isSessionActiveEvent(undefined)).toBe(false);
        expect(isSessionActiveEvent("string")).toBe(false);
    });
});

// ── findLatestSnapshotEvent ──────────────────────────────────────────────────

describe("findLatestSnapshotEvent", () => {
    test("returns null for empty array", () => {
        expect(findLatestSnapshotEvent([])).toBeNull();
    });

    test("returns null when no snapshot event exists", () => {
        const events = [
            { type: "tool_use", id: "1" },
            { type: "text_delta", text: "hello" },
        ];
        expect(findLatestSnapshotEvent(events)).toBeNull();
    });

    test("finds a session_active event", () => {
        const sa = { type: "session_active", state: { messages: [] } };
        expect(findLatestSnapshotEvent([{ type: "tool_use" }, sa])).toBe(sa);
    });

    test("finds an agent_end event", () => {
        const ae = { type: "agent_end", messages: [{ role: "user" }] };
        expect(findLatestSnapshotEvent([{ type: "other" }, ae])).toBe(ae);
    });

    test("returns the LATEST snapshot (searches newest-to-oldest)", () => {
        const older = { type: "session_active", state: { messages: [1] } };
        const newer = { type: "session_active", state: { messages: [1, 2] } };
        expect(findLatestSnapshotEvent([older, newer])).toBe(newer);
    });

    test("prefers agent_end over session_active when agent_end is newer", () => {
        const sa = { type: "session_active", state: {} };
        const ae = { type: "agent_end", messages: [] };
        expect(findLatestSnapshotEvent([sa, ae])).toBe(ae);
    });

    test("returns session_active when it is newer than agent_end", () => {
        const ae = { type: "agent_end", messages: [] };
        const sa = { type: "session_active", state: {} };
        expect(findLatestSnapshotEvent([ae, sa])).toBe(sa);
    });

    test("skips non-snapshot events between snapshot events", () => {
        const older = { type: "session_active", state: { messages: [1] } };
        const noise = { type: "tool_use", id: "x" };
        const newer = { type: "agent_end", messages: [{ role: "assistant" }] };
        expect(findLatestSnapshotEvent([older, noise, newer])).toBe(newer);
    });

    test("ignores invalid agent_end events (missing messages)", () => {
        const invalid = { type: "agent_end" }; // no messages field
        const valid = { type: "session_active", state: {} };
        expect(findLatestSnapshotEvent([valid, invalid])).toBe(valid);
    });

    test("handles a single snapshot event", () => {
        const sa = { type: "session_active", state: {} };
        expect(findLatestSnapshotEvent([sa])).toBe(sa);
    });
});

// ── viewer switch generation guards ────────────────────────────────────────

describe("isViewerSwitchCurrent", () => {
    test("accepts payloads with no generation", () => {
        expect(isViewerSwitchCurrent(4, undefined)).toBe(true);
    });

    test("accepts matching generations", () => {
        expect(isViewerSwitchCurrent(4, 4)).toBe(true);
    });

    test("rejects stale generations", () => {
        expect(isViewerSwitchCurrent(4, 3)).toBe(false);
    });
});

// ── viewer connected signal gating ──────────────────────────────────────────

describe("viewer connected signal gating", () => {
    test("defers forwarding when viewer is not yet ready", () => {
        expect(onViewerConnectedSignal(false, false)).toEqual({
            pendingConnectedSignal: true,
            forwardNow: false,
        });
    });

    test("forwards immediately when viewer is ready", () => {
        expect(onViewerConnectedSignal(true, false)).toEqual({
            pendingConnectedSignal: false,
            forwardNow: true,
        });
    });

    test("flushes pending signal when viewer becomes ready", () => {
        expect(onViewerReadyForRunnerSignal(true)).toEqual({
            pendingConnectedSignal: false,
            forwardNow: true,
        });
    });

    test("does nothing on ready transition with no pending signal", () => {
        expect(onViewerReadyForRunnerSignal(false)).toEqual({
            pendingConnectedSignal: false,
            forwardNow: false,
        });
    });
});

// ── meta routing hints ──────────────────────────────────────────────────────

describe("meta routing hints", () => {
    test("marks connected payloads as hub-authored", () => {
        expect(withHubMetaSource({ sessionId: "sess-1" })).toEqual({
            sessionId: "sess-1",
            meta_source: "hub",
        });
    });

    test("marks session_active snapshots as hub-based meta", () => {
        expect(withMetaViaHubHint({ type: "session_active", state: {} })).toEqual({
            type: "session_active",
            state: {},
            _metaViaHub: true,
        });
    });

    test("marks heartbeat snapshots as liveness only", () => {
        expect(withLivenessOnlyHint({ type: "heartbeat", active: true })).toEqual({
            type: "heartbeat",
            active: true,
            _livenessOnly: true,
        });
    });
});

// ── delta replay emission ───────────────────────────────────────────────────

describe("sendCachedDeltaReplayEvents", () => {
    test("emits sequenced replay events with deltaReplay flag", () => {
        const emit = mock(() => {});
        const socket = { emit };

        const sent = sendCachedDeltaReplayEvents(socket, [
            { seq: 11, event: { type: "message_start" } },
            { seq: 12, event: { type: "message_end" } },
        ], 7);

        expect(sent).toBe(true);
        expect(emit).toHaveBeenCalledTimes(2);
        expect(emit.mock.calls[0][0]).toBe("event");
        expect(emit.mock.calls[0][1]).toEqual({
            event: { type: "message_start" },
            seq: 11,
            replay: true,
            deltaReplay: true,
            generation: 7,
        });
        expect(emit.mock.calls[1][1]).toEqual({
            event: { type: "message_end" },
            seq: 12,
            replay: true,
            deltaReplay: true,
            generation: 7,
        });
    });

    test("returns false when there are no sequenced events to replay", () => {
        const emit = mock(() => {});
        const sent = sendCachedDeltaReplayEvents({ emit }, [{ event: { type: "message_start" } }]);

        expect(sent).toBe(false);
        expect(emit).not.toHaveBeenCalled();
    });
});
