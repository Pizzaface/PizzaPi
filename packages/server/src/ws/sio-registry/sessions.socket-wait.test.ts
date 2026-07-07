// ============================================================================
// sessions.socket-wait.test.ts — waitForTuiSocket event-driven readiness
//
// Imports directly from tui-socket-waiters.ts — a tiny zero-dependency module.
// No mocking needed: the functions are pure Map operations with no I/O.
// ============================================================================

import { beforeEach, describe, expect, test } from "bun:test";
import {
    waitForTuiSocket,
    notifyTuiSocketConnected,
    _resetTuiSocketWaitersForTesting,
} from "./tui-socket-waiters.js";

function lookup(sockets: Record<string, { connected: boolean }>) {
    return (sessionId: string) => sockets[sessionId];
}

describe("waitForTuiSocket", () => {
    beforeEach(() => {
        _resetTuiSocketWaitersForTesting();
    });

    test("resolves true immediately when the socket is already connected", async () => {
        const get = lookup({ s1: { connected: true } });
        expect(await waitForTuiSocket("s1", 1000, get)).toBe(true);
    });

    test("resolves false after timeout when no socket registers", async () => {
        const start = Date.now();
        expect(await waitForTuiSocket("missing", 30, lookup({}))).toBe(false);
        expect(Date.now() - start).toBeGreaterThanOrEqual(25);
    });

    test("resolves true as soon as the socket registers", async () => {
        const promise = waitForTuiSocket("s2", 5000, lookup({}));
        notifyTuiSocketConnected("s2");
        const start = Date.now();
        expect(await promise).toBe(true);
        // Event-driven: resolves well before the 5s timeout
        expect(Date.now() - start).toBeLessThan(100);
    });

    test("multiple waiters for the same session all resolve", async () => {
        const a = waitForTuiSocket("s3", 5000, lookup({}));
        const b = waitForTuiSocket("s3", 5000, lookup({}));
        notifyTuiSocketConnected("s3");
        expect(await Promise.all([a, b])).toEqual([true, true]);
    });

    test("does not treat a disconnected socket as ready", async () => {
        const get = lookup({ s4: { connected: false } });
        expect(await waitForTuiSocket("s4", 30, get)).toBe(false);
    });
});
