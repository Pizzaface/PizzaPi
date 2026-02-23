import { expect, test, beforeAll } from "bun:test";
import { randomUUID } from "crypto";
import { kysely } from "../src/auth.js";
import { ensureRelaySessionTables, recordRelaySessionStart, pruneExpiredRelaySessions, recordRelaySessionState } from "../src/sessions/store.js";

beforeAll(async () => {
    await ensureRelaySessionTables();
});

test("pruneExpiredRelaySessions removes expired sessions and returns their IDs", async () => {
    // 1. Create an expired session
    const expiredSessionId = randomUUID();
    const past = new Date(Date.now() - 10000).toISOString();

    // Create expired session
    await recordRelaySessionStart({
        sessionId: expiredSessionId,
        userId: "u1",
        userName: "user1",
        cwd: "/tmp",
        shareUrl: "http://test",
        startedAt: past,
        isEphemeral: true,
    });

    // Create session state
    await recordRelaySessionState(expiredSessionId, { foo: "bar" });

    // Update expiry to be in the past
    await kysely.updateTable("relay_session")
        .set({ expiresAt: past })
        .where("id", "=", expiredSessionId)
        .execute();

    // 2. Create an active session
    const activeSessionId = randomUUID();
    await recordRelaySessionStart({
        sessionId: activeSessionId,
        userId: "u1",
        userName: "user1",
        cwd: "/tmp",
        shareUrl: "http://test",
        startedAt: new Date().toISOString(),
        isEphemeral: true,
    });

    // 3. Prune
    const prunedIds = await pruneExpiredRelaySessions();

    // 4. Verify
    expect(prunedIds).toContain(expiredSessionId);
    expect(prunedIds).not.toContain(activeSessionId);

    const expiredRow = await kysely.selectFrom("relay_session").selectAll().where("id", "=", expiredSessionId).executeTakeFirst();
    expect(expiredRow).toBeUndefined();

    const activeRow = await kysely.selectFrom("relay_session").selectAll().where("id", "=", activeSessionId).executeTakeFirst();
    expect(activeRow).toBeDefined();

    const stateRow = await kysely.selectFrom("relay_session_state").selectAll().where("sessionId", "=", expiredSessionId).executeTakeFirst();
    expect(stateRow).toBeUndefined();
});
