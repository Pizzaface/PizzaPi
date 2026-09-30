// ============================================================================
// runner.handlers.test.ts — end-to-end wiring of the /runner namespace's
// security guards through the REAL socket handlers.
//
// runner.test.ts unit-tests the extracted predicates (pendingSocketMatches,
// shouldRejectSessionAdoption). This file proves the handlers actually call
// them with the right inputs: session_ready's ownership / live-owner check and
// the same-socket binding of pending runner responses.
//
// Collaborators are injected (in-memory Redis, fake Socket.IO server, fake
// sockets) via tests/helpers/runner-namespace-harness.ts — no mock.module, so
// this file is safe in a shared `bun test packages/server` process.
// ============================================================================

import { afterAll, afterEach, beforeEach, describe, expect, it } from "bun:test";
import { createTestAuthContext } from "../../auth.js";
import { _injectRedisForTesting } from "../../redis-kv-store.js";
import {
    _injectRedisForTesting as injectRelayCacheRedis,
    _resetRelayRedisCacheForTesting,
} from "../../sessions/redis.js";
import {
    initSioRegistry,
    localRunnerSockets,
    runnerRoom,
    _resetRunnerSecretsForTesting,
} from "../sio-registry/context.js";
import { initStateRedis, getSession, setSession } from "../sio-state/index.js";
import type { RedisSessionData } from "../sio-state/index.js";
import { registerRunnerNamespace, sendSkillCommand } from "./runner.js";
import {
    createFakeIo,
    createMemoryRedis,
    makeSocket,
    type FakeSocket,
} from "../../../tests/helpers/runner-namespace-harness.js";

const memRedis = createMemoryRedis();
// Deliberately UNMIGRATED: the handlers' best-effort SQLite writes (runner
// owner, trigger routes, relay_session runner link) fail fast and are logged.
// With tables present, trigger reconciliation proceeds into code paths that
// lazily dial a real Redis — which unit tests must never do.
const authContext = createTestAuthContext({ dbPath: ":memory:" });

let fake: ReturnType<typeof createFakeIo>;
let connection: (socket: unknown) => void;
const sockets: FakeSocket[] = [];

async function connectRunner(socketId: string, runnerId: string, userId: string): Promise<FakeSocket> {
    const sock = makeSocket(socketId, fake.rooms, { userId, userName: userId });
    sockets.push(sock);
    connection(sock);
    await sock.fire("register_runner", {
        name: runnerId,
        roots: [],
        runnerId,
        runnerSecret: `secret-${runnerId}`,
        skills: [],
        agents: [],
        plugins: [],
        hooks: [],
    });
    expect(sock.data.runnerId).toBe(runnerId);
    expect(localRunnerSockets.get(runnerId)).toBe(sock);
    return sock;
}

async function seedSession(sessionId: string, fields: Partial<RedisSessionData>): Promise<void> {
    await setSession(sessionId, {
        sessionId,
        token: "tok",
        collabMode: false,
        shareUrl: `http://test/${sessionId}`,
        cwd: "/tmp",
        startedAt: new Date().toISOString(),
        userId: "u1",
        userName: "u1",
        sessionName: null,
        isEphemeral: false,
        expiresAt: null,
        isActive: true,
        lastHeartbeatAt: null,
        lastHeartbeat: null,
        lastState: null,
        runnerId: null,
        runnerName: null,
        seq: 0,
        parentSessionId: null,
        ...fields,
    });
}

/** Emits of forwarded agent events to viewers of `sessionId`. */
function viewerEventsFor(sessionId: string) {
    return fake.roomEmits.filter(
        (e) => e.namespace === "/viewer" && e.event === "event"
            && (e.payload as { sessionId?: string })?.sessionId === sessionId,
    );
}

beforeEach(async () => {
    memRedis.clear();
    localRunnerSockets.clear();
    _resetRunnerSecretsForTesting();
    fake = createFakeIo();
    initSioRegistry(fake.io as never);
    await initStateRedis(memRedis.client as never);
    _injectRedisForTesting(memRedis.client);
    // publishSessionEvent appends to the relay event cache, which has its own
    // lazily-connected client — inject so nothing ever dials a real Redis.
    injectRelayCacheRedis(memRedis.client);
    registerRunnerNamespace(fake.io as never, authContext);
    connection = fake.getConnectionHandler()!;
    expect(connection).toBeDefined();
});

afterEach(async () => {
    // Fire disconnect so register_runner's TTL-refresh interval is cleared.
    for (const sock of sockets.splice(0)) {
        sock.connected = false;
        await sock.fire("disconnect", "transport close").catch(() => {});
    }
});

