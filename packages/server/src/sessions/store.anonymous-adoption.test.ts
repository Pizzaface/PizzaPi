/**
 * Regression repro: anonymous-to-authenticated session adoption leaves
 * SQLite userId null, creating a Redis/SQLite ownership divergence that
 * lets a later caller claim the same session ID and inherit the previous
 * owner's persisted runner association.
 *
 * Mirrors the mock infrastructure from store.ownership.test.ts.
 */
import { afterAll, describe, it, expect, beforeAll, afterEach, mock } from "bun:test";
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

afterAll(() => mock.restore());

import {
    ensureRelaySessionTables,
    recordRelaySessionStart,
    getRelaySessionUserId,
    getPersistedRelaySessionRunner,
} from "./store.js";

const USER_A = "user-alpha";
const USER_B = "user-bravo";

beforeAll(async () => {
    await ensureRelaySessionTables();
});

afterEach(async () => {
    await memDb.deleteFrom("relay_session_state").execute();
    await memDb.deleteFrom("relay_session").execute();
});

describe("recordRelaySessionStart — anonymous-to-authenticated adoption", () => {
    it("leaves SQLite userId null after an authenticated user adopts an anonymous session", async () => {
        // 1. Anonymous session is persisted.
        await recordRelaySessionStart({
            sessionId: "adopted-session",
            userId: undefined,
            cwd: "/anon",
            shareUrl: "http://test/adopted-session",
            startedAt: new Date().toISOString(),
            isEphemeral: false,
        });

        // 2. User A reconnects with the same session ID and a runner.
        //    Redis would now show userId=USER_A, but SQLite does not.
        await recordRelaySessionStart({
            sessionId: "adopted-session",
            userId: USER_A,
            cwd: "/repo",
            shareUrl: "http://test/adopted-session",
            startedAt: new Date().toISOString(),
            isEphemeral: false,
            runnerId: "runner-a",
            runnerName: "Runner A",
        });

        const row = await memDb
            .selectFrom("relay_session")
            .select(["id", "userId", "runnerId", "runnerName"])
            .where("id", "=", "adopted-session")
            .executeTakeFirst();

        // This is the current (buggy) behavior: the onConflict update does not
        // overwrite userId, so the persisted row still has no owner even though
        // Redis considers the session owned by User A.
        expect(row?.userId).toBeNull();
        expect(row?.runnerId).toBe("runner-a");

        // 3. If the Redis key later expires, SQLite still reports no owner, so
        //    registerTuiSession's fallback guard cannot block User B from
        //    claiming the same session ID.  User B also inherits runner-a.
        const persistedOwner = await getRelaySessionUserId("adopted-session");
        expect(persistedOwner).toBeNull();

        const persistedRunner = await getPersistedRelaySessionRunner("adopted-session");
        expect(persistedRunner).toEqual({ runnerId: "runner-a", runnerName: "Runner A" });
    });
});
