// ============================================================================
// runner.stale-disconnect.test.ts — B-014 regression tests
//
// A runner reconnect REPLACES localRunnerSockets[runnerId] with the new socket
// but does not invalidate the old one. When the old (stale) socket later
// disconnects, the disconnect handler must NOT tear down state by runner id —
// that would nuke the live replacement's Redis runner row, runner secret,
// terminal ownership, and the socket map entry. Only the currently-registered
// socket's disconnect performs real teardown.
//
// This drives the REAL /runner namespace connection/disconnect handler
// (registerRunnerNamespace) with fake sockets and the real registerRunner()
// registry path. Redis is fully mocked via dependency injection
// (initStateRedis + _injectRedisForTesting) — no mock.module, no real Redis,
// no cross-file bleed (see TODO(ltl2EKmU)).
// ============================================================================

import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { createTestAuthContext } from "../../auth.js";
import { _injectRedisForTesting } from "../../redis-kv-store.js";
import {
    initSioRegistry,
    localRunnerSockets,
    localTerminalGcTimers,
    localTerminalBuffers,
    localTerminalViewerSockets,
    _resetRunnerSecretsForTesting,
    getRunnerSecret,
} from "../sio-registry/context.js";
import { initStateRedis, getRunner } from "../sio-state/index.js";
import { registerRunner } from "../sio-registry/runners.js";
import { registerTerminal, getTerminalIdsForRunner, getTerminalEntry } from "../sio-registry/terminals.js";
import { registerRunnerNamespace } from "./runner.js";

// ── In-memory Redis mock ────────────────────────────────────────────────────

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

function sRemAll(key: string, members: unknown[]): void {
    const s = sets.get(key);
    if (s) for (const m of members.flat()) s.delete(String(m));
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
            sRem: (key: string, ...members: unknown[]) => {
                ops.push(() => { sRemAll(key, members); return 1; });
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
        sRem: async (key: string, ...members: unknown[]) => { sRemAll(key, members); return 1; },
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
        conn: { transport: { name: "websocket" } },
        join: async () => {},
        leave: async () => {},
        emit: () => {},
        disconnect: () => {},
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
    requestedRunnerId: "runner-1",
    runnerSecret: "secret-1",
    skills: [],
    agents: [],
    plugins: [],
    hooks: [],
    version: null,
    platform: null,
    userId: "u1",
    userName: "User One",
};

// ── Tests ────────────────────────────────────────────────────────────────────

describe("runner stale disconnect after replacement (B-014)", () => {
    beforeEach(() => {
        hashes.clear();
        strings.clear();
        sets.clear();
        localRunnerSockets.clear();
        _resetRunnerSecretsForTesting();
    });

    afterEach(() => {
        // Defuse registerTerminal/removeTerminal GC timers so no dangling
        // timer callbacks touch the mock store after the test completes.
        for (const timer of localTerminalGcTimers.values()) clearTimeout(timer);
        localTerminalGcTimers.clear();
        localTerminalBuffers.clear();
        localTerminalViewerSockets.clear();
    });

    it("stale socket disconnect is a NO-OP; current socket disconnect tears down", async () => {
        const { io, getConnectionHandler } = createFakeIo();
        initSioRegistry(io as never);
        const mockRedis = makeMockRedis();
        await initStateRedis(mockRedis as never);
        // Runner secrets live in the redis-kv store — inject the same mock
        // there too so validateAndPersistRunnerSecret never hits real Redis.
        _injectRedisForTesting(mockRedis);

        registerRunnerNamespace(io as never, createTestAuthContext({ dbPath: ":memory:" }));
        const connection = getConnectionHandler();
        expect(connection).toBeDefined();

        // ── Socket A connects and registers runner-1 ────────────────────────
        const sockA = makeSocket("sock-A");
        connection!(sockA);
        const regA = await registerRunner(sockA, REGISTRATION);
        expect(regA).toBe("runner-1");
        // Mirror the register_runner event handler's success path.
        sockA.data.runnerId = regA as string;
        expect(localRunnerSockets.get("runner-1")).toBe(sockA);

        // Terminal owned by runner-1 exists in Redis.
        await registerTerminal("term-1", "runner-1", "u1");
        expect(await getTerminalIdsForRunner("runner-1")).toContain("term-1");

        // ── Socket B reconnects with the same identity → replaces A ─────────
        const sockB = makeSocket("sock-B");
        connection!(sockB);
        const regB = await registerRunner(sockB as never, REGISTRATION);
        expect(regB).toBe("runner-1");
        sockB.data.runnerId = regB as string;
        expect(localRunnerSockets.get("runner-1")).toBe(sockB);

        // ── Stale socket A disconnects → everything must be preserved ───────
        await sockA.fire("disconnect", "transport close");

        expect(localRunnerSockets.get("runner-1")).toBe(sockB);
        const runnerAfterStale = await getRunner("runner-1");
        expect(runnerAfterStale).not.toBeNull();
        expect(runnerAfterStale!.name).toBe("runner-one");
        expect(await getRunnerSecret("runner-1")).toBe("secret-1");
        expect(await getTerminalIdsForRunner("runner-1")).toContain("term-1");

        // ── Current socket B disconnects → real teardown ────────────────────
        await sockB.fire("disconnect", "transport close");

        expect(localRunnerSockets.get("runner-1")).toBeUndefined();
        expect(await getRunner("runner-1")).toBeNull();
        expect(await getRunnerSecret("runner-1")).toBeUndefined();
        // removeTerminal marks the terminal exited (GC deletes the row later).
        const term = await getTerminalEntry("term-1");
        expect(term === null || term.exited === true).toBe(true);
    });

    it("disconnect does not tear down a DIFFERENT runner", async () => {
        const { io, getConnectionHandler } = createFakeIo();
        initSioRegistry(io as never);
        const mockRedis = makeMockRedis();
        await initStateRedis(mockRedis as never);
        _injectRedisForTesting(mockRedis);

        registerRunnerNamespace(io as never, createTestAuthContext({ dbPath: ":memory:" }));
        const connection = getConnectionHandler()!;

        const sock1 = makeSocket("sock-1");
        connection(sock1);
        const reg1 = await registerRunner(sock1, {
            ...REGISTRATION,
            requestedRunnerId: "runner-1",
            runnerSecret: "secret-1",
        });
        sock1.data.runnerId = reg1 as string;

        const sock2 = makeSocket("sock-2");
        connection(sock2);
        const reg2 = await registerRunner(sock2, {
            ...REGISTRATION,
            name: "runner-two",
            requestedRunnerId: "runner-2",
            runnerSecret: "secret-2",
        });
        sock2.data.runnerId = reg2 as string;

        // runner-2 disconnects — runner-1 must be untouched.
        await sock2.fire("disconnect", "transport close");

        expect(localRunnerSockets.get("runner-2")).toBeUndefined();
        expect(await getRunner("runner-2")).toBeNull();
        expect(localRunnerSockets.get("runner-1")).toBe(sock1);
        expect(await getRunner("runner-1")).not.toBeNull();
        expect(await getRunnerSecret("runner-1")).toBe("secret-1");
    });
});
