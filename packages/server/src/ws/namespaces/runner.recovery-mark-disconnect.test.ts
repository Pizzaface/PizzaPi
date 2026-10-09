// ============================================================================
// runner.recovery-mark-disconnect.test.ts — GM oRG618iQ (PR #949, round 3)
//
// Three review rounds each found one more instance of the same race class: an
// early return in a disconnect handler leaves a dead socket pinned in a local
// socket map. The redis-adapter-recovery mark branch in the /runner namespace
// disconnect handler (preserve Redis state — the daemon is still alive and
// will reconnect) used to be one of them: it returned without ever clearing
// localRunnerSockets, so the forced-closed socket stayed "present" until the
// daemon's NEW connection happened to re-register (registerRunner's own
// stale-socket cleanup). In the window between, getLocalRunnerSocket (before
// its own connected-check fix) reported the dead socket as live.
//
// This drives the REAL /runner namespace disconnect handler
// (registerRunnerNamespace) with a recovery-marked fake socket and the real
// registerRunner() registry path. Redis is fully mocked via dependency
// injection (initStateRedis + _injectRedisForTesting) — no mock.module.
// ============================================================================

import { describe, it, expect, beforeAll, beforeEach, afterEach } from "bun:test";
import { createTestAuthContext, runWithAuthContext } from "../../auth.js";
import { ensureRunnerOwnerTable } from "../../runner-owner.js";
import { _injectRedisForTesting } from "../../redis-kv-store.js";
import {
    initSioRegistry,
    localRunnerSockets,
    localTerminalGcTimers,
    localTerminalBuffers,
    localTerminalViewerSockets,
    _resetRunnerSecretsForTesting,
} from "../sio-registry/context.js";
import { initStateRedis, getRunner } from "../sio-state/index.js";
import { registerRunner as registerRunnerRaw, getLocalRunnerSocket } from "../sio-registry/runners.js";
import { markRedisAdapterRecoverySocket } from "../../redis-adapter-recovery.js";
import { registerRunnerNamespace, sendRunnerCommand } from "./runner.js";
import { registerTerminal, getTerminalIdsForRunner } from "../sio-registry/terminals.js";
import { registerTerminalNamespace } from "./terminal.js";

// ── In-memory Redis mock (same shape as runner.stale-disconnect.test.ts) ────

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
            hGetAll: (key: string) => { ops.push(() => ({ ...(hashes.get(key)) })); return m; },
            expire: () => { ops.push(() => 1); return m; },
            sAdd: (key: string, ...members: unknown[]) => { ops.push(() => { sAddAll(key, members); return 1; }); return m; },
            sRem: (key: string, ...members: unknown[]) => { ops.push(() => { sRemAll(key, members); return 1; }); return m; },
            del: (key: string) => { ops.push(() => { delKey(key); return 1; }); return m; },
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

    const mkNs = (): Record<string, unknown> => ({
        emit: () => {},
        to: () => ({ emit: () => {} }),
        local: { emit: () => {}, to: () => ({ emit: () => {} }) },
        use: () => {},
        on: (event: string, cb: (socket: unknown) => void) => {
            if (event === "connection") connectionHandler = cb;
        },
    });

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

const authCtx = createTestAuthContext({ dbPath: ":memory:" });
const registerRunner = (...args: Parameters<typeof registerRunnerRaw>) =>
    runWithAuthContext(authCtx, () => registerRunnerRaw(...args));