afterAll(() => {
    _resetRelayRedisCacheForTesting();
    void authContext.db.destroy();
});

describe("session_ready adoption guard (handler wiring)", () => {
    it("rejects a same-user runner claiming an ACTIVE session owned by a LIVE runner", async () => {
        await connectRunner("sock-A", "runner-A", "u1");
        const sockB = await connectRunner("sock-B", "runner-B", "u1");
        await seedSession("s1", { runnerId: "runner-A", isActive: true });

        await sockB.fire("session_ready", { sessionId: "s1" });

        expect((await getSession("s1"))?.runnerId).toBe("runner-A");
        // B is not a member of s1 — its events must not reach viewers.
        await sockB.fire("runner_session_event", { sessionId: "s1", event: { type: "injected" } });
        expect(viewerEventsFor("s1")).toHaveLength(0);
    });

    it("allows adoption once the owning runner is no longer live", async () => {
        const sockA = await connectRunner("sock-A", "runner-A", "u1");
        const sockB = await connectRunner("sock-B", "runner-B", "u1");
        await seedSession("s1", { runnerId: "runner-A", isActive: true });

        // Owner drops out of its runner room (crashed / gone cluster-wide).
        fake.rooms.get(runnerRoom("runner-A"))?.delete(sockA);

        await sockB.fire("session_ready", { sessionId: "s1" });

        expect((await getSession("s1"))?.runnerId).toBe("runner-B");
    });

    it("allows adoption of an INACTIVE session even if its old runner is live", async () => {
        await connectRunner("sock-A", "runner-A", "u1");
        const sockB = await connectRunner("sock-B", "runner-B", "u1");
        await seedSession("s1", { runnerId: "runner-A", isActive: false });

        await sockB.fire("session_ready", { sessionId: "s1" });

        expect((await getSession("s1"))?.runnerId).toBe("runner-B");
    });

    it("fails closed when owner liveness cannot be determined", async () => {
        await connectRunner("sock-A", "runner-A", "u1");
        const sockB = await connectRunner("sock-B", "runner-B", "u1");
        await seedSession("s1", { runnerId: "runner-A", isActive: true });
        fake.state.failFetchSockets = true;

        await sockB.fire("session_ready", { sessionId: "s1" });

        expect((await getSession("s1"))?.runnerId).toBe("runner-A");
    });

    it("rejects a runner claiming another user's session", async () => {
        const sockB = await connectRunner("sock-B", "runner-B", "u1");
        await seedSession("s1", { userId: "u2", runnerId: null });

        await sockB.fire("session_ready", { sessionId: "s1" });

        expect((await getSession("s1"))?.runnerId).toBeNull();
        await sockB.fire("runner_session_event", { sessionId: "s1", event: { type: "injected" } });
        expect(viewerEventsFor("s1")).toHaveLength(0);
    });

    it("accepts the owning runner re-announcing its own session", async () => {
        const sockA = await connectRunner("sock-A", "runner-A", "u1");
        await seedSession("s1", { runnerId: "runner-A", isActive: true });

        await sockA.fire("session_ready", { sessionId: "s1" });

        expect((await getSession("s1"))?.runnerId).toBe("runner-A");
        await sockA.fire("runner_session_event", { sessionId: "s1", event: { type: "ok" } });
        expect(viewerEventsFor("s1")).toHaveLength(1);
    });
});

describe("pending runner responses are bound to the issuing socket (handler wiring)", () => {
    it("a skill_result on a different runner socket cannot resolve another runner's request", async () => {
        const sockA = await connectRunner("sock-A", "runner-A", "u1");
        const sockB = await connectRunner("sock-B", "runner-B", "u1");

        let settled: unknown;
        const pending = sendSkillCommand("runner-A", { type: "list_skills" }, 2_000)
            .then((r) => { settled = r; return r; });

        const sent = sockA.emitted.find(([event]: [string]) => event === "list_skills");
        expect(sent).toBeDefined();
        const requestId = (sent![1] as { requestId: string }).requestId;
        expect(typeof requestId).toBe("string");

        // Forged response with the right requestId on the WRONG socket.
        await sockB.fire("skill_result", { requestId, ok: false, message: "forged" });
        await Promise.resolve();
        expect(settled).toBeUndefined();

        // Genuine response on the issuing socket resolves it.
        await sockA.fire("skill_result", { requestId, ok: true, message: "real" });
        expect(await pending).toMatchObject({ ok: true, message: "real" });
    });
});
