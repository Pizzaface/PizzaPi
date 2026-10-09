import { describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import {
    MAX_PENDING_REQUESTS,
    cancelRunnerFileRead,
    forwardServiceMessageToSession,
    isPendingRequestCapReached,
    pendingSocketMatches,
    serviceResponseMatches,
    recordRequestScope,
    takeRequestScope,
    isScopeRecoverableServiceId,
    recoverServiceMessageScope,
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

    test("service responses require runner, user, service, type, and socket binding", () => {
        const pending = { socketId: "socket-a", runnerId: "runner-a", userId: "user-a", serviceId: "time", responseType: "time_status_result" };
        expect(serviceResponseMatches(pending, { ...pending, type: "time_status_result" })).toBe(true);
        for (const change of [
            { socketId: "socket-b" }, { runnerId: "runner-b" }, { userId: "user-b" },
            { serviceId: "other" }, { type: "other_result" },
        ]) expect(serviceResponseMatches(pending, { ...pending, type: "time_status_result", ...change })).toBe(false);
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

describe("recoverServiceMessageScope (unscoped service_message echoes)", () => {
    test("file-explorer: recovers the session recorded for the original request", async () => {
        const requestId = randomUUID();
        recordRequestScope(requestId, "sess-a");

        const scope = await recoverServiceMessageScope(
            { serviceId: "file-explorer", payload: { requestId, ok: true, files: [] } },
            { takeRequestScope, getTerminalSessionId: async () => undefined },
        );

        expect(scope).toEqual({ sessionId: "sess-a", broadcastToAll: false });
    });

    test("file-explorer: an OLD runner that never echoes sessionId is still scoped (not broadcast)", async () => {
        // Simulates an old runner binary: the echo envelope has no top-level
        // sessionId at all (as if the field didn't exist), but the server
        // still recorded the scope itself when it forwarded the request.
        const requestId = randomUUID();
        recordRequestScope(requestId, "sess-b");

        const scope = await recoverServiceMessageScope(
            { serviceId: "file-explorer", payload: { requestId, ok: true, directories: [] } },
            { takeRequestScope, getTerminalSessionId: async () => undefined },
        );

        expect(scope.broadcastToAll).toBe(false);
        expect(scope.sessionId).toBe("sess-b");
    });

    test("file-explorer: unrecoverable scope (unknown/expired requestId) is suppressed, never broadcast", async () => {
        const scope = await recoverServiceMessageScope(
            { serviceId: "file-explorer", payload: { requestId: randomUUID(), ok: true, files: [] } },
            { takeRequestScope, getTerminalSessionId: async () => undefined },
        );

        // This is the regression this test pins: before the fix, a missing
        // sessionId on the envelope fell through to "broadcast to every
        // session on the runner". Now it must be dropped instead.
        expect(scope.broadcastToAll).toBe(false);
        expect(scope.sessionId).toBeUndefined();
    });

    test("file-explorer: a request that was explicitly unscoped (no sessionId) stays suppressed", async () => {
        const requestId = randomUUID();
        recordRequestScope(requestId, undefined);

        const scope = await recoverServiceMessageScope(
            { serviceId: "file-explorer", payload: { requestId, ok: true, files: [] } },
            { takeRequestScope, getTerminalSessionId: async () => undefined },
        );

        expect(scope).toEqual({ sessionId: undefined, broadcastToAll: false });
    });

    test("terminal: recovers the session from the stored terminal entry by terminalId", async () => {
        const scope = await recoverServiceMessageScope(
            { serviceId: "terminal", payload: { terminalId: "term-1", exitCode: 0 } },
            {
                takeRequestScope,
                getTerminalSessionId: async (terminalId) => (terminalId === "term-1" ? "sess-c" : undefined),
            },
        );

        expect(scope).toEqual({ sessionId: "sess-c", broadcastToAll: false });
    });

    test("terminal: unknown terminalId is suppressed, never broadcast to every session", async () => {
        const scope = await recoverServiceMessageScope(
            { serviceId: "terminal", payload: { terminalId: "ghost-terminal" } },
            { takeRequestScope, getTerminalSessionId: async () => undefined },
        );

        expect(scope.broadcastToAll).toBe(false);
        expect(scope.sessionId).toBeUndefined();
    });

    test("non-scopable services (e.g. tunnel announcements) keep the runner-wide broadcast", async () => {
        const scope = await recoverServiceMessageScope(
            { serviceId: "tunnel", payload: {} },
            { takeRequestScope, getTerminalSessionId: async () => undefined },
        );

        expect(scope).toEqual({ broadcastToAll: true });
    });

    test("isScopeRecoverableServiceId matches only the services that must never fan out", () => {
        expect(isScopeRecoverableServiceId("file-explorer")).toBe(true);
        expect(isScopeRecoverableServiceId("terminal")).toBe(true);
        expect(isScopeRecoverableServiceId("tunnel")).toBe(false);
    });
});

describe("recordRequestScope / takeRequestScope", () => {
    test("round-trips the sessionId recorded for a requestId", () => {
        const requestId = randomUUID();
        recordRequestScope(requestId, "sess-x");
        expect(takeRequestScope(requestId)).toEqual({ sessionId: "sess-x" });
    });

    test("is single-use: a second take sees nothing", () => {
        const requestId = randomUUID();
        recordRequestScope(requestId, "sess-y");
        takeRequestScope(requestId);
        expect(takeRequestScope(requestId)).toBeUndefined();
    });

    test("an unrecorded requestId has no scope", () => {
        expect(takeRequestScope(randomUUID())).toBeUndefined();
    });
});
