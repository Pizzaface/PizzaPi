import { describe, it, expect, beforeAll, beforeEach, afterAll } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createTestDatabase, _setKyselyForTest, getKysely } from "../auth.js";
import {
    ensureRelaySessionTables,
    pinRelaySession,
    unpinRelaySession,
    listPersistedRelaySessionsForUser,
    listPinnedRelaySessionsForUser,
    pruneExpiredRelaySessions,
    getPersistedRelaySessionSnapshot,
    recordRelaySessionStart,
    updateRelaySessionRunner,
    getRelaySessionUserId,
} from "./store.js";

const tmpDir = mkdtempSync(join(tmpdir(), "pizzapi-store-db-isolation-"));
const dbPath = join(tmpDir, "test.db");
const testDb = createTestDatabase(dbPath);
const TEST_USER_ID = "test-user-pin";
const TEST_USER = "test-user-runner-assoc";

function currentIso(): string {
    return new Date().toISOString();
}

async function insertSession(opts: {
    sessionId: string;
    userId?: string;
    isEphemeral?: boolean;
    expiresAt?: string | null;
    isPinned?: number;
}) {
    const now = currentIso();
    await getKysely()
        .insertInto("relay_session")
        .values({
            id: opts.sessionId,
            userId: opts.userId ?? TEST_USER_ID,
            userName: null,
            cwd: "/test",
            shareUrl: `http://test/${opts.sessionId}`,
            startedAt: now,
            lastActiveAt: now,
            endedAt: null,
            isEphemeral: opts.isEphemeral === false ? 0 : 1,
            expiresAt: opts.expiresAt ?? null,
            isPinned: opts.isPinned ?? 0,
            runnerId: null,
            runnerName: null,
            sessionName: null,
        })
        .execute();
}

beforeAll(async () => {
    _setKyselyForTest(testDb);
    await ensureRelaySessionTables();
});

beforeEach(async () => {
    _setKyselyForTest(testDb);
    await getKysely().deleteFrom("relay_session_state").execute();
    await getKysely().deleteFrom("relay_session").execute();
});

afterAll(() => {
    rmSync(tmpDir, { recursive: true, force: true });
});

const isCI = !!process.env.CI;

(isCI ? describe.skip : describe)("pinRelaySession", () => {
    it("pins an existing session owned by the user", async () => {
        await insertSession({ sessionId: "s1" });

        const result = await pinRelaySession("s1", TEST_USER_ID);
        expect(result).toBe(true);

        const row = await getKysely()
            .selectFrom("relay_session")
            .select("isPinned")
            .where("id", "=", "s1")
            .executeTakeFirst();
        expect(row?.isPinned).toBe(1);
    });

    it("returns false for non-existent session", async () => {
        const result = await pinRelaySession("nonexistent", TEST_USER_ID);
        expect(result).toBe(false);
    });

    it("returns false when user doesn't own the session", async () => {
        await insertSession({ sessionId: "s2", userId: "other-user" });

        const result = await pinRelaySession("s2", TEST_USER_ID);
        expect(result).toBe(false);
    });

    it("is idempotent — pinning already-pinned session succeeds", async () => {
        await insertSession({ sessionId: "s3", isPinned: 1 });

        const result = await pinRelaySession("s3", TEST_USER_ID);
        expect(result).toBe(true);
    });

    it("succeeds on retry when session row appears after a delay", async () => {
        const delayedInsert = setTimeout(async () => {
            await insertSession({ sessionId: "s-delayed" });
        }, 300);

        const result = await pinRelaySession("s-delayed", TEST_USER_ID);
        clearTimeout(delayedInsert);
        expect(result).toBe(true);
    });
});

