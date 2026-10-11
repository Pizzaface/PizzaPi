import { describe, it, expect, beforeAll, beforeEach, afterAll } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createTestAuthContext, getKysely, runWithAuthContext } from "../auth.js";
import {
    ensureRelaySessionTables,
    listPersistedRelaySessionsForUser,
    pruneExpiredRelaySessions,
    getPersistedRelaySessionSnapshot,
    recordRelaySessionStart,
    recordRelaySessionEnd,
    updateRelaySessionRunner,
    getRelaySessionUserId,
} from "./store.js";

const tmpDir = mkdtempSync(join(tmpdir(), "pizzapi-store-db-isolation-"));
const dbPath = join(tmpDir, "test.db");
const authContext = createTestAuthContext({ dbPath });
const withAuth = <T>(fn: () => T): T => runWithAuthContext(authContext, fn);
const authIt = (name: string, fn: () => Promise<void> | void) => it(name, () => withAuth(fn));
const TEST_USER_ID = "test-user";
const TEST_USER = "test-user-runner-assoc";

function currentIso(): string {
    return new Date().toISOString();
}

async function insertSession(opts: {
    sessionId: string;
    userId?: string;
    isEphemeral?: boolean;
    expiresAt?: string | null;
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
            runnerId: null,
            runnerName: null,
            sessionName: null,
        })
        .execute();
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

