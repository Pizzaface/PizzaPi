import { describe, expect, test } from "bun:test";

async function waitFor(predicate: () => void): Promise<void> {
    const started = Date.now();
    let last: unknown;
    while (Date.now() - started < 1_000) {
        try {
            predicate();
            return;
        } catch (err) {
            last = err;
            await new Promise((resolve) => setTimeout(resolve, 10));
        }
    }
    throw last;
}

import {
    createRedisAdapterRecoveryController,
    isRedisAdapterRecoverySocket,
    recoverLiveSocketsAfterRedisReconnect,
} from "./redis-adapter-recovery.js";

function fakeSocket(conn: { closed: number; close: (discard?: boolean) => void }, sessionId?: string) {
    return {
        connected: true,
        conn,
        data: sessionId ? { sessionId } : {},
        disconnect() {
            throw new Error("must not call socket.disconnect()");
        },
    };
}

function fakeIo(relaySockets: unknown[], runnerSockets: unknown[], viewerSockets: unknown[] = []) {
    const nsps = new Map([
        ["/relay", { name: "/relay", sockets: new Map(relaySockets.map((socket, index) => [`/relay-${index}`, socket])) }],
        ["/runner", { name: "/runner", sockets: new Map(runnerSockets.map((socket, index) => [`/runner-${index}`, socket])) }],
        ["/viewer", { name: "/viewer", sockets: new Map(viewerSockets.map((socket, index) => [`/viewer-${index}`, socket])) }],
    ]);
    return {
        _nsps: nsps,
        of(name: string) {
            return nsps.get(name) ?? { sockets: new Map() };
        },
    };
}

describe("Redis adapter recovery", () => {
    test("does not recover on initial or duplicate ready", () => {
        const recoveries: string[] = [];
        const controller = createRedisAdapterRecoveryController({
            initialPubReady: false,
            initialSubReady: false,
            recover: (reason) => recoveries.push(reason),
        });

        controller.redisReady("pub");
        controller.redisReady("sub");
        controller.redisReady("pub");
        controller.redisReady("sub");

        expect(recoveries).toEqual([]);
    });

    test("recovers once per real Redis outage", () => {
        const recoveries: string[] = [];
        const controller = createRedisAdapterRecoveryController({
            initialPubReady: true,
            initialSubReady: true,
            recover: (reason) => recoveries.push(reason),
        });

        controller.redisDegraded("pub");
        controller.redisDegraded("sub");
        controller.redisReady("pub");
        expect(recoveries).toEqual([]);

        controller.redisReady("sub");
        expect(recoveries).toEqual(["redis-adapter-reconnected"]);

        controller.redisReady("pub");
        controller.redisReady("sub");
        expect(recoveries).toEqual(["redis-adapter-reconnected"]);
    });

    test("closes transports, not sockets, and marks disconnects as recovery", async () => {
        const sharedConn = {
            closed: 0,
            close(discard?: boolean) {
                expect(discard).toBe(true);
                this.closed++;
            },
        };
        const runnerConn = {
            closed: 0,
            close(discard?: boolean) {
                expect(discard).toBe(true);
                this.closed++;
            },
        };
        const relaySocket = fakeSocket(sharedConn);
        const duplicateNamespaceSocket = fakeSocket(sharedConn);
        const runnerSocket = fakeSocket(runnerConn);
        const viewerConn = {
            closed: 0,
            close(discard?: boolean) {
                expect(discard).toBe(true);
                this.closed++;
            },
        };
        const viewerSocket = fakeSocket(viewerConn);

        const closed = recoverLiveSocketsAfterRedisReconnect(
            fakeIo([relaySocket, duplicateNamespaceSocket], [runnerSocket], [viewerSocket]) as any,
            "test",
        );

        expect(closed).toBe(3);
        expect(sharedConn.closed).toBe(1);
        expect(runnerConn.closed).toBe(1);
        await waitFor(() => expect(viewerConn.closed).toBe(1));
        expect(isRedisAdapterRecoverySocket(relaySocket)).toBe(true);
        expect(isRedisAdapterRecoverySocket(duplicateNamespaceSocket)).toBe(true);
        expect(isRedisAdapterRecoverySocket(runnerSocket)).toBe(true);
        expect(isRedisAdapterRecoverySocket(viewerSocket)).toBe(true);
        expect((relaySocket as { data?: Record<string, unknown> }).data).toEqual({});
    });

    test("recovers each viewer session independently — a slow session does not hold up a ready one", async () => {
        // Regression test: the recovery used to wait for ALL watched sessions'
        // workers to come back (or a single shared timeout to elapse) before
        // closing ANY viewer transport. That meant one session whose worker
        // never came back held up recovery for every other viewer, and a
        // worker that re-registered after the shared timeout fired got no
        // benefit from it. Each session must now be recovered on its own
        // clock: as soon as ITS worker re-registers (or ITS OWN timeout
        // elapses), ITS viewers close — independent of every other session.
        const closedOrder: string[] = [];
        function makeConn(name: string) {
            const conn = { closed: 0, close(discard?: boolean) {
                expect(discard).toBe(true);
                conn.closed++;
                closedOrder.push(name);
            } };
            return conn;
        }

        const readyConn = makeConn("ready");
        const readySocket = fakeSocket(readyConn, "session-ready");
        const slowConn = makeConn("slow");
        const slowSocket = fakeSocket(slowConn, "session-slow");

        const waitCalls: string[] = [];
        const closed = recoverLiveSocketsAfterRedisReconnect(fakeIo([], [], [readySocket, slowSocket]) as any, "test", {
            viewerFallbackMs: 10_000, // large on purpose — a buggy global wait would stall both this long
            waitForSession: async (sessionId) => {
                waitCalls.push(sessionId);
                if (sessionId === "session-ready") return true; // worker already back — resolves immediately
                // "session-slow"'s worker takes a bit longer to re-register.
                await new Promise((resolve) => setTimeout(resolve, 50));
                return false;
            },
        });

        expect(closed).toBe(2);
        // The ready session's viewer must close well before the slow
        // session's — each session recovers on its own clock, not a shared
        // one gated by the slowest session in the batch.
        await waitFor(() => expect(readyConn.closed).toBe(1));
        expect(slowConn.closed).toBe(0);
        await waitFor(() => expect(slowConn.closed).toBe(1));
        expect(closedOrder).toEqual(["ready", "slow"]);
        expect(waitCalls.sort()).toEqual(["session-ready", "session-slow"]);
    });
});