(isCI ? describe.skip : describe)("unpinRelaySession", () => {
    it("unpins a pinned session", async () => {
        await insertSession({ sessionId: "s4", isPinned: 1 });

        const result = await unpinRelaySession("s4", TEST_USER_ID);
        expect(result).toBe(true);

        const row = await getKysely()
            .selectFrom("relay_session")
            .select("isPinned")
            .where("id", "=", "s4")
            .executeTakeFirst();
        expect(row?.isPinned).toBe(0);
    });

    it("returns false for non-existent session", async () => {
        const result = await unpinRelaySession("nonexistent", TEST_USER_ID);
        expect(result).toBe(false);
    });

    it("returns false when user doesn't own the session", async () => {
        await insertSession({ sessionId: "s5", userId: "other-user", isPinned: 1 });

        const result = await unpinRelaySession("s5", TEST_USER_ID);
        expect(result).toBe(false);
    });
});

(isCI ? describe.skip : describe)("listPersistedRelaySessionsForUser", () => {
    it("includes isPinned field in results", async () => {
        await insertSession({ sessionId: "s6", isPinned: 1, isEphemeral: false });
        await insertSession({ sessionId: "s7", isPinned: 0, isEphemeral: false });

        const { sessions } = await listPersistedRelaySessionsForUser(TEST_USER_ID);
        const pinned = sessions.find((s: any) => s.sessionId === "s6");
        const unpinned = sessions.find((s: any) => s.sessionId === "s7");

        expect(pinned?.isPinned).toBe(true);
        expect(unpinned?.isPinned).toBe(false);
    });

    it("pinned sessions appear before unpinned sessions", async () => {
        await insertSession({ sessionId: "s-old-pinned", isPinned: 1, isEphemeral: false });
        await insertSession({ sessionId: "s-new-unpinned", isPinned: 0, isEphemeral: false });

        const { sessions } = await listPersistedRelaySessionsForUser(TEST_USER_ID);
        expect(sessions.length).toBe(2);
        expect(sessions[0].sessionId).toBe("s-old-pinned");
    });

    it("includes pinned sessions even if expired", async () => {
        const pastDate = new Date(Date.now() - 60 * 60 * 1000).toISOString();

        await insertSession({ sessionId: "s-expired-pinned", isPinned: 1, expiresAt: pastDate });
        await insertSession({ sessionId: "s-expired-unpinned", isPinned: 0, expiresAt: pastDate });

        const { sessions } = await listPersistedRelaySessionsForUser(TEST_USER_ID);
        const ids = sessions.map((s: any) => s.sessionId);

        expect(ids).toContain("s-expired-pinned");
        expect(ids).not.toContain("s-expired-unpinned");
    });

    it("includes runner info", async () => {
        await recordRelaySessionStart({
            sessionId: "s-ra-4",
            userId: TEST_USER,
            cwd: "/project",
            shareUrl: "http://test/s-ra-4",
            startedAt: currentIso(),
            isEphemeral: false,
            runnerId: "runner-list",
            runnerName: "List Runner",
        });

        const { sessions } = await listPersistedRelaySessionsForUser(TEST_USER);
        const found = sessions.find((s: any) => s.sessionId === "s-ra-4");

        expect(found).toBeDefined();
        expect(found!.runnerId).toBe("runner-list");
        expect(found!.runnerName).toBe("List Runner");
    });
});

