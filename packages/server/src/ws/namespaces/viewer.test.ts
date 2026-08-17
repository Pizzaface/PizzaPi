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
    shouldAvoidSnapshotFallback,
    forwardRecoveryConnectedSignal,
    runnerLooksLive,
    withHubMetaSource,
    withLivenessOnlyHint,
    sendCachedDeltaReplayEvents,
    checkServiceMessageSize,
    checkServiceMessageRateLimit,
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

describe("shouldAvoidSnapshotFallback", () => {
    test("blocks stale snapshots for seq cache misses and chunk assembly", () => {
        expect(shouldAvoidSnapshotFallback(12, null)).toBe(true);
        expect(shouldAvoidSnapshotFallback(undefined, { snapshotId: "snap-1" })).toBe(true);
        expect(shouldAvoidSnapshotFallback(undefined, null)).toBe(false);
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



    test("socket.on(\"connected\") forwarding marks recovery before emitting to relay", async () => {
        const calls: string[] = [];
        const next = onViewerConnectedSignal(true, false);

        expect(next).toEqual({
            pendingConnectedSignal: false,
            forwardNow: true,
        });

        const delivered = await forwardRecoveryConnectedSignal("sess-connected", {
            markPendingRecovery: mock((sessionId: string) => {
                calls.push(`mark:${sessionId}`);
                return "nonce-1";
            }),
            emitToRelaySessionChecked: mock(async (sessionId: string, event: string) => {
                calls.push(`emit:${event}:${sessionId}`);
                return "delivered";
            }) as any,
        });

        expect(delivered).toBe("delivered");
        expect(calls).toEqual([
            "mark:sess-connected",
            "emit:connected:sess-connected",
        ]);
    });

    test("recovery signal reports empty when the room is confirmed empty", async () => {
        const result = await forwardRecoveryConnectedSignal("sess-empty-room", {
            markPendingRecovery: mock(() => "nonce-1"),
            emitToRelaySessionChecked: mock(async () => "empty") as any,
        });
        expect(result).toBe("empty");
    });

    test("recovery signal reports unknown when the adapter lookup fails", async () => {
        const result = await forwardRecoveryConnectedSignal("sess-degraded", {
            markPendingRecovery: mock(() => "nonce-1"),
            emitToRelaySessionChecked: mock(async () => "unknown") as any,
        });
        expect(result).toBe("unknown");
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

    test("ready-transition forwarding also marks recovery before emitting to relay", async () => {
        const calls: string[] = [];
        const flush = onViewerReadyForRunnerSignal(true);

        expect(flush).toEqual({
            pendingConnectedSignal: false,
            forwardNow: true,
        });

        await forwardRecoveryConnectedSignal("sess-pending", {
            markPendingRecovery: mock((sessionId: string) => {
                calls.push(`mark:${sessionId}`);
                return "nonce-1";
            }),
            emitToRelaySessionChecked: mock(async (sessionId: string, event: string) => {
                calls.push(`emit:${event}:${sessionId}`);
                return "delivered";
            }) as any,
        });

        expect(calls).toEqual([
            "mark:sess-pending",
            "emit:connected:sess-pending",
        ]);
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
        const calls: unknown[][] = [];
        const socket = { emit: (...args: unknown[]) => { calls.push(args); return true; } } as any;

        const sent = sendCachedDeltaReplayEvents(socket, [
            { seq: 11, event: { type: "message_start" } },
            { seq: 12, event: { type: "message_end" } },
        ], 7);

        expect(sent).toBe(true);
        expect(calls.length).toBe(2);
        expect(calls[0][0]).toBe("event");
        expect(calls[0][1]).toEqual({
            event: { type: "message_start" },
            seq: 11,
            replay: true,
            deltaReplay: true,
            generation: 7,
        });
        expect(calls[1][1]).toEqual({
            event: { type: "message_end" },
            seq: 12,
            replay: true,
            deltaReplay: true,
            generation: 7,
        });
    });

    test("returns false when there are no sequenced events to replay", () => {
        const calls: unknown[][] = [];
        const sent = sendCachedDeltaReplayEvents({ emit: (...args: unknown[]) => { calls.push(args); return true; } } as any, [{ event: { type: "message_start" } }]);

        expect(sent).toBe(false);
        expect(calls.length).toBe(0);
    });
});

// ── service_message guard helpers ───────────────────────────────────────────

describe("checkServiceMessageSize", () => {
    test("allows small serializable envelopes", () => {
        const envelope = { serviceId: "svc", type: "ping", payload: { x: 1 } };
        const result = checkServiceMessageSize(envelope as any);
        expect(result.ok).toBe(true);
        expect(result.bytes).toBeGreaterThan(0);
    });

    test("rejects oversized payloads", () => {
        const envelope = { serviceId: "svc", type: "big", payload: "x".repeat(300 * 1024) };
        const result = checkServiceMessageSize(envelope as any);
        expect(result.ok).toBe(false);
        expect(result.bytes).toBeGreaterThan(256 * 1024);
    });

    test("rejects non-serializable payloads", () => {
        const payload: any = {};
        payload.self = payload;
        const envelope = { serviceId: "svc", type: "cyclic", payload };
        const result = checkServiceMessageSize(envelope as any);
        expect(result.ok).toBe(false);
    });
});

describe("checkServiceMessageRateLimit", () => {
    test("allows messages up to the per-window limit", () => {
        const state = { count: 0, resetAt: 0 };
        for (let i = 0; i < 50; i++) {
            expect(checkServiceMessageRateLimit(1000, state).allowed).toBe(true);
        }
        expect(checkServiceMessageRateLimit(1000, state).allowed).toBe(false);
    });

    test("resets the counter after the window expires", () => {
        const state = { count: 50, resetAt: 2000 };
        const result = checkServiceMessageRateLimit(2000, state);
        expect(result.allowed).toBe(true);
        expect(state.count).toBe(1);
    });
});

describe("runnerLooksLive", () => {
    test("live: isActive with a fresh heartbeat", () => {
        expect(runnerLooksLive({ isActive: true, lastHeartbeatAt: new Date().toISOString() })).toBe(true);
    });

    test("not live: heartbeat older than the stale threshold despite isActive", () => {
        const stale = new Date(Date.now() - 5 * 60_000).toISOString();
        expect(runnerLooksLive({ isActive: true, lastHeartbeatAt: stale })).toBe(false);
    });

    test("not live: isActive false, missing or malformed heartbeat", () => {
        expect(runnerLooksLive({ isActive: false, lastHeartbeatAt: new Date().toISOString() })).toBe(false);
        expect(runnerLooksLive({ isActive: true, lastHeartbeatAt: null })).toBe(false);
        expect(runnerLooksLive({ isActive: true, lastHeartbeatAt: "not-a-date" })).toBe(false);
    });
});
