import { expect, test, beforeAll } from "bun:test";
import { randomUUID } from "crypto";
import { kysely } from "../src/auth.js";
import { ensureRelaySessionTables, touchRelaySession, recordRelaySessionStart, getPersistedRelaySessionSnapshot } from "../src/sessions/store.js";

beforeAll(async () => {
    await ensureRelaySessionTables();
});

test("touchRelaySession updates ephemeral session correctly", async () => {
    const sessionId = randomUUID();
    const now = new Date().toISOString();
    await recordRelaySessionStart({
        sessionId,
        userId: "u1",
        userName: "user1",
        cwd: "/tmp",
        shareUrl: "http://test",
        startedAt: now,
        isEphemeral: true,
    });

    // Check initial state
    let session = await getPersistedRelaySessionSnapshot(sessionId);
    expect(session).not.toBeNull();
    expect(session!.isEphemeral).toBe(true);
    const initialExpiresAt = session!.expiresAt;
    expect(initialExpiresAt).not.toBeNull();

    // Wait a bit to ensure time advances (at least 1ms)
    await new Promise(r => setTimeout(r, 10));

    await touchRelaySession(sessionId);

    session = await getPersistedRelaySessionSnapshot(sessionId);
    expect(session!.expiresAt).not.toBeNull();
    // expiry should be extended, so new expiresAt > initialExpiresAt
    expect(new Date(session!.expiresAt!).getTime()).toBeGreaterThan(new Date(initialExpiresAt!).getTime());
});

test("touchRelaySession updates non-ephemeral session correctly", async () => {
    const sessionId = randomUUID();
    const now = new Date().toISOString();
    await recordRelaySessionStart({
        sessionId,
        userId: "u1",
        userName: "user1",
        cwd: "/tmp",
        shareUrl: "http://test",
        startedAt: now,
        isEphemeral: false,
    });

    // Check initial state
    let session = await getPersistedRelaySessionSnapshot(sessionId);
    expect(session).not.toBeNull();
    expect(session!.isEphemeral).toBe(false);
    expect(session!.expiresAt).toBeNull();

    // specific check for lastActiveAt
    const initialRow = await kysely
        .selectFrom("relay_session")
        .select("lastActiveAt")
        .where("id", "=", sessionId)
        .executeTakeFirst();

    const initialLastActiveAt = initialRow!.lastActiveAt;

    // Wait a bit
    await new Promise(r => setTimeout(r, 10));

    await touchRelaySession(sessionId);

    session = await getPersistedRelaySessionSnapshot(sessionId);
    expect(session!.expiresAt).toBeNull();

    const updatedRow = await kysely
        .selectFrom("relay_session")
        .select("lastActiveAt")
        .where("id", "=", sessionId)
        .executeTakeFirst();

    expect(new Date(updatedRow!.lastActiveAt).getTime()).toBeGreaterThan(new Date(initialLastActiveAt).getTime());
});

test("benchmark touchRelaySession", async () => {
    const sessionId = randomUUID();
    const now = new Date().toISOString();
    await recordRelaySessionStart({
        sessionId,
        userId: "u1",
        userName: "user1",
        cwd: "/tmp",
        shareUrl: "http://test",
        startedAt: now,
        isEphemeral: true,
    });

    const iterations = 1000;
    const start = performance.now();
    for (let i = 0; i < iterations; i++) {
        await touchRelaySession(sessionId);
    }
    const end = performance.now();
    console.log(`Time for ${iterations} touchRelaySession calls: ${(end - start).toFixed(2)}ms`);
    console.log(`Average time per call: ${((end - start) / iterations).toFixed(4)}ms`);
});
