// ============================================================================
// runner.register-retry.test.ts — PR #965 round 2 regression (P1)
//
// A transient Redis failure during a runner-secret claim must not
// permanently strand a legitimate runner. The register_runner handler used
// to reject EVERY registerRunner() Error the same way: emit "error" then
// socket.disconnect(true). Socket.IO sends an application-level DISCONNECT
// packet for that, which socket.io-client reports as reason "io server
// disconnect" — a reason it deliberately does NOT auto-reconnect from (see
// socket.io-client's Socket#ondisconnect). One Redis hiccup during an
// uncached registration would strand the runner until it was manually
// restarted, even after Redis recovered.
//
// The fix: registerRunner() now returns a RetryableRunnerRegistrationError
// for infra failures (vs. a plain Error for genuine auth rejections), and
// the handler closes the raw transport (socket.conn.close()) instead of
// calling socket.disconnect() for those — no namespace DISCONNECT packet is
// sent, so the client's existing bounded reconnection/backoff retries
// registration once Redis recovers, with zero daemon-side changes required.
//
// This drives the REAL /runner namespace register_runner handler
// (registerRunnerNamespace) with fake sockets via the "register_runner"
// EVENT (not calling registerRunner() directly — that's already covered at
// the registry level in runners.ownership.test.ts). Redis is fully mocked
// via dependency injection (initStateRedis + _injectRedisForTesting) — no
// mock.module, no real Redis, no cross-file bleed (see TODO(ltl2EKmU) and
// tests/fixtures/runner-owner-db.ts's own "process-global" warning, which is
// why this file does NOT use that fixture).
// ============================================================================

import { describe, it, expect, beforeAll, beforeEach } from "bun:test";
import { createTestAuthContext, runWithAuthContext } from "../../auth.js";
import { ensureRunnerOwnerTable } from "../../runner-owner.js";
import { _injectRedisForTesting } from "../../redis-kv-store.js";
import { initSioRegistry, localRunnerSockets, _resetRunnerSecretsForTesting } from "../sio-registry/context.js";
import { initStateRedis } from "../sio-state/index.js";
import { registerRunnerNamespace } from "./runner.js";

// ── In-memory Redis mock (same minimal harness as runner.stale-disconnect.test.ts) ──

const hashes = new Map<string, Record<string, string>>();
const strings = new Map<string, string>();
const sets = new Map<string, Set<string>>();

function hSetAll(key: string, fields: Record<string, string>): void {
    hashes.set(key, { ...(hashes.get(key)), ...fields });
}

function sAddAll(key: string, members: unknown[]): void {
    const s = sets.get(key) ?? new Set<string>();
    for (const m of members.flat()) s.add(String(m));
    sets.set(key, s);
}

function delKey(key: string): void {
    hashes.delete(key);
    strings.delete(key);
    sets.delete(key);
}

