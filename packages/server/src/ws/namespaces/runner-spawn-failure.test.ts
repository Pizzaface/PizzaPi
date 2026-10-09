import { describe, expect, test } from "bun:test";
import { buildChildSpawnFailureEvent, isAuthorizedChildSpawnFailure } from "./runner-spawn-failure";

describe("isAuthorizedChildSpawnFailure", () => {
    const base = {
        runnerId: "runner-a",
        runnerUserId: "user-a",
        parentSessionId: "parent-1",
    };

    test("allows an established child whose Redis record matches runner + parent", () => {
        expect(isAuthorizedChildSpawnFailure({
            ...base,
            parentSession: { userId: "user-a" },
            childSession: { runnerId: "runner-a", parentSessionId: "parent-1" },
            pendingSpawn: undefined,
        })).toBe(true);
    });

    test("allows a pending (not-yet-registered) spawn whose recorded binding matches", () => {
        expect(isAuthorizedChildSpawnFailure({
            ...base,
            parentSession: { userId: "user-a" },
            childSession: null,
            pendingSpawn: { runnerId: "runner-a", parentSessionId: "parent-1" },
        })).toBe(true);
    });

    test("denies a cross-user parent: a runner cannot report a failure against a session owned by a different user", () => {
        expect(isAuthorizedChildSpawnFailure({
            ...base,
            parentSession: { userId: "user-B-victim" },
            childSession: { runnerId: "runner-a", parentSessionId: "parent-1" },
            pendingSpawn: undefined,
        })).toBe(false);
        expect(isAuthorizedChildSpawnFailure({
            ...base,
            parentSession: { userId: "user-B-victim" },
            childSession: null,
            pendingSpawn: { runnerId: "runner-a", parentSessionId: "parent-1" },
        })).toBe(false);
    });

    test("denies when the parent session does not exist", () => {
        expect(isAuthorizedChildSpawnFailure({
            ...base,
            parentSession: null,
            childSession: { runnerId: "runner-a", parentSessionId: "parent-1" },
            pendingSpawn: undefined,
        })).toBe(false);
    });

    test("denies a wrong-runner established child: the session is assigned to a different runner", () => {
        expect(isAuthorizedChildSpawnFailure({
            ...base,
            parentSession: { userId: "user-a" },
            childSession: { runnerId: "runner-OTHER", parentSessionId: "parent-1" },
            pendingSpawn: undefined,
        })).toBe(false);
    });

    test("denies a wrong-runner pending spawn: this runner never requested that sessionId", () => {
        expect(isAuthorizedChildSpawnFailure({
            ...base,
            parentSession: { userId: "user-a" },
            childSession: null,
            pendingSpawn: { runnerId: "runner-OTHER", parentSessionId: "parent-1" },
        })).toBe(false);
    });

    test("denies a mismatched parent-child relationship: real parent differs from the one being reported", () => {
        expect(isAuthorizedChildSpawnFailure({
            ...base,
            parentSession: { userId: "user-a" },
            childSession: { runnerId: "runner-a", parentSessionId: "actually-a-different-session" },
            pendingSpawn: undefined,
        })).toBe(false);
        expect(isAuthorizedChildSpawnFailure({
            ...base,
            parentSession: { userId: "user-a" },
            childSession: null,
            pendingSpawn: { runnerId: "runner-a", parentSessionId: "actually-a-different-session" },
        })).toBe(false);
    });

    test("falls back to linkedParentId when parentSessionId was cleared on the child", () => {
        expect(isAuthorizedChildSpawnFailure({
            ...base,
            parentSession: { userId: "user-a" },
            childSession: { runnerId: "runner-a", parentSessionId: null, linkedParentId: "parent-1" },
            pendingSpawn: undefined,
        })).toBe(true);
    });

    test("denies when there is no pending-spawn record and the child never registered", () => {
        expect(isAuthorizedChildSpawnFailure({
            ...base,
            parentSession: { userId: "user-a" },
            childSession: null,
            pendingSpawn: undefined,
        })).toBe(false);
    });

    test("denies when the reporting socket has no authenticated userId", () => {
        expect(isAuthorizedChildSpawnFailure({
            ...base,
            runnerUserId: undefined,
            parentSession: { userId: "user-a" },
            childSession: { runnerId: "runner-a", parentSessionId: "parent-1" },
            pendingSpawn: undefined,
        })).toBe(false);
    });
});

describe("runner spawn failure event", () => {
    test("builds a typed session_complete failure for the parent", () => {
        const event = buildChildSpawnFailureEvent({
            sessionId: "child-1",
            parentSessionId: "parent-1",
            failure: { kind: "auth", detail: "unauthorized", exitCode: 1 },
        });

        expect(event.type).toBe("lifecycle:session_complete");
        expect(event.fireId).toBe("spawn-failure:child-1");
        expect(event.responseContract?.actions).toEqual(["ack", "followUp"]);
        expect(event.payload).toMatchObject({
            exitReason: "error",
            exitCode: 1,
            failure: { kind: "auth", detail: "unauthorized", exitCode: 1 },
        });
    });
});
