// ============================================================================
// runners.spawn-dead-socket.test.ts
//
// Regression test for the zombie-local-socket race class (GM oRG618iQ, 949-r2
// round 3): a disconnect-handler early return (redis adapter recovery mark,
// shutdown preserve, stale owner, ...) can leave localRunnerSockets pointing
// at a dead (disconnected) socket. Before the accessor fix, getLocalRunnerSocket
// returned that socket as "present", so POST /api/runners/spawn would emit
// into it and sit on the 5s spawn-ack timeout before failing.
//
// Drives the REAL spawn route (routes/runners.ts) against the REAL
// sio-registry local socket map and real (mock-Redis-backed) runner state —
// only the auth middleware is stubbed. A disconnected fake socket is planted
// directly in localRunnerSockets, mirroring what a disconnect-handler early
// return leaves behind.
// ============================================================================

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, mock, spyOn, test } from "bun:test";
import { createTestAuthContext, runWithAuthContext } from "../auth.js";
import { ensureRunnerOwnerTable } from "../runner-owner.js";
import { _injectRedisForTesting } from "../redis-kv-store.js";

afterAll(() => mock.restore());

const mockRequireSession = mock((_req: Request) =>
    Promise.resolve({ userId: "u1", userName: "User One" } as any),
);
const mockValidateApiKey = mock((_req: Request, _key?: string) =>
    Promise.resolve({ userId: "u1", userName: "User One" } as any),
);
mock.module("../middleware.js", () => ({
    requireSession: mockRequireSession,
    validateApiKey: mockValidateApiKey,
}));
mock.module("../user-hidden-models.js", () => ({ getHiddenModels: mock(() => Promise.resolve([])) }));

const { handleRunnersRoute } = await import("./runners.js");
const { localRunnerSockets, initSioRegistry } = await import("../ws/sio-registry/context.js");
const { registerRunner } = await import("../ws/sio-registry/runners.js");
const { initStateRedis } = await import("../ws/sio-state/index.js");
const runnerControlModule = await import("../ws/runner-control.js");

const mockWaitForSpawnAck = spyOn(runnerControlModule, "waitForSpawnAck");

// ── In-memory Redis mock (sio-state + redis-kv-store surfaces) ─────────────

const hashes = new Map<string, Record<string, string>>();
const strings = new Map<string, string>();
const sets = new Map<string, Set<string>>();

function hSetAll(key: string, fields: Record<string, string>): void {
    hashes.set(key, { ...(hashes.get(key)), ...fields });
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
            expire: () => { ops.push(() => 1); return m; },
            sAdd: () => { ops.push(() => 1); return m; },
            sRem: () => { ops.push(() => 1); return m; },
            del: (key: string) => { ops.push(() => { hashes.delete(key); strings.delete(key); sets.delete(key); return 1; }); return m; },
            exec: async () => ops.map((op) => op()),
        };
        return m;
    };
    return {
        isOpen: true,
        on: () => undefined,
        connect: async () => {},
        multi,
        hGetAll: async (key: string) => ({ ...(hashes.get(key)) }),
        hSet: async (key: string, field: string, value: string) => { hSetAll(key, { [field]: value }); return 1; },
        exists: async (key: string) => (hashes.has(key) || strings.has(key) || sets.has(key) ? 1 : 0),
        sMembers: async (_key: string) => [],
        sAdd: async () => 1,
        sRem: async () => 1,
        expire: async () => 1,
        set: async (key: string, value: string) => { strings.set(key, value); return "OK"; },
        get: async (key: string) => strings.get(key) ?? null,
        del: async (key: string) => { hashes.delete(key); strings.delete(key); sets.delete(key); return 1; },
    } as any;
}

function makeReq(body: object): Request {
    return new Request("http://localhost/api/runners/spawn", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
    });
}

/** Fake dead socket: already disconnected, but still sitting in the map —
 *  exactly what the redis-adapter-recovery disconnect-handler early return
 *  used to leave behind before the delete-if-current fix. */
function makeDeadSocket(): any {
    return {
        id: "dead-sock",
        connected: false,
        emit: mock(() => {
            throw new Error("spawn route must never emit into a dead local socket");
        }),
    };
}

const authCtx = createTestAuthContext({ dbPath: ":memory:" });

describe("spawn route treats a dead local runner socket as absent", () => {
    beforeAll(async () => {
        await runWithAuthContext(authCtx, () => ensureRunnerOwnerTable());
    });

    beforeEach(async () => {
        hashes.clear();
        strings.clear();
        sets.clear();
        localRunnerSockets.clear();
        mockWaitForSpawnAck.mockClear();

        const mockRedis = makeMockRedis();
        await initStateRedis(mockRedis);
        _injectRedisForTesting(mockRedis);
        initSioRegistry({ of: () => ({ emit: () => {}, to: () => ({ emit: () => {} }) }) } as any);

        // Register runner-1 for user u1 with a LIVE socket (normal path),
        // then swap the map entry for a dead one — simulating the window a
        // disconnect-handler early return leaves between "force-closed" and
        // "map entry cleared".
        await runWithAuthContext(authCtx, () =>
            registerRunner({ id: "live-sock", connected: true, join: async () => {} } as any, {
                name: "runner-one",
                roots: [],
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
            }),
        );
        localRunnerSockets.set("runner-1", makeDeadSocket());
    });

    afterEach(() => {
        mockWaitForSpawnAck.mockReset();
    });

    test("returns the normal 502 'not connected' error without ever touching the dead socket or the ack wait", async () => {
        const res = await handleRunnersRoute(makeReq({ runnerId: "runner-1" }), new URL("http://localhost/api/runners/spawn"));
        expect(res).toBeInstanceOf(Response);
        expect((res as Response).status).toBe(502);
        const json = await (res as Response).json();
        expect(json.error).toBe("Runner is not connected to this server");

        // The accessor cleared the stale entry on read.
        expect(localRunnerSockets.has("runner-1")).toBe(false);

        // Never reached the ack wait — proves this returns immediately
        // instead of sitting on the 5s spawn-ack timeout.
        expect(mockWaitForSpawnAck).not.toHaveBeenCalled();
    });
});
