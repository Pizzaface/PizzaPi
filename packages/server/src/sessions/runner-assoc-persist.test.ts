/**
 * Regression tests: runner association persists in SQLite across runner restarts.
 *
 * When a runner daemon restarts, TUI sockets disconnect and Redis session data
 * is deleted. These tests verify that runnerId/runnerName survive in SQLite so
 * historical and pinned sessions retain their runner provenance.
 */
import { describe, it, expect, beforeAll, afterEach, afterAll } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { initAuth, getKysely } from "../auth.js";
import {
    ensureRelaySessionTables,
    recordRelaySessionStart,
    updateRelaySessionRunner,
    listPersistedRelaySessionsForUser,
    listPinnedRelaySessionsForUser,
    pinRelaySession,
    getRelaySessionUserId,
} from "./store.js";

const TEST_USER = "test-user-runner-assoc";
const tmpDir = mkdtempSync(join(tmpdir(), "pizzapi-runner-assoc-test-"));
const dbPath = join(tmpDir, "runner-assoc-test.db");

beforeAll(async () => {
    initAuth({ dbPath, baseURL: "http://localhost:7777", secret: "test-secret-ra" });
    await ensureRelaySessionTables();
});

afterEach(async () => {
    await getKysely().deleteFrom("relay_session_state").execute();
    await getKysely().deleteFrom("relay_session").execute();
});

afterAll(() => {
    try { rmSync(tmpDir, { recursive: true, force: true }); } catch {}
});