(isCI ? describe.skip : describe)("listPinnedRelaySessionsForUser", () => {
    it("returns only pinned sessions", async () => {
        await insertSession({ sessionId: "s-only-pinned", isPinned: 1, isEphemeral: false });
        await insertSession({ sessionId: "s-only-unpinned", isPinned: 0, isEphemeral: false });

        const sessions = await listPinnedRelaySessionsForUser(TEST_USER_ID);
        const ids = sessions.map((s) => s.sessionId);

        expect(ids).toContain("s-only-pinned");
        expect(ids).not.toContain("s-only-unpinned");
    });

    it("returns pinned sessions even when total session count exceeds the general cap", async () => {
        for (let i = 0; i < 55; i++) {
            await insertSession({ sessionId: `s-cap-unpinned-${i}`, isPinned: 0, isEphemeral: false });
        }
        await insertSession({ sessionId: "s-cap-pinned", isPinned: 1, isEphemeral: false });

        const sessions = await listPinnedRelaySessionsForUser(TEST_USER_ID);
        const ids = sessions.map((s) => s.sessionId);

        expect(ids).toContain("s-cap-pinned");
        expect(sessions.every((s) => s.isPinned)).toBe(true);
    });

    it("includes runner info", async () => {
        await recordRelaySessionStart({
            sessionId: "s-ra-5",
            userId: TEST_USER,
            cwd: "/project",
            shareUrl: "http://test/s-ra-5",
            startedAt: currentIso(),
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

    it("runner info survives after session ends", async () => {
        await recordRelaySessionStart({
            sessionId: "s-ra-6",
            userId: TEST_USER,
            cwd: "/project",
            shareUrl: "http://test/s-ra-6",
            startedAt: currentIso(),
            isEphemeral: false,
            runnerId: "runner-restart",
            runnerName: "Restarting Runner",
        });

        await pinRelaySession("s-ra-6", TEST_USER);

        await getKysely()
            .updateTable("relay_session")
            .set({ endedAt: currentIso() })
            .where("id", "=", "s-ra-6")
            .execute();

        const pinned = await listPinnedRelaySessionsForUser(TEST_USER);
        const found = pinned.find((s) => s.sessionId === "s-ra-6");

        expect(found).toBeDefined();
        expect(found!.runnerId).toBe("runner-restart");
        expect(found!.runnerName).toBe("Restarting Runner");
        expect(found!.endedAt).not.toBeNull();
    });
});

describe("getPersistedRelaySessionSnapshot", () => {
    it("returns pinned session even if expired", async () => {
        const pastDate = new Date(Date.now() - 60 * 60 * 1000).toISOString();
        await insertSession({ sessionId: "s-snap-pinned", isPinned: 1, expiresAt: pastDate });

        const snap = await getPersistedRelaySessionSnapshot("s-snap-pinned", TEST_USER_ID);
        expect(snap).not.toBeNull();
        expect(snap?.sessionId).toBe("s-snap-pinned");
    });

    it("returns null for expired unpinned session", async () => {
        const pastDate = new Date(Date.now() - 60 * 60 * 1000).toISOString();
        await insertSession({ sessionId: "s-snap-unpinned", isPinned: 0, expiresAt: pastDate });

        const snap = await getPersistedRelaySessionSnapshot("s-snap-unpinned", TEST_USER_ID);
        expect(snap).toBeNull();
    });

    it("returns null when requesting another user's session", async () => {
        await insertSession({ sessionId: "s-snap-foreign", userId: "other-user", isPinned: 1, isEphemeral: false });

        const snap = await getPersistedRelaySessionSnapshot("s-snap-foreign", TEST_USER_ID);
        expect(snap).toBeNull();
    });
});

describe("pruneExpiredRelaySessions", () => {
    it("does not prune pinned sessions even when expired", async () => {
        const pastDate = new Date(Date.now() - 60 * 60 * 1000).toISOString();

        await insertSession({ sessionId: "s-prune-pinned", isPinned: 1, expiresAt: pastDate });
        await insertSession({ sessionId: "s-prune-unpinned", isPinned: 0, expiresAt: pastDate });

        const pruned = await pruneExpiredRelaySessions();

        expect(pruned).toContain("s-prune-unpinned");
        expect(pruned).not.toContain("s-prune-pinned");

        const remaining = await getKysely()
            .selectFrom("relay_session")
            .select("id")
            .where("id", "=", "s-prune-pinned")
            .executeTakeFirst();
        expect(remaining).toBeTruthy();
    });

    it("prunes expired unpinned sessions normally", async () => {
        const pastDate = new Date(Date.now() - 60 * 60 * 1000).toISOString();

        await insertSession({ sessionId: "s-prune1", isPinned: 0, expiresAt: pastDate });
        await insertSession({ sessionId: "s-prune2", isPinned: 0, expiresAt: pastDate });

        const pruned = await pruneExpiredRelaySessions();
        expect(pruned).toContain("s-prune1");
        expect(pruned).toContain("s-prune2");
    });

    it("does not prune sessions without an expiry", async () => {
        await insertSession({ sessionId: "s-no-expiry", isPinned: 0, expiresAt: null, isEphemeral: false });

        const pruned = await pruneExpiredRelaySessions();
        expect(pruned).not.toContain("s-no-expiry");
    });
});

describe("runner association persistence", () => {
    it("recordRelaySessionStart stores runnerId and runnerName", async () => {
        await recordRelaySessionStart({
            sessionId: "s-ra-1",
            userId: TEST_USER,
            cwd: "/project",
            shareUrl: "http://test/s-ra-1",
            startedAt: currentIso(),
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
            startedAt: currentIso(),
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
        await recordRelaySessionStart({
            sessionId: "s-ra-3",
            userId: TEST_USER,
            cwd: "/project",
            shareUrl: "http://test/s-ra-3",
            startedAt: currentIso(),
            isEphemeral: false,
        });

        await updateRelaySessionRunner("s-ra-3", "runner-xyz", "Late Runner");

        const row = await getKysely()
            .selectFrom("relay_session")
            .select(["runnerId", "runnerName"])
            .where("id", "=", "s-ra-3")
            .executeTakeFirst();

        expect(row?.runnerId).toBe("runner-xyz");
        expect(row?.runnerName).toBe("Late Runner");
    });

    it("updateRelaySessionRunner returns false for nonexistent session", async () => {
        const result = await updateRelaySessionRunner("nonexistent-session", "runner-x", "Runner X");
        expect(result).toBe(false);
    });

    it("updateRelaySessionRunner retries and succeeds when row appears after delay", async () => {
        const insertPromise = (async () => {
            await new Promise<void>((r) => setTimeout(r, 50));
            await recordRelaySessionStart({
                sessionId: "s-ra-race",
                userId: TEST_USER,
                cwd: "/project",
                shareUrl: "http://test/s-ra-race",
                startedAt: currentIso(),
                isEphemeral: false,
            });
        })();

        const result = await updateRelaySessionRunner("s-ra-race", "runner-late", "Late Linker");
        await insertPromise;

        expect(result).toBe(true);

        const row = await getKysely()
            .selectFrom("relay_session")
            .select(["runnerId", "runnerName"])
            .where("id", "=", "s-ra-race")
            .executeTakeFirst();

        expect(row?.runnerId).toBe("runner-late");
        expect(row?.runnerName).toBe("Late Linker");
    });

    it("recordRelaySessionStart updates runner info on reconnect", async () => {
        await recordRelaySessionStart({
            sessionId: "s-ra-reconn",
            userId: TEST_USER,
            cwd: "/project",
            shareUrl: "http://test/s-ra-reconn",
            startedAt: currentIso(),
            isEphemeral: false,
        });

        const before = await getKysely()
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
            startedAt: currentIso(),
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
        await recordRelaySessionStart({
            sessionId: "s-ra-null-guard",
            userId: TEST_USER,
            cwd: "/project",
            shareUrl: "http://test/s-ra-null-guard",
            startedAt: currentIso(),
            isEphemeral: false,
            runnerId: "runner-original",
            runnerName: "Original Runner",
        });

        await recordRelaySessionStart({
            sessionId: "s-ra-null-guard",
            userId: TEST_USER,
            cwd: "/project",
            shareUrl: "http://test/s-ra-null-guard",
            startedAt: currentIso(),
            isEphemeral: false,
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
            startedAt: currentIso(),
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
