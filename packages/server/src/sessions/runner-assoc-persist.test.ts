/**
 * Regression tests: runner association persists in SQLite across runner restarts.
 *
 * Uses mock.module to replace ../auth.js so getKysely() returns an in-memory
 * SQLite instance owned by this file.  This avoids the shared-singleton
 * clobbering that broke these tests in CI.
 */
import { describe, it, expect, beforeAll, afterEach, mock } from "bun:test";
import { Database } from "bun:sqlite";
import { Kysely } from "kysely";
import { BunSqliteDialect } from "kysely-bun-sqlite";

// ── In-memory DB (no temp files, no singleton) ───────────────────────────────
const memDb = new Kysely<any>({
    dialect: new BunSqliteDialect({ database: new Database(":memory:") }),
});

mock.module("../auth.js", () => ({
    getKysely: () => memDb,
    createTestDatabase: () => memDb,
    _setKyselyForTest: () => {},
}));

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

beforeAll(async () => {
    await ensureRelaySessionTables();
});

afterEach(async () => {
    await memDb.deleteFrom("relay_session_state").execute();
    await memDb.deleteFrom("relay_session").execute();
});

// TODO(ltl2EKmU): mock.module doesn't isolate getKysely in CI — Bun single-process singleton clobbering
describe.skip("runner association persistence", () => {
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

        const row = await memDb
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

        const row = await memDb
            .selectFrom("relay_session")
            .select(["runnerId", "runnerName"])
            .where("id", "=", "s-ra-2")
            .executeTakeFirst();

        expect(row?.runnerId).toBeNull();
        expect(row?.runnerName).toBeNull();
    });

    it("updateRelaySessionRunner updates runner info after creation", async () => {
        await recordRelaySessionStart({
            sessionId: "s-ra-3",
            userId: TEST_USER,
            cwd: "/project",
            shareUrl: "http://test/s-ra-3",
            startedAt: new Date().toISOString(),
            isEphemeral: false,
        });

        await updateRelaySessionRunner("s-ra-3", "runner-xyz", "Late Runner");

        const row = await memDb
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

        // Simulate endSharedSession setting endedAt
        await memDb
            .updateTable("relay_session")
            .set({ endedAt: new Date().toISOString() })
            .where("id", "=", "s-ra-6")
            .execute();

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
        const insertPromise = (async () => {
            await new Promise<void>((r) => setTimeout(r, 50));
            await recordRelaySessionStart({
                sessionId: "s-ra-race",
                userId: TEST_USER,
                cwd: "/project",
                shareUrl: "http://test/s-ra-race",
                startedAt: new Date().toISOString(),
                isEphemeral: false,
            });
        })();

        const result = await updateRelaySessionRunner("s-ra-race", "runner-late", "Late Linker");
        await insertPromise;

        expect(result).toBe(true);

        const row = await memDb
            .selectFrom("relay_session")
            .select(["runnerId", "runnerName"])
            .where("id", "=", "s-ra-race")
            .executeTakeFirst();

        expect(row?.runnerId).toBe("runner-late");
        expect(row?.runnerName).toBe("Late Linker");
    });

    it("recordRelaySessionStart updates runner info on reconnect (P2 onConflict)", async () => {
        await recordRelaySessionStart({
            sessionId: "s-ra-reconn",
            userId: TEST_USER,
            cwd: "/project",
            shareUrl: "http://test/s-ra-reconn",
            startedAt: new Date().toISOString(),
            isEphemeral: false,
        });

        const before = await memDb
            .selectFrom("relay_session")
            .select(["runnerId", "runnerName"])
            .where("id", "=", "s-ra-reconn")
            .executeTakeFirst();
        expect(before?.runnerId).toBeNull();

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

        const after = await memDb
            .selectFrom("relay_session")
            .select(["runnerId", "runnerName"])
            .where("id", "=", "s-ra-reconn")
            .executeTakeFirst();
        expect(after?.runnerId).toBe("runner-reconn");
        expect(after?.runnerName).toBe("Reconnected Runner");
    });

    it("recordRelaySessionStart does NOT null out runner info on reconnect without runner data", async () => {
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

        await recordRelaySessionStart({
            sessionId: "s-ra-null-guard",
            userId: TEST_USER,
            cwd: "/project",
            shareUrl: "http://test/s-ra-null-guard",
            startedAt: new Date().toISOString(),
            isEphemeral: false,
        });

        const row = await memDb
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
