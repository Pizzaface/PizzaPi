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
// (initStateRedis + _injectRedisForTesting) via the shared harness in
// tests/helpers/runner-namespace-harness.ts — no mock.module, no real Redis,
// no cross-file bleed when bun runs every file in one process.
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
import { createFakeIo, createMemoryRedis, makeSocket } from "../../../tests/helpers/runner-namespace-harness.js";

const memRedis = createMemoryRedis();
const makeMockRedis = () => memRedis.client;

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
        memRedis.clear();
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
