// ============================================================================
// sessions.socket-wait.test.ts — waitForLocalTuiSocket event-driven readiness
// ============================================================================

import { afterEach, describe, expect, test } from "bun:test";
import type { Socket } from "socket.io";
import { waitForLocalTuiSocket, notifyTuiSocketConnected } from "./sessions.js";
import { localTuiSockets } from "./context.js";

function fakeSocket(connected = true): Socket {
    return { connected, data: {} } as unknown as Socket;
}

describe("waitForLocalTuiSocket", () => {
    afterEach(() => {
        localTuiSockets.clear();
    });

    test("resolves true immediately when the socket is already connected", async () => {
        localTuiSockets.set("s1", fakeSocket());
        expect(await waitForLocalTuiSocket("s1", 1000)).toBe(true);
    });

    test("resolves false after timeout when no socket registers", async () => {
        const start = Date.now();
        expect(await waitForLocalTuiSocket("missing", 30)).toBe(false);
        expect(Date.now() - start).toBeGreaterThanOrEqual(25);
    });

    test("resolves true as soon as the socket registers", async () => {
        const promise = waitForLocalTuiSocket("s2", 5000);
        localTuiSockets.set("s2", fakeSocket());
        notifyTuiSocketConnected("s2");
        const start = Date.now();
        expect(await promise).toBe(true);
        // Event-driven: resolves well before the 5s timeout
        expect(Date.now() - start).toBeLessThan(100);
    });

    test("multiple waiters for the same session all resolve", async () => {
        const a = waitForLocalTuiSocket("s3", 5000);
        const b = waitForLocalTuiSocket("s3", 5000);
        localTuiSockets.set("s3", fakeSocket());
        notifyTuiSocketConnected("s3");
        expect(await Promise.all([a, b])).toEqual([true, true]);
    });

    test("does not treat a disconnected socket as ready", async () => {
        localTuiSockets.set("s4", fakeSocket(false));
        expect(await waitForLocalTuiSocket("s4", 30)).toBe(false);
    });
});