/** Mock covering both the sio-state client surface and the redis-kv surface. */
function makeMockRedis() {
    const multi = () => {
        const ops: Array<() => unknown> = [];
        const m: Record<string, (...args: any[]) => any> = {
            hSet: (key: string, fieldsOrField: unknown, value?: string) => {
                ops.push(() => {
                    if (typeof fieldsOrField === "string") hSetAll(key, { [fieldsOrField]: value ?? "" });
                    else hSetAll(key, fieldsOrField as Record<string, string>);
                    return 1;
                });
                return m;
            },
            hGetAll: (key: string) => {
                ops.push(() => ({ ...(hashes.get(key)) }));
                return m;
            },
            expire: () => {
                ops.push(() => 1);
                return m;
            },
            sAdd: (key: string, ...members: unknown[]) => {
                ops.push(() => { sAddAll(key, members); return 1; });
                return m;
            },
            del: (key: string) => {
                ops.push(() => { delKey(key); return 1; });
                return m;
            },
            exec: async () => ops.map((op) => op()),
        };
        return m;
    };

    // `set` is a plain mutable function property (not the frozen literal) so
    // individual tests can swap in a throwing version for the secret-claim
    // Redis key, then restore it.
    const client: Record<string, unknown> = {
        isOpen: true,
        on: () => client,
        connect: async () => {},
        multi,
        hGetAll: async (key: string) => ({ ...(hashes.get(key)) }),
        hSet: async (key: string, field: string, value: string) => { hSetAll(key, { [field]: value }); return 1; },
        exists: async (key: string) => (hashes.has(key) || strings.has(key) || sets.has(key) ? 1 : 0),
        sMembers: async (key: string) => Array.from(sets.get(key) ?? []),
        sAdd: async (key: string, ...members: unknown[]) => { sAddAll(key, members); return 1; },
        sRem: async () => 1,
        expire: async () => 1,
        set: async (key: string, value: string) => { strings.set(key, value); return "OK"; },
        get: async (key: string) => strings.get(key) ?? null,
        del: async (key: string) => { delKey(key); return 1; },
    };
    return client;
}

// ── Fake Socket.IO server / sockets ──────────────────────────────────────────

function createFakeIo() {
    let connectionHandler: ((socket: unknown) => void) | undefined;
    const nsCache = new Map<string, Record<string, unknown>>();

    const mkNs = (): Record<string, unknown> => {
        const ns: Record<string, unknown> = {
            emit: () => {},
            to: () => ({ emit: () => {} }),
            local: {
                emit: () => {},
                to: () => ({ emit: () => {} }),
            },
            use: () => {},
            on: (event: string, cb: (socket: unknown) => void) => {
                if (event === "connection") connectionHandler = cb;
            },
        };
        return ns;
    };

    return {
        io: {
            of: (name: string) => {
                if (!nsCache.has(name)) nsCache.set(name, mkNs());
                return nsCache.get(name);
            },
        },
        getConnectionHandler: () => connectionHandler,
    };
}

// ponytail: fake socket is `any` — the real Socket interface has 70+
// members; structural typing is pointless for a captured-handler harness.
function makeSocket(id: string): any {
    const handlers = new Map<string, (...args: any[]) => unknown>();
    const socket: any = {
        id,
        data: {} as Record<string, unknown>,
        connected: true,
        handshake: { address: "127.0.0.1", headers: {}, auth: {} },
        connCloseCalls: 0,
        disconnectCalls: [] as boolean[],
        emitted: [] as Array<[string, unknown]>,
        conn: {
            transport: { name: "websocket" },
            close() {
                socket.connCloseCalls++;
            },
        },
        join: async () => {},
        leave: async () => {},
        emit(event: string, data: unknown) {
            socket.emitted.push([event, data]);
        },
        disconnect(close?: boolean) {
            socket.disconnectCalls.push(close ?? false);
            return socket;
        },
        on(event: string, cb: (...args: any[]) => unknown) {
            handlers.set(event, cb);
            return socket;
        },
        once(event: string, cb: (...args: any[]) => unknown) {
            handlers.set(event, cb);
            return socket;
        },
        /** Fire a captured event handler, awaiting async listeners. */
        async fire(event: string, ...args: unknown[]) {
            const cb = handlers.get(event);
            if (!cb) throw new Error(`no '${event}' handler captured on socket ${id}`);
            await cb(...args);
        },
    };
    return socket;
}

const REGISTRATION = {
    name: "runner-one",
    roots: [] as string[],
    skills: [],
    agents: [],
    plugins: [],
    hooks: [],
    version: null,
    platform: null,
};

// Registration consults the durable runner_owner table (fail-closed), so run
// it inside a disposable in-memory auth context that has the table.
const authCtx = createTestAuthContext({ dbPath: ":memory:" });

