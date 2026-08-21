import { describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import {
    MAX_PENDING_REQUESTS,
    cancelRunnerFileRead,
    forwardServiceMessageToSession,
    isPendingRequestCapReached,
    pendingSocketMatches,
} from "./runner.js";

// NOTE: These tests deliberately import ONLY the pure helpers and do NOT use
// mock.module. Earlier this file mocked auth/sio-registry/runner-control etc.,
// which — because bun's mock.module is a process-global singleton — clobbered
// those modules for every other test file in the same run (see TODO(ltl2EKmU)),
// breaking runners.broadcast/terminals suites. Testing the extracted predicates
// covers the same security-relevant behaviour with zero cross-file bleed.

describe("runner namespace pending-request hardening", () => {
    test("request IDs are crypto-random UUID v4", () => {
        // sendSkillCommand/sendAgentCommand/sendRunnerCommand all use randomUUID().
        for (let i = 0; i < 5; i++) {
            expect(randomUUID()).toMatch(
                /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i,
            );
        }
    });

    test("a response only resolves when it arrives on the SAME socket", () => {
        const pending = { socketId: "socket-a" };
        // Same socket → resolves.
        expect(pendingSocketMatches(pending, "socket-a")).toBe(true);
        // Different socket (guessed/duplicate requestId from another runner conn)
        // → must NOT resolve.
        expect(pendingSocketMatches(pending, "socket-b")).toBe(false);
    });

    test("missing pending entry never matches", () => {
        expect(pendingSocketMatches(undefined, "socket-a")).toBe(false);
    });

    test("pending map rejects new entries once at capacity", () => {
        expect(isPendingRequestCapReached(MAX_PENDING_REQUESTS - 1)).toBe(false);
        expect(isPendingRequestCapReached(MAX_PENDING_REQUESTS)).toBe(true);
        expect(isPendingRequestCapReached(MAX_PENDING_REQUESTS + 1)).toBe(true);
    });

    test("read cancellation emits the correlated runner event", () => {
        const emitted: Array<[string, unknown]> = [];
        const socket = { emit: (event: string, data: unknown) => emitted.push([event, data]) };

        cancelRunnerFileRead(socket as any, "read_file", "read-1");
        cancelRunnerFileRead(socket as any, "list_files", "list-1");

        expect(emitted).toEqual([["cancel_file_request", { requestId: "read-1" }]]);
    });
});

describe("forwardServiceMessageToSession", () => {
    test("targeted envelope is cloned and stamped with the destination sessionId", () => {
        const envelope = { serviceId: "svc", type: "x", payload: { foo: 1 } };
        const target = "sess-target";
        const broadcasts: Array<unknown> = [];
        const relays: Array<unknown> = [];

        forwardServiceMessageToSession(
            envelope,
            target,
            (_sid, _event, data) => broadcasts.push(data),
            (_sid, _event, data) => relays.push(data),
        );

        expect(broadcasts).toHaveLength(1);
        expect(relays).toHaveLength(1);
        expect(broadcasts[0]).toEqual({ ...envelope, sessionId: target });
        expect(relays[0]).toEqual({ ...envelope, sessionId: target });
        expect(broadcasts[0]).not.toBe(envelope);
        expect(relays[0]).not.toBe(envelope);
        // Original envelope must remain untouched.
        expect(envelope).toEqual({ serviceId: "svc", type: "x", payload: { foo: 1 } });
    });

    test("broadcast recipients each get a distinct envelope stamped with their own sessionId", () => {
        const envelope = { serviceId: "svc", type: "y", payload: { bar: 2 } };
        const sessions = ["sess-a", "sess-b"];
        const calls: Array<{ sessionId: string; kind: "broadcast" | "relay"; data: unknown }> = [];

        for (const sid of sessions) {
            forwardServiceMessageToSession(
                envelope,
                sid,
                (sessionId, _event, data) => calls.push({ sessionId, kind: "broadcast", data }),
                (sessionId, _event, data) => calls.push({ sessionId, kind: "relay", data }),
            );
        }

        expect(calls).toHaveLength(4);
        for (const sid of sessions) {
            const bc = calls.filter((c) => c.kind === "broadcast" && c.sessionId === sid);
            const rl = calls.filter((c) => c.kind === "relay" && c.sessionId === sid);
            expect(bc).toHaveLength(1);
            expect(rl).toHaveLength(1);
            expect(bc[0].data).toEqual({ ...envelope, sessionId: sid });
            expect(rl[0].data).toEqual({ ...envelope, sessionId: sid });
            expect(bc[0].data).not.toBe(envelope);
            expect(rl[0].data).not.toBe(envelope);
        }

        // No cross-stamping: the two broadcast envelopes are different objects.
        const bcA = calls.find((c) => c.kind === "broadcast" && c.sessionId === "sess-a")!.data;
        const bcB = calls.find((c) => c.kind === "broadcast" && c.sessionId === "sess-b")!.data;
        expect(bcA).not.toBe(bcB);
        expect((bcA as any).sessionId).not.toBe((bcB as any).sessionId);

        // Original envelope must remain untouched.
        expect(envelope).toEqual({ serviceId: "svc", type: "y", payload: { bar: 2 } });
    });
});
