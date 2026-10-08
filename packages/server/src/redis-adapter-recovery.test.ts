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
    unmarkRedisAdapterRecoverySocket,
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

function fakeIo(
    relaySockets: unknown[],
    runnerSockets: unknown[],
    viewerSockets: unknown[] = [],
    extraNamespaces: Record<string, unknown[]> = {},
) {
    const nsps = new Map<string, { name: string; sockets: Map<string, unknown> }>([
        ["/relay", { name: "/relay", sockets: new Map(relaySockets.map((socket, index) => [`/relay-${index}`, socket])) }],
        ["/runner", { name: "/runner", sockets: new Map(runnerSockets.map((socket, index) => [`/runner-${index}`, socket])) }],
        ["/viewer", { name: "/viewer", sockets: new Map(viewerSockets.map((socket, index) => [`/viewer-${index}`, socket])) }],
    ]);
    for (const [name, sockets] of Object.entries(extraNamespaces)) {
        nsps.set(name, { name, sockets: new Map(sockets.map((socket, index) => [`${name}-${index}`, socket])) });
    }
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

    test("passes the recovery abort signal into per-session viewer waits", async () => {
        const controller = new AbortController();
        const viewerConn = {
            closed: 0,
            close(discard?: boolean) {
                expect(discard).toBe(true);
                this.closed++;
            },
        };
        const viewerSocket = fakeSocket(viewerConn, "session-a");
        let receivedSignal: AbortSignal | undefined;

        recoverLiveSocketsAfterRedisReconnect(fakeIo([], [], [viewerSocket]) as any, "test", {
            signal: controller.signal,
            waitForSession: async (_sessionId, _timeoutMs, signal) => {
                receivedSignal = signal;
                await new Promise((resolve) => signal?.addEventListener("abort", resolve, { once: true }));
                return false;
            },
        });

        await waitFor(() => expect(receivedSignal).toBe(controller.signal));
        controller.abort();
        await new Promise((resolve) => setTimeout(resolve, 0));
        expect(viewerConn.closed).toBe(0);
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

    test("a /hub socket multiplexed on the same transport as a /viewer socket is not dropped before the viewer's session recovers", async () => {
        // Regression (P1): the web UI opens /hub and /viewer on the SAME
        // Engine.IO transport (one Manager, no forceNew). Grouping by
        // sessionId used to put the sessionId-less /hub socket in its own
        // group and close it — and its transport — immediately, which also
        // yanks the co-located /viewer socket out from under its still-
        // recovering session. Grouping by transport must keep them together
        // and wait for the viewer's session before closing either.
        const sharedConn = {
            closed: 0,
            close(discard?: boolean) {
                expect(discard).toBe(true);
                this.closed++;
            },
        };
        const hubSocket = fakeSocket(sharedConn); // no sessionId, like /hub
        const viewerSocket = fakeSocket(sharedConn, "session-a");

        let resolveWait: (() => void) | undefined;
        const waitForSession = () =>
            new Promise<boolean>((resolve) => {
                resolveWait = () => resolve(true);
            });

        const closed = recoverLiveSocketsAfterRedisReconnect(
            fakeIo([], [], [], { "/hub": [hubSocket], "/viewer": [viewerSocket] }) as any,
            "test",
            { waitForSession },
        );

        expect(closed).toBe(1);
        // The shared transport must not close while the viewer's session is
        // still being waited on — closing it early would disconnect BOTH the
        // hub and the viewer socket before the worker re-registers.
        await new Promise((resolve) => setTimeout(resolve, 20));
        expect(sharedConn.closed).toBe(0);

        resolveWait!();
        await waitFor(() => expect(sharedConn.closed).toBe(1));
    });

    test("unmarks a socket as recovery-pending when it has no closeable transport", () => {
        // P3: if the mark is not undone, this socket's EVENTUAL real
        // disconnect would be mistaken for a forced-reconnect-in-progress and
        // skip normal teardown.
        const noConnSocket = fakeSocket(undefined as any);
        delete (noConnSocket as any).conn;

        recoverLiveSocketsAfterRedisReconnect(fakeIo([], [], [noConnSocket]) as any, "test");

        expect(isRedisAdapterRecoverySocket(noConnSocket)).toBe(false);
    });

    test("unmarks a socket as recovery-pending when conn.close() throws", () => {
        const throwingConn = {
            closed: 0,
            close() {
                throw new Error("boom");
            },
        };
        const socket = fakeSocket(throwingConn as any);

        recoverLiveSocketsAfterRedisReconnect(fakeIo([socket], [], []) as any, "test");

        expect(isRedisAdapterRecoverySocket(socket)).toBe(false);
    });

    test("unmarks EVERY socket sharing a conn when conn.close() throws, not just the one that triggered it", () => {
        // P3: before this fix, only the socket that initiated the throwing
        // close() call was unmarked. A single Engine.IO conn can carry
        // multiple namespace sockets (e.g. the runner daemon's relay socket
        // and its runner socket share one transport); the others were
        // already recorded in seenConnections and would `continue` past
        // unmarked, staying marked-as-recovery-pending indefinitely — their
        // later real disconnect would then be skipped as "recovery in
        // progress", leaking teardown.
        const throwingConn = {
            closed: 0,
            close() {
                throw new Error("boom");
            },
        };
        const relaySocket = fakeSocket(throwingConn as any, "session-1");
        const runnerSocket = fakeSocket(throwingConn as any);

        recoverLiveSocketsAfterRedisReconnect(fakeIo([relaySocket], [runnerSocket], []) as any, "test");

        expect(isRedisAdapterRecoverySocket(relaySocket)).toBe(false);
        expect(isRedisAdapterRecoverySocket(runnerSocket)).toBe(false);
    });

    test("unmarkRedisAdapterRecoverySocket is idempotent for a socket never marked", () => {
        const plain = {};
        expect(() => unmarkRedisAdapterRecoverySocket(plain)).not.toThrow();
        expect(isRedisAdapterRecoverySocket(plain)).toBe(false);
    });
});