describe("listPersistedRelaySessionsForUser", () => {
    authIt("includes runner info", async () => {
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

describe("getPersistedRelaySessionSnapshot", () => {
    authIt("returns null for expired session", async () => {
        const pastDate = new Date(Date.now() - 60 * 60 * 1000).toISOString();
        await insertSession({ sessionId: "s-snap-expired", expiresAt: pastDate });

        const snap = await getPersistedRelaySessionSnapshot("s-snap-expired", TEST_USER_ID);
        expect(snap).toBeNull();
    });

    authIt("returns null when requesting another user's session", async () => {
        await insertSession({ sessionId: "s-snap-foreign", userId: "other-user", isEphemeral: false });

        const snap = await getPersistedRelaySessionSnapshot("s-snap-foreign", TEST_USER_ID);
        expect(snap).toBeNull();
    });
});

describe("pruneExpiredRelaySessions", () => {
    authIt("prunes all expired sessions", async () => {
        const pastDate = new Date(Date.now() - 60 * 60 * 1000).toISOString();

        await insertSession({ sessionId: "s-prune-1", expiresAt: pastDate });
        await insertSession({ sessionId: "s-prune-2", expiresAt: pastDate });

        const pruned = await pruneExpiredRelaySessions();

        expect(pruned).toContain("s-prune-1");
        expect(pruned).toContain("s-prune-2");
    });

    authIt("prunes expired sessions", async () => {
        const pastDate = new Date(Date.now() - 60 * 60 * 1000).toISOString();

        await insertSession({ sessionId: "s-prune1", expiresAt: pastDate });
        await insertSession({ sessionId: "s-prune2", expiresAt: pastDate });

        const pruned = await pruneExpiredRelaySessions();
        expect(pruned).toContain("s-prune1");
        expect(pruned).toContain("s-prune2");
    });

    authIt("does not prune sessions without an expiry", async () => {
        await insertSession({ sessionId: "s-no-expiry", expiresAt: null, isEphemeral: false });

        const pruned = await pruneExpiredRelaySessions();
        expect(pruned).not.toContain("s-no-expiry");
    });
});

describe("runner association persistence", () => {
    authIt("recordRelaySessionStart stores runnerId and runnerName", async () => {
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

    authIt("recordRelaySessionStart stores null when no runner info provided", async () => {
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

    authIt("updateRelaySessionRunner updates runner info after creation", async () => {
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

    authIt("updateRelaySessionRunner returns false for nonexistent session", async () => {
        const result = await updateRelaySessionRunner("nonexistent-session", "runner-x", "Runner X");
        expect(result).toBe(false);
    });

    authIt("updateRelaySessionRunner retries and succeeds when row appears after delay", async () => {
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

    authIt("recordRelaySessionStart updates runner info on reconnect", async () => {
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

    authIt("recordRelaySessionStart does NOT null out runner info on reconnect without runner data", async () => {
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

    authIt("getRelaySessionUserId returns userId for existing session", async () => {
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

    authIt("getRelaySessionUserId returns null for nonexistent session", async () => {
        const uid = await getRelaySessionUserId("nonexistent-uid-session");
        expect(uid).toBeNull();
    });
});

describe("recordRelaySessionEnd — lifecycle generation guard", () => {
    authIt("ignores a stale end from a prior generation after reconnect", async () => {
        // Start (generation 1).
        await recordRelaySessionStart({
            sessionId: "s-gen-race",
            userId: TEST_USER,
            cwd: "/project",
            shareUrl: "http://test/s-gen-race",
            startedAt: currentIso(),
            isEphemeral: false,
            generation: "gen-1",
        });

        // Reconnect (generation 2) — the session is live again.
        await recordRelaySessionStart({
            sessionId: "s-gen-race",
            userId: TEST_USER,
            cwd: "/project",
            shareUrl: "http://test/s-gen-race",
            startedAt: currentIso(),
            isEphemeral: false,
            generation: "gen-2",
        });

        // A delayed session-end from the PRIOR socket (generation 1) must NOT
        // mark the reconnected (generation 2) session as ended.
        await recordRelaySessionEnd("s-gen-race", "gen-1");

        const stillLive = await getKysely()
            .selectFrom("relay_session")
            .select(["endedAt", "generation"])
            .where("id", "=", "s-gen-race")
            .executeTakeFirst();
        expect(stillLive?.generation).toBe("gen-2");
        expect(stillLive?.endedAt).toBeNull();
    });

    authIt("applies a matching-generation end", async () => {
        await recordRelaySessionStart({
            sessionId: "s-gen-match",
            userId: TEST_USER,
            cwd: "/project",
            shareUrl: "http://test/s-gen-match",
            startedAt: currentIso(),
            isEphemeral: false,
            generation: "gen-1",
        });

        await recordRelaySessionEnd("s-gen-match", "gen-1");

        const row = await getKysely()
            .selectFrom("relay_session")
            .select("endedAt")
            .where("id", "=", "s-gen-match")
            .executeTakeFirst();
        expect(row?.endedAt).not.toBeNull();
    });

    authIt("applies a generation end when the row's generation is still NULL (start not yet landed)", async () => {
        // Simulate the fire-and-forget start upsert not having landed yet:
        // a row exists but generation is NULL.
        const oldLastActive = new Date(Date.now() - 1000).toISOString();
        await insertSession({ sessionId: "s-gen-null-start", userId: TEST_USER, isEphemeral: false });
        await getKysely()
            .updateTable("relay_session")
            .set({ lastActiveAt: oldLastActive })
            .where("id", "=", "s-gen-null-start")
            .execute();

        await recordRelaySessionEnd("s-gen-null-start", "gen-N");

        const row = await getKysely()
            .selectFrom("relay_session")
            .select("endedAt")
            .where("id", "=", "s-gen-null-start")
            .executeTakeFirst();
        expect(row?.endedAt).not.toBeNull();
    });

    authIt("falls back to the time guard when no generation is provided (legacy)", async () => {
        await recordRelaySessionStart({
            sessionId: "s-gen-legacy",
            userId: TEST_USER,
            cwd: "/project",
            shareUrl: "http://test/s-gen-legacy",
            startedAt: currentIso(),
            isEphemeral: false,
        });

        // No generation passed → legacy time-guard path still ends the session.
        await recordRelaySessionEnd("s-gen-legacy");

        const row = await getKysely()
            .selectFrom("relay_session")
            .select("endedAt")
            .where("id", "=", "s-gen-legacy")
            .executeTakeFirst();
        expect(row?.endedAt).not.toBeNull();
    });
});