describe("register_runner handler: retryable vs. fatal rejection (PR #965 round 2)", () => {
    beforeAll(async () => {
        await runWithAuthContext(authCtx, () => ensureRunnerOwnerTable());
    });

    beforeEach(() => {
        hashes.clear();
        strings.clear();
        sets.clear();
        localRunnerSockets.clear();
        _resetRunnerSecretsForTesting();
    });

    it("a Redis error during a NEW runner's first secret claim closes the raw transport — not a server-initiated disconnect", async () => {
        const { io, getConnectionHandler } = createFakeIo();
        initSioRegistry(io as never);
        const mockRedis = makeMockRedis();
        await initStateRedis(mockRedis as never);
        _injectRedisForTesting(mockRedis);

        const originalSet = mockRedis.set as (key: string, value: string) => Promise<string>;
        (mockRedis as Record<string, unknown>).set = async (key: string, value: string) => {
            if (key.startsWith("pizzapi:runner:secret:")) {
                throw new Error("ECONNRESET (simulated)");
            }
            return originalSet(key, value);
        };

        registerRunnerNamespace(io as never, authCtx);
        const connection = getConnectionHandler()!;

        const sock = makeSocket("sock-retryable");
        connection(sock);

        await runWithAuthContext(authCtx, () =>
            sock.fire("register_runner", {
                ...REGISTRATION,
                runnerId: "runner-retryable",
                runnerSecret: "secret-r",
            }),
        );

        // Rejected, but NOT via socket.disconnect() — that would send an
        // application-level DISCONNECT packet, which the client reports as
        // "io server disconnect" and refuses to auto-reconnect from.
        expect(sock.disconnectCalls).toEqual([]);
        expect(sock.connCloseCalls).toBe(1);

        const errorEmits = sock.emitted.filter(([event]: [string, unknown]) => event === "error");
        expect(errorEmits).toHaveLength(1);
        expect((errorEmits[0][1] as { message: string }).message).toContain("could not verify identity");
        expect((errorEmits[0][1] as { retryable?: boolean }).retryable).toBe(true);

        // No half-claimed secret or runner state left behind.
        expect(sock.data.runnerId).toBeUndefined();
        expect(localRunnerSockets.get("runner-retryable")).toBeUndefined();
    });

    it("a wrong secret is rejected via a hard disconnect(true) — not a transport close that could be retried into a hammering loop", async () => {
        const { io, getConnectionHandler } = createFakeIo();
        initSioRegistry(io as never);
        const mockRedis = makeMockRedis();
        await initStateRedis(mockRedis as never);
        _injectRedisForTesting(mockRedis);

        registerRunnerNamespace(io as never, authCtx);
        const connection = getConnectionHandler()!;

        // First registration establishes the real secret.
        const sockFirst = makeSocket("sock-first");
        connection(sockFirst);
        await runWithAuthContext(authCtx, () =>
            sockFirst.fire("register_runner", {
                ...REGISTRATION,
                runnerId: "runner-wrong-secret",
                runnerSecret: "secret-correct",
            }),
        );
        expect(sockFirst.emitted.some(([event]: [string, unknown]) => event === "runner_registered")).toBe(true);

        // Second connection guesses the wrong secret for the same runnerId.
        const sockWrong = makeSocket("sock-wrong");
        connection(sockWrong);
        await runWithAuthContext(authCtx, () =>
            sockWrong.fire("register_runner", {
                ...REGISTRATION,
                runnerId: "runner-wrong-secret",
                runnerSecret: "guessed",
            }),
        );

        expect(sockWrong.connCloseCalls).toBe(0);
        expect(sockWrong.disconnectCalls).toEqual([true]);

        const errorEmits = sockWrong.emitted.filter(([event]: [string, unknown]) => event === "error");
        expect(errorEmits).toHaveLength(1);
        expect((errorEmits[0][1] as { message: string }).message).toContain("secret mismatch");
        expect((errorEmits[0][1] as { retryable?: boolean }).retryable).toBe(false);
    });
});