describe("runner association persistence", () => {
    it("recordRelaySessionStart stores runnerId and runnerName", async () => {
        await recordRelaySessionStart({
            sessionId: "s-ra-1",
            userId: TEST_USER,
            cwd: "/project",
            shareUrl: "http://test/s-ra-1",
            startedAt: new Date().toISOString(),
            isEphemeral: false,
            runnerId: "runner-abc",
            runnerName: "My Runner",
        });

        const row = await getKysely()
            .selectFrom("relay_session")
            .select(["runnerId", "runnerName"])
            .where("id", "=", "s-ra-1")
            .executeTakeFirst();

        expect(row?.runnerId).toBe("runner-abc");
        expect(row?.runnerName).toBe("My Runner");
    });

    it("recordRelaySessionStart stores null when no runner info provided", async () => {
        await recordRelaySessionStart({
            sessionId: "s-ra-2",
            userId: TEST_USER,
            cwd: "/project",
            shareUrl: "http://test/s-ra-2",
            startedAt: new Date().toISOString(),
            isEphemeral: false,
        });

        const row = await getKysely()
            .selectFrom("relay_session")
            .select(["runnerId", "runnerName"])
            .where("id", "=", "s-ra-2")
            .executeTakeFirst();

        expect(row?.runnerId).toBeNull();
        expect(row?.runnerName).toBeNull();
    });

    it("updateRelaySessionRunner updates runner info after creation", async () => {
        // Session created without runner (e.g. runner link pending)
        await recordRelaySessionStart({
            sessionId: "s-ra-3",
            userId: TEST_USER,
            cwd: "/project",
            shareUrl: "http://test/s-ra-3",
            startedAt: new Date().toISOString(),
            isEphemeral: false,
        });

        // linkSessionToRunner fires later, updating SQLite
        await updateRelaySessionRunner("s-ra-3", "runner-xyz", "Late Runner");

        const row = await getKysely()
            .selectFrom("relay_session")
            .select(["runnerId", "runnerName"])
            .where("id", "=", "s-ra-3")
            .executeTakeFirst();

        expect(row?.runnerId).toBe("runner-xyz");
        expect(row?.runnerName).toBe("Late Runner");
    });

    it("listPersistedRelaySessionsForUser includes runner info", async () => {
        await recordRelaySessionStart({
            sessionId: "s-ra-4",
            userId: TEST_USER,
            cwd: "/project",
            shareUrl: "http://test/s-ra-4",
            startedAt: new Date().toISOString(),
            isEphemeral: false,
            runnerId: "runner-list",
            runnerName: "List Runner",
        });

        const sessions = await listPersistedRelaySessionsForUser(TEST_USER);
        const found = sessions.find((s) => s.sessionId === "s-ra-4");

        expect(found).toBeDefined();
        expect(found!.runnerId).toBe("runner-list");
        expect(found!.runnerName).toBe("List Runner");
    });

    it("listPinnedRelaySessionsForUser includes runner info", async () => {
        await recordRelaySessionStart({
            sessionId: "s-ra-5",
            userId: TEST_USER,
            cwd: "/project",
            shareUrl: "http://test/s-ra-5",
            startedAt: new Date().toISOString(),
            isEphemeral: false,
            runnerId: "runner-pin",
            runnerName: "Pinned Runner",
        });

        await pinRelaySession("s-ra-5", TEST_USER);

        const sessions = await listPinnedRelaySessionsForUser(TEST_USER);
        const found = sessions.find((s) => s.sessionId === "s-ra-5");

        expect(found).toBeDefined();
        expect(found!.runnerId).toBe("runner-pin");
        expect(found!.runnerName).toBe("Pinned Runner");
    });

    it("runner info survives after session ends (regression: runner restart)", async () => {
        // Simulate: session created with runner, then session ends (TUI disconnect).
        // The Redis hash is deleted, but SQLite should retain runner provenance.
        await recordRelaySessionStart({
            sessionId: "s-ra-6",
            userId: TEST_USER,
            cwd: "/project",
            shareUrl: "http://test/s-ra-6",
            startedAt: new Date().toISOString(),
            isEphemeral: false,
            runnerId: "runner-restart",
            runnerName: "Restarting Runner",
        });

        await pinRelaySession("s-ra-6", TEST_USER);

        // Simulate endSharedSession setting endedAt (Redis hash is deleted,
        // but SQLite row persists with runner info intact)
        await getKysely()
            .updateTable("relay_session")
            .set({ endedAt: new Date().toISOString() })
            .where("id", "=", "s-ra-6")
            .execute();

        // Verify runner info is still there in pinned sessions
        const pinned = await listPinnedRelaySessionsForUser(TEST_USER);
        const found = pinned.find((s) => s.sessionId === "s-ra-6");

        expect(found).toBeDefined();
        expect(found!.runnerId).toBe("runner-restart");
        expect(found!.runnerName).toBe("Restarting Runner");
        expect(found!.endedAt).not.toBeNull();
    });

    it("updateRelaySessionRunner returns false for nonexistent session", async () => {
        const result = await updateRelaySessionRunner("nonexistent-session", "runner-x", "Runner X");
        expect(result).toBe(false);
    });

    it("updateRelaySessionRunner retries and succeeds when row appears after delay (P1 race)", async () => {
        // Simulate the race: linkSessionToRunner fires before recordRelaySessionStart
        // has finished its SQLite insert. The retry logic should catch it.
        //
        // Use a short 50 ms delay (well within the first 250 ms retry window) so
        // the test doesn't depend on wall-clock scheduling that varies on loaded CI
        // runners. The original 300 ms could race past all three retry attempts on
        // a slow machine where JS timers are coalesced or delayed.
        const insertPromise = (async () => {
            await new Promise<void>((r) => setTimeout(r, 50));
            await recordRelaySessionStart({
                sessionId: "s-ra-race",
                userId: TEST_USER,
                cwd: "/project",
                shareUrl: "http://test/s-ra-race",
                startedAt: new Date().toISOString(),
                isEphemeral: false,
                // Note: no runner info — simulating a session that connected
                // before the runner reported session_ready
            });
        })();

        const result = await updateRelaySessionRunner("s-ra-race", "runner-late", "Late Linker");
        await insertPromise; // ensure insert completed (also cleans up any pending promises)

        expect(result).toBe(true);

        const row = await getKysely()
            .selectFrom("relay_session")
            .select(["runnerId", "runnerName"])
            .where("id", "=", "s-ra-race")
            .executeTakeFirst();

        expect(row?.runnerId).toBe("runner-late");
        expect(row?.runnerName).toBe("Late Linker");
    });

    it("recordRelaySessionStart updates runner info on reconnect (P2 onConflict)", async () => {
        // First insert — session created without runner info (pre-migration or no runner)
        await recordRelaySessionStart({
            sessionId: "s-ra-reconn",
            userId: TEST_USER,
            cwd: "/project",
            shareUrl: "http://test/s-ra-reconn",
            startedAt: new Date().toISOString(),
            isEphemeral: false,
        });

        const before = await getKysely()
            .selectFrom("relay_session")
            .select(["runnerId", "runnerName"])
            .where("id", "=", "s-ra-reconn")
            .executeTakeFirst();
        expect(before?.runnerId).toBeNull();

        // Second insert — session reconnects with durable runner association
        await recordRelaySessionStart({
            sessionId: "s-ra-reconn",
            userId: TEST_USER,
            cwd: "/project",
            shareUrl: "http://test/s-ra-reconn",
            startedAt: new Date().toISOString(),
            isEphemeral: false,
            runnerId: "runner-reconn",
            runnerName: "Reconnected Runner",
        });

        const after = await getKysely()
            .selectFrom("relay_session")
            .select(["runnerId", "runnerName"])
            .where("id", "=", "s-ra-reconn")
            .executeTakeFirst();
        expect(after?.runnerId).toBe("runner-reconn");
        expect(after?.runnerName).toBe("Reconnected Runner");
    });

    it("recordRelaySessionStart does NOT null out runner info on reconnect without runner data", async () => {
        // First insert — session created with runner info
        await recordRelaySessionStart({
            sessionId: "s-ra-null-guard",
            userId: TEST_USER,
            cwd: "/project",
            shareUrl: "http://test/s-ra-null-guard",
            startedAt: new Date().toISOString(),
            isEphemeral: false,
            runnerId: "runner-original",
            runnerName: "Original Runner",
        });

        // Second insert — reconnect without any runner association (Redis key expired,
        // session predates the association feature, etc.)
        // The existing runner info must NOT be overwritten with null.
        await recordRelaySessionStart({
            sessionId: "s-ra-null-guard",
            userId: TEST_USER,
            cwd: "/project",
            shareUrl: "http://test/s-ra-null-guard",
            startedAt: new Date().toISOString(),
            isEphemeral: false,
            // runnerId / runnerName intentionally omitted (undefined → null)
        });

        const row = await getKysely()
            .selectFrom("relay_session")
            .select(["runnerId", "runnerName"])
            .where("id", "=", "s-ra-null-guard")
            .executeTakeFirst();

        expect(row?.runnerId).toBe("runner-original");
        expect(row?.runnerName).toBe("Original Runner");
    });

    it("getRelaySessionUserId returns userId for existing session", async () => {
        await recordRelaySessionStart({
            sessionId: "s-ra-uid",
            userId: TEST_USER,
            cwd: "/project",
            shareUrl: "http://test/s-ra-uid",
            startedAt: new Date().toISOString(),
            isEphemeral: false,
        });

        const uid = await getRelaySessionUserId("s-ra-uid");
        expect(uid).toBe(TEST_USER);
    });

    it("getRelaySessionUserId returns null for nonexistent session", async () => {
        const uid = await getRelaySessionUserId("nonexistent-uid-session");
        expect(uid).toBeNull();
    });
});
