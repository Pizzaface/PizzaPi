// ============================================================================
// local-socket-accessors.zombie.test.ts
//
// Accessor-layer regression test for GM oRG618iQ / PR #949 round 3: three
// review rounds each found one more call site where an early return left a
// dead socket pinned in a local socket map (localTuiSockets / localRunnerSockets).
// Rather than patch every call site, getLocalTuiSocket and getLocalRunnerSocket
// themselves must treat `.connected !== true` as absent, and lazily clear the
// stale entry (only if it's still the same socket — a replacement that has
// already re-registered must never be disturbed).
//
// Pure Map-based tests: no Redis, no Socket.IO server, no mock.module.
// ============================================================================

import { beforeEach, describe, expect, test } from "bun:test";
import { localTuiSockets, localRunnerSockets } from "./context.js";
import { getLocalTuiSocket, forgetLocalTuiSocketIfCurrent } from "./sessions.js";
import { getLocalRunnerSocket, forgetLocalRunnerSocketIfCurrent } from "./runners.js";

function fakeSocket(connected: boolean): any {
    return { id: Math.random().toString(36), connected };
}

describe("getLocalTuiSocket treats a disconnected map entry as absent", () => {
    beforeEach(() => localTuiSockets.clear());

    test("returns the socket when connected", () => {
        const sock = fakeSocket(true);
        localTuiSockets.set("s1", sock);
        expect(getLocalTuiSocket("s1")).toBe(sock);
    });

    test("returns undefined for a disconnected socket, and clears the stale entry", () => {
        const sock = fakeSocket(false);
        localTuiSockets.set("s1", sock);
        expect(getLocalTuiSocket("s1")).toBeUndefined();
        expect(localTuiSockets.has("s1")).toBe(false);
    });

    test("does not clear a replacement socket that has already re-registered", () => {
        const dead = fakeSocket(false);
        localTuiSockets.set("s1", dead);
        // A fresh socket re-registers between the dead one's disconnect and
        // this read — forgetLocalTuiSocketIfCurrent-style deletes must never
        // nuke it.
        const live = fakeSocket(true);
        localTuiSockets.set("s1", live);
        expect(getLocalTuiSocket("s1")).toBe(live);
        expect(localTuiSockets.get("s1")).toBe(live);
    });

    test("returns undefined when nothing is registered", () => {
        expect(getLocalTuiSocket("missing")).toBeUndefined();
    });

    test("forgetLocalTuiSocketIfCurrent is a no-op against a different current value", () => {
        const dead = fakeSocket(false);
        const live = fakeSocket(true);
        localTuiSockets.set("s1", live);
        forgetLocalTuiSocketIfCurrent("s1", dead);
        expect(localTuiSockets.get("s1")).toBe(live);
    });
});

describe("getLocalRunnerSocket treats a disconnected map entry as absent", () => {
    beforeEach(() => localRunnerSockets.clear());

    test("returns the socket when connected", () => {
        const sock = fakeSocket(true);
        localRunnerSockets.set("r1", sock);
        expect(getLocalRunnerSocket("r1")).toBe(sock);
    });

    test("returns undefined for a disconnected socket, and clears the stale entry", () => {
        const sock = fakeSocket(false);
        localRunnerSockets.set("r1", sock);
        expect(getLocalRunnerSocket("r1")).toBeUndefined();
        expect(localRunnerSockets.has("r1")).toBe(false);
    });

    test("does not clear a replacement socket that has already re-registered", () => {
        const dead = fakeSocket(false);
        localRunnerSockets.set("r1", dead);
        const live = fakeSocket(true);
        localRunnerSockets.set("r1", live);
        expect(getLocalRunnerSocket("r1")).toBe(live);
        expect(localRunnerSockets.get("r1")).toBe(live);
    });

    test("forgetLocalRunnerSocketIfCurrent is a no-op against a different current value", () => {
        const dead = fakeSocket(false);
        const live = fakeSocket(true);
        localRunnerSockets.set("r1", live);
        forgetLocalRunnerSocketIfCurrent("r1", dead);
        expect(localRunnerSockets.get("r1")).toBe(live);
    });
});