describe("recovery-mark disconnect clears the dead local runner socket (GM oRG618iQ r3)", () => {
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

    afterEach(() => {
        for (const timer of localTerminalGcTimers.values()) clearTimeout(timer);
        localTerminalGcTimers.clear();
        localTerminalBuffers.clear();
        localTerminalViewerSockets.clear();
    });

    it("clears localRunnerSockets and preserves Redis state when the recovery-marked socket disconnects", async () => {
        const { io, getConnectionHandler } = createFakeIo();
        initSioRegistry(io as never);
        const mockRedis = makeMockRedis();
        await initStateRedis(mockRedis as never);
        _injectRedisForTesting(mockRedis);

        registerRunnerNamespace(io as never, authCtx);
        const connection = getConnectionHandler();
        expect(connection).toBeDefined();

        const sock = makeSocket("sock-A");
        connection!(sock);
        const runnerId = await registerRunner(sock, REGISTRATION);
        expect(runnerId).toBe("runner-1");
        sock.data.runnerId = runnerId as string;
        expect(localRunnerSockets.get("runner-1")).toBe(sock);

        // Simulate recoverLiveSocketsAfterRedisReconnect: mark the socket,
        // then force-close its transport (socket.conn.close in real code —
        // here we just flip .connected like a real force-close would, since
        // the fake socket has no live transport).
        markRedisAdapterRecoverySocket(sock);
        sock.connected = false;

        await sock.fire("disconnect", "transport close");

        // Redis state preserved — the daemon is still alive.
        const runnerAfter = await getRunner("runner-1");
        expect(runnerAfter).not.toBeNull();
        expect(runnerAfter!.name).toBe("runner-one");

        // But the dead local socket must NOT still be reachable: this is the
        // exact bug the review flagged — without the fix, localRunnerSockets
        // keeps pointing at `sock` (disconnected) until some other path
        // happens to clear it, and getLocalRunnerSocket (pre-fix) reported it
        // as present.
        expect(localRunnerSockets.has("runner-1")).toBe(false);
        expect(getLocalRunnerSocket("runner-1")).toBeUndefined();
    });

    it("does not clear a replacement socket that already re-registered before the stale disconnect fires", async () => {
        const { io, getConnectionHandler } = createFakeIo();
        initSioRegistry(io as never);
        const mockRedis = makeMockRedis();
        await initStateRedis(mockRedis as never);
        _injectRedisForTesting(mockRedis);

        registerRunnerNamespace(io as never, authCtx);
        const connection = getConnectionHandler()!;

        const sockA = makeSocket("sock-A");
        connection(sockA);
        const runnerId = await registerRunner(sockA, REGISTRATION);
        sockA.data.runnerId = runnerId as string;

        markRedisAdapterRecoverySocket(sockA);
        sockA.connected = false;

        // The daemon reconnects with a NEW socket before the old one's
        // disconnect handler runs (e.g. a slow event loop tick).
        const sockB = makeSocket("sock-B");
        connection(sockB);
        const regB = await registerRunner(sockB, REGISTRATION);
        sockB.data.runnerId = regB as string;
        expect(localRunnerSockets.get("runner-1")).toBe(sockB);

        // The stale disconnect for sockA must not disturb sockB's entry.
        await sockA.fire("disconnect", "transport close");

        expect(localRunnerSockets.get("runner-1")).toBe(sockB);
        expect(getLocalRunnerSocket("runner-1")).toBe(sockB);
    });
});

describe("sendRunnerCommand treats a dead local runner socket as absent", () => {
    beforeEach(() => {
        localRunnerSockets.clear();
    });

    it("throws immediately instead of emitting into a disconnected socket", async () => {
        const deadSocket: any = {
            id: "dead-sock",
            connected: false,
            emit: () => {
                throw new Error("sendRunnerCommand must never emit into a dead local socket");
            },
        };
        localRunnerSockets.set("runner-1", deadSocket);

        await expect(sendRunnerCommand("runner-1", { type: "list_files" })).rejects.toThrow(
            "Runner not found",
        );
    });
});

describe("terminal namespace treats a dead local runner socket as absent", () => {
    beforeEach(async () => {
        hashes.clear();
        strings.clear();
        sets.clear();
        localRunnerSockets.clear();
        localTerminalGcTimers.forEach((timer) => clearTimeout(timer));
        localTerminalGcTimers.clear();
        localTerminalBuffers.clear();
        localTerminalViewerSockets.clear();

        const mockRedis = makeMockRedis();
        await initStateRedis(mockRedis as never);
        _injectRedisForTesting(mockRedis);
    });

    afterEach(() => {
        for (const timer of localTerminalGcTimers.values()) clearTimeout(timer);
        localTerminalGcTimers.clear();
        localTerminalBuffers.clear();
        localTerminalViewerSockets.clear();
    });

    it("terminal_input is dropped (not emitted) when the owning runner's local socket is dead", async () => {
        await registerTerminal("term-1", "runner-1", "u1");
        expect(await getTerminalIdsForRunner("runner-1")).toContain("term-1");

        const deadRunnerSocket: any = {
            id: "dead-runner-sock",
            connected: false,
            emit: () => {
                throw new Error("terminal input must never be forwarded to a dead runner socket");
            },
        };
        localRunnerSockets.set("runner-1", deadRunnerSocket);

        const { io, getConnectionHandler } = createFakeIo();
        registerTerminalNamespace(io as never, authCtx);
        const connection = getConnectionHandler();
        expect(connection).toBeDefined();

        const viewerSocket: any = {
            id: "viewer-sock",
            data: { userId: "u1" } as Record<string, unknown>,
            connected: true,
            handshake: { address: "127.0.0.1", headers: {}, auth: { terminalId: "term-1" }, query: {} },
            join: async () => {},
            leave: async () => {},
            emit: () => {},
            disconnect: () => {},
            on(event: string, cb: (...args: any[]) => unknown) {
                (this as any)[`__h_${event}`] = cb;
                return viewerSocket;
            },
            once(event: string, cb: (...args: any[]) => unknown) {
                (this as any)[`__h_${event}`] = cb;
                return viewerSocket;
            },
        };

        await connection!(viewerSocket);

        const inputHandler = viewerSocket.__h_terminal_input;
        expect(inputHandler).toBeDefined();

        // Must not throw (the dead socket's emit would throw if reached) and
        // must simply drop the input — proving getLocalRunnerSocket's
        // connected-check, not a per-call-site guard, is what protects this.
        await inputHandler({ data: "ls\n" });
    });
});
