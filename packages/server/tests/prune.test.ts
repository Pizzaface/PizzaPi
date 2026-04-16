import { expect, test, beforeAll } from "bun:test";
import { randomUUID } from "crypto";
import { mkdtempSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createTestAuthContext, getKysely, runWithAuthContext } from "../src/auth.js";
import { ensureRelaySessionTables, recordRelaySessionStart, pruneExpiredRelaySessions, recordRelaySessionState } from "../src/sessions/store.js";

const authContext = createTestAuthContext({
    dbPath: join(mkdtempSync(join(tmpdir(), "prune-test-")), "auth.db"),
});
const withAuth = <T>(fn: () => T): T => runWithAuthContext(authContext, fn);

beforeAll(async () => {
    await withAuth(() => ensureRelaySessionTables());
});

test("pruneExpiredRelaySessions removes expired sessions and returns their IDs", async () => {
    const expiredSessionId = randomUUID();
    const past = new Date(Date.now() - 10000).toISOString();

    await withAuth(() => recordRelaySessionStart({
        sessionId: expiredSessionId,
        userId: "u1",
        userName: "user1",
        cwd: "/tmp",
        shareUrl: "http://test",
        startedAt: past,
        isEphemeral: true,
    }));

    await withAuth(() => recordRelaySessionState(expiredSessionId, "u1", { foo: "bar" }));

    await withAuth(() => getKysely().updateTable("relay_session")
        .set({ expiresAt: past })
        .where("id", "=", expiredSessionId)
        .execute());

    const activeSessionId = randomUUID();
    await withAuth(() => recordRelaySessionStart({
        sessionId: activeSessionId,
        userId: "u1",
        userName: "user1",
        cwd: "/tmp",
        shareUrl: "http://test",
        startedAt: new Date().toISOString(),
        isEphemeral: true,
    }));

    const prunedIds = await withAuth(() => pruneExpiredRelaySessions());

    expect(prunedIds).toContain(expiredSessionId);
    expect(prunedIds).not.toContain(activeSessionId);

    const expiredRow = await withAuth(() => getKysely().selectFrom("relay_session").selectAll().where("id", "=", expiredSessionId).executeTakeFirst());
    expect(expiredRow).toBeUndefined();

    const activeRow = await withAuth(() => getKysely().selectFrom("relay_session").selectAll().where("id", "=", activeSessionId).executeTakeFirst());
    expect(activeRow).toBeDefined();

    const stateRow = await withAuth(() => getKysely().selectFrom("relay_session_state").selectAll().where("sessionId", "=", expiredSessionId).executeTakeFirst());
    expect(stateRow).toBeUndefined();
});
