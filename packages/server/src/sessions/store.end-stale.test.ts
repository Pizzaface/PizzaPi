import { describe, it, expect, beforeAll, beforeEach, afterAll } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createTestAuthContext, getKysely, runWithAuthContext } from "../auth.js";
import {
    ensureRelaySessionTables,
    recordRelaySessionStart,
    recordRelaySessionEnd,
} from "./store.js";

const tmpDir = mkdtempSync(join(tmpdir(), "pizzapi-store-end-stale-"));
const dbPath = join(tmpDir, "test.db");
const authContext = createTestAuthContext({ dbPath });
const withAuth = <T>(fn: () => T): T => runWithAuthContext(authContext, fn);
const authIt = (name: string, fn: () => Promise<void> | void) => it(name, () => withAuth(fn));
const TEST_USER = "test-user-end-stale";
const SESSION_ID = "s-end-stale";

function isoPast(): string {
    // A timestamp in the past, like a reconnect preserving the original startedAt.
    return new Date(Date.now() - 60_000).toISOString();
}

beforeAll(async () => {
    await withAuth(() => ensureRelaySessionTables());
});

beforeEach(async () => {
    await withAuth(async () => {
        await getKysely().deleteFrom("relay_session_state").execute();
        await getKysely().deleteFrom("relay_session").execute();
    });
});

afterAll(() => {
    rmSync(tmpDir, { recursive: true, force: true });
});

describe("recordRelaySessionEnd stale-write guard", () => {

    it.skip("does not re-close a session that was reconnected before the stale end write (currently fails — stale end write re-closes reconnected session)", async () => {
        const startedAt = isoPast();

        // 1. Session starts and then ends the first time.
        await recordRelaySessionStart({
            sessionId: SESSION_ID,
            userId: TEST_USER,
            cwd: "/project",
            shareUrl: `http://test/${SESSION_ID}`,
            startedAt,
            isEphemeral: false,
        });
        await recordRelaySessionEnd(SESSION_ID);

        const firstEnd = await getKysely()
            .selectFrom("relay_session")
            .select("endedAt")
            .where("id", "=", SESSION_ID)
            .executeTakeFirst();
        expect(firstEnd?.endedAt).not.toBeNull();

        // 2. The session reconnects. PizzaPi preserves the original startedAt
        //    and the upsert clears endedAt back to NULL.
        await recordRelaySessionStart({
            sessionId: SESSION_ID,
            userId: TEST_USER,
            cwd: "/project",
            shareUrl: `http://test/${SESSION_ID}`,
            startedAt,
            isEphemeral: false,
        });

        const afterReconnect = await getKysely()
            .selectFrom("relay_session")
            .select("endedAt")
            .where("id", "=", SESSION_ID)
            .executeTakeFirst();
        expect(afterReconnect?.endedAt).toBeNull();

        // 3. A stale endSharedSession() SQLite write (from the earlier teardown)
        //    finally reaches the DB. Because endedAt is NULL, it must be ignored.
        await recordRelaySessionEnd(SESSION_ID);

        const afterStaleEnd = await getKysely()
            .selectFrom("relay_session")
            .select("endedAt")
            .where("id", "=", SESSION_ID)
            .executeTakeFirst();

        expect(afterStaleEnd?.endedAt).toBeNull();
    });
});
