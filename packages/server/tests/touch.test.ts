import { expect, test, beforeAll } from "bun:test";
import { randomUUID } from "crypto";
import { mkdtempSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createTestAuthContext, getKysely, runWithAuthContext } from "../src/auth.js";
import { ensureRelaySessionTables, touchRelaySession, recordRelaySessionStart, getPersistedRelaySessionSnapshot } from "../src/sessions/store.js";

const authContext = createTestAuthContext({
    dbPath: join(mkdtempSync(join(tmpdir(), "touch-test-")), "auth.db"),
});
const withAuth = <T>(fn: () => T): T => runWithAuthContext(authContext, fn);

beforeAll(async () => {
    await withAuth(() => ensureRelaySessionTables());
});

test("touchRelaySession updates ephemeral session correctly", async () => {
    const sessionId = randomUUID();
    const now = new Date().toISOString();
    await withAuth(() => recordRelaySessionStart({
        sessionId,
        userId: "u1",
        userName: "user1",
        cwd: "/tmp",
        shareUrl: "http://test",
        startedAt: now,
        isEphemeral: true,
    }));

    let session = await withAuth(() => getPersistedRelaySessionSnapshot(sessionId, "u1"));
    expect(session).not.toBeNull();
    expect(session!.isEphemeral).toBe(true);
    const initialExpiresAt = session!.expiresAt;
    expect(initialExpiresAt).not.toBeNull();

    await new Promise(r => setTimeout(r, 10));

    await withAuth(() => touchRelaySession(sessionId));

    session = await withAuth(() => getPersistedRelaySessionSnapshot(sessionId, "u1"));
    expect(session!.expiresAt).not.toBeNull();
    expect(new Date(session!.expiresAt!).getTime()).toBeGreaterThan(new Date(initialExpiresAt!).getTime());
});

test("touchRelaySession updates non-ephemeral session correctly", async () => {
    const sessionId = randomUUID();
    const now = new Date().toISOString();
    await withAuth(() => recordRelaySessionStart({
        sessionId,
        userId: "u1",
        userName: "user1",
        cwd: "/tmp",
        shareUrl: "http://test",
        startedAt: now,
        isEphemeral: false,
    }));

    let session = await withAuth(() => getPersistedRelaySessionSnapshot(sessionId, "u1"));
    expect(session).not.toBeNull();
    expect(session!.isEphemeral).toBe(false);
    expect(session!.expiresAt).toBeNull();

    const initialRow = await withAuth(() => getKysely()
        .selectFrom("relay_session")
        .select("lastActiveAt")
        .where("id", "=", sessionId)
        .executeTakeFirst());

    const initialLastActiveAt = initialRow!.lastActiveAt;

    await new Promise(r => setTimeout(r, 10));

    await withAuth(() => touchRelaySession(sessionId));

    session = await withAuth(() => getPersistedRelaySessionSnapshot(sessionId, "u1"));
    expect(session!.expiresAt).toBeNull();

    const updatedRow = await withAuth(() => getKysely()
        .selectFrom("relay_session")
        .select("lastActiveAt")
        .where("id", "=", sessionId)
        .executeTakeFirst());

    expect(new Date(updatedRow!.lastActiveAt).getTime()).toBeGreaterThan(new Date(initialLastActiveAt).getTime());
});

test("benchmark touchRelaySession", async () => {
    const sessionId = randomUUID();
    const now = new Date().toISOString();
    await withAuth(() => recordRelaySessionStart({
        sessionId,
        userId: "u1",
        userName: "user1",
        cwd: "/tmp",
        shareUrl: "http://test",
        startedAt: now,
        isEphemeral: true,
    }));

    const iterations = 1000;
    const start = performance.now();
    for (let i = 0; i < iterations; i++) {
        await withAuth(() => touchRelaySession(sessionId));
    }
    const end = performance.now();
    console.log(`Time for ${iterations} touchRelaySession calls: ${(end - start).toFixed(2)}ms`);
    console.log(`Average time per call: ${((end - start) / iterations).toFixed(4)}ms`);
});
